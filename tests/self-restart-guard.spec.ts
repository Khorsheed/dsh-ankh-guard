/**
 * Coverage for the self-restart guard: the pure state core (freshness,
 * HEAD binding, clear, checkpoint), the mounted cordis service over a real
 * git repository (record → verify → mutate → verify-denied → checkpoint →
 * reset), the Loader real-load path, the CLI end to end, and the invariant's
 * malformed-state check. Deterministic time is injected everywhere the core
 * reads the clock; git calls run against throwaway repositories.
 */
import { execFileSync, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as selfRestartGuard from '../src/index.ts'
import { currentHead } from '../src/git.ts'
import {
  findOwnedListener, findPidOnPort, processIdentity,
  processIdentityMatches, signalProcessIdentity,
} from '../src/processes.ts'
import { install as installInvariant } from '../src/invariant.ts'
import {
  acknowledgeRestartRecord, buildLaunchCommand, continueAndReportText, isParkedOnUserInput, pendingRestartRecord,
  readInstanceLaunch, readInterruptedSnapshot, restartContextText, writeInstanceLaunch,
  writeInstanceLaunchAsSupervisor, writeInterruptedSnapshot, writeSkillRegistration,
} from '../src/restart-context.ts'
import { performExit } from '../src/exit-agent.ts'
import {
  cutoverBlocksWake, prepareLaunchCutover, readCutoverControl, readCutoverReceipt, readLaunchState,
  recordCutoverEvent, selectedLaunchSpec, summarizeLaunchState, writeStableLaunchSpec,
  type LaunchSpec,
} from '../src/launch-spec.ts'
import { envInternals, preflightInternals, resolveHarnessRoot, resolvePreflightBin, resolveRunnerCommand, resolveWdHome, runCli, type CliIo } from '../src/cli.ts'
import {
  clearCredential, emptyState, loadState, recordCredential, setCheckpoint,
  verifyCredential, type GuardState,
} from '../src/state.ts'
import { lastGoodBootRevision, STATE_FILES } from '../src/state-files.ts'
import {
  appendTestLifecycleEventForProcess,
  TEST_PROCESS_PORT_ENV, TEST_PROCESS_ROLE_ENV, TEST_PROCESS_TEMP_ROOT_ENV,
} from '../src/test-seam.ts'
import { TestProcessLifecycle } from './helpers/process-lifecycle.ts'

const cleanups: Array<() => void> = []
const gracefulStops: Array<() => void> = []
let lifecycle: TestProcessLifecycle
const testRegisterBin = fileURLToPath(new URL('../lib/test-seam-cli.js', import.meta.url))
const testSeamModule = fileURLToPath(new URL('../lib/test-seam.js', import.meta.url))

function stableShard(title: string, count: number): number {
  const balancedLongCases: Record<string, number> = {
    'reconfigure restores the complete previous spec after target readiness failures': 0,
    'rejects a target that exits after authenticated 200 without handing its URL to the browser, then restores previous': 2,
  }
  const balanced = balancedLongCases[title]
  if (balanced !== undefined && balanced < count) return balanced
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(title)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % count
}

const superviseIt = ((title: string, ...args: unknown[]) => {
  const count = Number(process.env.ANKH_GUARD_TEST_SHARD_COUNT ?? '1')
  const index = Number(process.env.ANKH_GUARD_TEST_SHARD_INDEX ?? '0')
  const selected = Number.isInteger(count) && count > 0 && Number.isInteger(index) && index >= 0 && index < count
    && stableShard(title, count) === index
  return Reflect.apply(selected ? it : it.skip, undefined, [title, ...args])
}) as typeof it

beforeEach(() => {
  lifecycle = new TestProcessLifecycle(testRegisterBin)
})

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') lifecycle.retainEvidence()
  for (const stop of gracefulStops.splice(0)) stop()
  let lifecycleError: unknown
  try {
    await lifecycle.teardown()
  } catch (error) {
    lifecycleError = error
  }
  for (const cleanup of cleanups.splice(0)) cleanup()
  if (lifecycleError !== undefined) throw lifecycleError
})

/** Every child spawned by this file is immediately identity-registered. */
function spawn(command: string, args: readonly string[], options: SpawnOptions = {}): ReturnType<typeof nodeSpawn> {
  const role = options.env?.[TEST_PROCESS_ROLE_ENV]
    ?? `fixture-${command.split('/').pop() ?? 'process'}-${args[0]?.split('/').pop() ?? 'child'}`
  const portText = options.env?.[TEST_PROCESS_PORT_ENV]
  const port = portText === undefined ? undefined : Number(portText)
  const tempRoot = options.env?.[TEST_PROCESS_TEMP_ROOT_ENV]
  const child = nodeSpawn(command, [...args], {
    ...options,
    env: lifecycle.childEnv(role, options.env ?? process.env, {
      ...(Number.isInteger(port) && (port ?? 0) > 0 ? { port } : {}),
      ...(tempRoot === undefined || tempRoot === '' ? {} : { tempRoot }),
    }),
  })
  lifecycle.track(child, role, {
    ...(Number.isInteger(port) && (port ?? 0) > 0 ? { port } : {}),
    ...(tempRoot === undefined || tempRoot === '' ? {} : { tempRoot }),
  })
  return child
}

function spawnPortRuntime(command: string, args: readonly string[], port: number, options: SpawnOptions = {}): ReturnType<typeof nodeSpawn> {
  return spawn(command, args, {
    ...options,
    env: lifecycle.childEnv('fixture-port-runtime', options.env ?? process.env, { port }),
  })
}

/** Freeze one captured identity for a fixture without ever leaving a reused PID stopped. */
function freezeFixtureIdentity(identity: NonNullable<ReturnType<typeof processIdentity>>): 'frozen' | 'gone' | 'mismatch' {
  try {
    process.kill(identity.pid, 'SIGSTOP')
  } catch {
    return 'gone'
  }
  if (processIdentityMatches(identity)) return 'frozen'
  try { process.kill(identity.pid, 'SIGCONT') } catch { /* already gone */ }
  return 'mismatch'
}

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function run(repoDir: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd: repoDir, stdio: 'pipe' })
}

/** A throwaway git repository with one commit. */
function makeRepo(): string {
  const dir = tmpDir('guard-repo-')
  run(dir, ['init', '-q'])
  run(dir, ['config', 'user.email', 'guard@test'])
  run(dir, ['config', 'user.name', 'guard test'])
  writeFileSync(join(dir, 'a.txt'), '1')
  run(dir, ['add', '-A'])
  run(dir, ['commit', '-qm', 'init'])
  return dir
}

function commitChange(repoDir: string): void {
  writeFileSync(join(repoDir, 'a.txt'), '2')
  run(repoDir, ['add', '-A'])
  run(repoDir, ['commit', '-qm', 'change'])
}

const NOW = 1_000_000

function fakeOwnership(childPid: number, listenerPid = childPid) {
  return {
    childPid, childStartToken: `child-start-${childPid}`,
    listenerPid, listenerStartToken: `listener-start-${listenerPid}`,
  }
}

/**
 * A currently-free loopback port: bind 0, read the assignment, close. The
 * rebind race after close is far smaller than the alternative — a random
 * high port can belong to a real service, and a guard test suite that flakes
 * red teaches its owners to ignore it.
 */
async function freePort(): Promise<number> {
  return await lifecycle.acquirePort()
}

/**
 * Env for a directly spawned watchdog script: the test's explicit WD_* over a
 * process.env SCRUBBED of ambient supervision variables. A shell inside a
 * supervised dsh instance inherits the watchdog's own WD_* (the instance is
 * spawned with them), and the script honors a leaked WD_STATE_DIR over the
 * test's WD_HOME — sending the test watchdog into the PROD state dir, where
 * the live watchdog holds the pidfile: every racer yields on sight (zero
 * survivors in ~3s) and no temp pidfile ever appears (reclaim times out at
 * its initial-claim deadline). Reproduced 2026-08-29 by running the two cases
 * with WD_STATE_DIR pointed at a live-occupied dir.
 */
function watchdogEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WD_'))),
    WD_READY_STABILITY_SECONDS: '1',
    ...(overrides.WD_PORT === undefined ? {} : { [TEST_PROCESS_PORT_ENV]: overrides.WD_PORT }),
    ...overrides,
  }
}

describe('process ownership discovery', () => {
  it('uses the absolute lsof fallback when PATH omits /usr/sbin and traces the listener to the supervisor child root', async () => {
    const port = await freePort()
    const serverProgram = `require('http').createServer((q,s)=>s.end('owned')).listen(${port},'127.0.0.1')`
    const wrapperProgram = `const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(serverProgram)}],{stdio:'ignore'});setInterval(()=>{},1000)`
    const supervisorProgram = `const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(wrapperProgram)}],{stdio:'ignore'});setInterval(()=>{},1000)`
    const supervisor = spawn(process.execPath, ['-e', supervisorProgram], { stdio: 'ignore' })
    await waitForPort(port)
    const previousPath = process.env.PATH
    process.env.PATH = '/usr/bin:/bin'
    try {
      expect(findPidOnPort(port)).not.toBeNull()
      const owned = findOwnedListener(port, supervisor.pid!)
      expect(owned).not.toBeNull()
      expect(owned?.child.pid).not.toBe(supervisor.pid)
      expect(owned?.child.pid).not.toBe(owned?.listener.pid)
      expect(owned?.listener.pid).toBe(Number(findPidOnPort(port)))
      expect(processIdentityMatches(owned!.child)).toBe(true)
      expect(processIdentityMatches(owned!.listener)).toBe(true)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      lifecycle.signal(supervisor, 'SIGKILL')
      await killListener(port)
    }
  }, 15_000)

  it('freezes and revalidates before signalling an identity mismatch', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    await new Promise(resolve => setTimeout(resolve, 100))
    const identity = processIdentity(child.pid!)
    expect(identity).not.toBeNull()
    expect(signalProcessIdentity({ ...identity!, startToken: `${identity!.startToken}-recycled` }, 'SIGTERM')).toBe('mismatch')
    expect(processIdentityMatches(identity!)).toBe(true)
    expect(signalProcessIdentity(identity!, 'SIGTERM')).toBe('signalled')
  })
})

describe('state core', () => {
  it('records a credential and verifies it while fresh on the same revision', () => {
    const dir = tmpDir('guard-state-')
    recordCredential(dir, { scope: 'build', revision: 'abc123', command: 'pnpm run build' }, NOW)
    const state = loadState(dir)
    expect(state.credential?.scope).toBe('build')
    expect(verifyCredential(state, 'abc123', NOW, 10)).toEqual({
      ok: true,
      reason: expect.stringContaining('build @ abc123') as string,
    })
  })

  it('denies when no credential is recorded', () => {
    const result = verifyCredential(emptyState(), 'abc123', NOW, 10)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no green-build credential')
  })

  it('denies when the credential is bound to a different revision', () => {
    const dir = tmpDir('guard-state-')
    recordCredential(dir, { scope: 'build', revision: 'abc123', command: '' }, NOW)
    const state = loadState(dir)
    const result = verifyCredential(state, 'def456', NOW, 10)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('bound to revision abc123')
    expect(result.reason).toContain('def456')
  })

  it('denies when the credential is stale beyond the freshness window', () => {
    const dir = tmpDir('guard-state-')
    recordCredential(dir, { scope: 'build', revision: 'abc123', command: '' }, NOW)
    const state = loadState(dir)
    const result = verifyCredential(state, 'abc123', NOW + 11 * 60_000, 10)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('stale')
  })

  it('clear drops only the credential and keeps the checkpoint', () => {
    const dir = tmpDir('guard-state-')
    recordCredential(dir, { scope: 'build', revision: 'abc123', command: '' }, NOW)
    setCheckpoint(dir, { revision: 'cp1', message: 'batch' }, NOW)
    const cleared = clearCredential(dir, NOW)
    expect(cleared.credential).toBeUndefined()
    expect(cleared.checkpoint?.revision).toBe('cp1')
  })

  it('registers the restart-protocol skill when the skills service is present', async () => {
    // The pull-based discovery channel: agents find the protocol through the
    // skill catalog when a task involves restarting the instance — no
    // per-session push notice.
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [], list: () => [] } as never)
    const registrations: Array<{ name: string; description: string; content: string; source?: string }> = []
    let disposed = false
    ctx.provide('skills', {
      register: (skill: { name: string; description: string; content: string }) => {
        registrations.push(skill)
        return () => { disposed = true }
      },
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    expect(registrations.map(skill => skill.name)).toEqual(['dsh-self-restart-guard'])
    expect(registrations[0]?.description).toContain('restart')
    expect(registrations[0]?.content).toContain('check-env')
    expect(registrations[0]?.content).toContain('timeoutMs: 180000')
    expect(registrations[0]?.content).toContain('Caller timeout is not a guard verdict')
    // The shipped skill must not carry machine-specific paths from the
    // development environment it was written on.
    expect(registrations[0]?.content).not.toContain('code/dsh-plugins')
    // The registry validates `source` at LOAD time — a registration without
    // it lists fine in the catalog but explodes on invocation ("loaded skill
    // ... source must be a string", published 8.9). Pin it here.
    expect(registrations[0]?.source).toBe('runtime')
    // The registration outcome is on disk for check-env to surface.
    const marker = JSON.parse(readFileSync(join(stateDir, 'skill-registration.json'), 'utf8'))
    expect(marker.registered).toBe(true)
    await fiber.dispose()
    expect(disposed).toBe(true)
  })

  it('the registered skill survives the real registry round-trip (catalog list + body load)', async () => {
    // The catalog lists registrations even when a required field is missing;
    // the registry validates at LOAD time — published 8.9 failed exactly here
    // ("loaded skill ... source must be a string"). Exercise the real
    // registry so a payload contract drift cannot pass on a recording stub.
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [], list: () => [] } as never)
    const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
    const registry = new SkillRegistry(ctx as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    const names = (await registry.list({ cwd: repo })).map((skill: { name: string }) => skill.name)
    expect(names).toContain('dsh-self-restart-guard')
    const loaded = await registry.get('dsh-self-restart-guard', { cwd: repo })
    expect(loaded?.content).toContain('check-env')
    await fiber.dispose()
  })

  it('records the failure loudly when the skills service is absent (host migrations must not lose the skill silently)', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [], list: () => [] } as never)
    // No skills service provided — the composition lacks the capability.
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    const marker = JSON.parse(readFileSync(join(stateDir, 'skill-registration.json'), 'utf8'))
    expect(marker.registered).toBe(false)
    expect(marker.reason).toContain('skills service absent')
    await fiber.dispose()
  })

  it('fails loud on a malformed state file', () => {
    const dir = tmpDir('guard-state-')
    writeFileSync(join(dir, 'self-restart-guard.json'), '{ nope')
    expect(() => loadState(dir)).toThrow(/unreadable state file/)
  })

  it('lastGoodBootRevision reads the healthy-boot stamp, tolerating absence and malformed files', () => {
    const dir = tmpDir('guard-state-')
    expect(lastGoodBootRevision(dir)).toBeUndefined()
    writeFileSync(join(dir, 'last-good-boot.json'), '{ nope')
    expect(lastGoodBootRevision(dir)).toBeUndefined()
    writeFileSync(join(dir, 'last-good-boot.json'), JSON.stringify({ revision: 'abc123', at: NOW }))
    expect(lastGoodBootRevision(dir)).toBe('abc123')
  })
})

describe('durable launch cutover state', () => {
  const spec = (command: string, root: string): LaunchSpec => ({
    version: 1,
    command,
    port: 3080,
    home: join(root, 'home'),
    credentialRepo: join(root, 'credential-repo'),
    harnessRoot: join(root, 'harness-root'),
    profile: 'web',
  })

  it('atomically selects target, records a credential-free receipt, then compacts to stable target', () => {
    const stateDir = tmpDir('guard-cutover-')
    const previous = spec('node previous-host.js --opaque previous-value', stateDir)
    const target = spec('node target-host.js --opaque target-value', stateDir)
    writeStableLaunchSpec(stateDir, previous)

    prepareLaunchCutover(stateDir, {
      id: 'cutover-1', previous, target,
      recoveryPolicy: 'restore-previous', browserHandoff: 'required',
      previousSupervisorPid: 101, previousSupervisorStartToken: 'supervisor-start-101', previousOwnership: fakeOwnership(102, 103),
      initiator: 'session-owner', now: NOW,
    })
    const active = readLaunchState(stateDir)
    expect(active?.mode).toBe('cutover')
    expect(active === null ? null : selectedLaunchSpec(active)).toEqual(target)
    expect(cutoverBlocksWake(stateDir)).toBe(true)

    recordCutoverEvent(stateDir, 'cutover-1', 'driver-started', ['201', 'driver-start-201'], NOW + 1)
    recordCutoverEvent(stateDir, 'cutover-1', 'supervisor-ready', ['202', 'supervisor-start-202'], NOW + 2)
    recordCutoverEvent(stateDir, 'cutover-1', 'child-started', ['target', '1', '203', 'target-start-203'], NOW + 3)
    recordCutoverEvent(stateDir, 'cutover-1', 'transport', ['401'], NOW + 4)
    recordCutoverEvent(stateDir, 'cutover-1', 'launch-url', [], NOW + 5)
    recordCutoverEvent(stateDir, 'cutover-1', 'auth-exchange', ['303'], NOW + 6)
    recordCutoverEvent(stateDir, 'cutover-1', 'authenticated', ['200'], NOW + 7)
    recordCutoverEvent(stateDir, 'cutover-1', 'ownership-stable', ['target', '203', 'target-start-203', '204', 'listener-start-204', '3000', '0'], NOW + 8)
    recordCutoverEvent(stateDir, 'cutover-1', 'canary', ['pass'], NOW + 9)
    recordCutoverEvent(stateDir, 'cutover-1', 'browser-handoff', ['acknowledged', 'original-tab', 'launch-url', '127.0.0.1:3080'], NOW + 10)
    writeFileSync(join(stateDir, STATE_FILES.lastRestart), JSON.stringify({ exitAt: 1, unexpected: true, reportedAt: 2 }))
    recordCutoverEvent(stateDir, 'cutover-1', 'ready', ['target'], NOW + 11)

    const stable = readLaunchState(stateDir)
    expect(stable).toEqual({ version: 1, mode: 'stable', active: target })
    expect(cutoverBlocksWake(stateDir)).toBe(false)
    const receipt = readCutoverReceipt(stateDir)
    expect(receipt).toMatchObject({
      phase: 'ready',
      supervisor: {
        previousPid: 101,
        previousStartToken: 'supervisor-start-101',
        targetDriverPid: 201,
        targetDriverStartToken: 'driver-start-201',
        targetPid: 202,
        targetStartToken: 'supervisor-start-202',
      },
      child: { previousPid: 102, targetPid: 203 },
      ownership: {
        previous: fakeOwnership(102, 103),
        target: { childPid: 203, childStartToken: 'target-start-203', listenerPid: 204, listenerStartToken: 'listener-start-204' },
      },
      readiness: { role: 'target', childPid: 203, listenerPid: 204, stableWindowMs: 3000, retryCount: 0 },
      authentication: {
        transportStatus: 401, launchUrlObserved: true, exchangeStatus: 303,
        authenticatedStatus: 200, browserHandoff: 'acknowledged',
      },
      browserHandoff: {
        required: true, status: 'acknowledged', channel: 'original-tab',
        authentication: 'launch-url', authority: '127.0.0.1:3080', acknowledgedAt: NOW + 10,
      },
      canary: { outcome: 'pass' },
      recovery: { policy: 'restore-previous', result: 'not-needed' },
    })
    const durableReceipt = readFileSync(join(stateDir, STATE_FILES.launchCutover), 'utf8')
    expect(durableReceipt).not.toContain(previous.command)
    expect(durableReceipt).not.toContain(target.command)
    expect(statSync(join(stateDir, STATE_FILES.launchSpec)).mode & 0o777).toBe(0o600)
    const restartRecord = JSON.parse(readFileSync(join(stateDir, STATE_FILES.lastRestart), 'utf8'))
    expect(restartRecord.cutover).toEqual({ id: 'cutover-1', outcome: 'target-ready', receipt: join(stateDir, STATE_FILES.launchCutover) })
    expect(restartRecord).toMatchObject({ initiator: 'session-owner', pid: 102 })
    expect(restartRecord.reportedAt).toBeUndefined()
    expect(restartRecord.unexpected).toBeUndefined()
  })

  it('restores the complete previous launch specification as one selected unit', () => {
    const stateDir = tmpDir('guard-cutover-')
    const previous = spec('node previous-host.js', join(stateDir, 'previous-root'))
    const target = { ...spec('node target-host.js', join(stateDir, 'target-root')), profile: 'next-web' }
    prepareLaunchCutover(stateDir, {
      id: 'cutover-restore', previous, target,
      recoveryPolicy: 'restore-previous', browserHandoff: 'off',
      previousSupervisorPid: 301, previousSupervisorStartToken: 'supervisor-start-301', previousOwnership: fakeOwnership(300), now: NOW,
    })
    recordCutoverEvent(stateDir, 'cutover-restore', 'child-started', ['target', '1', '302', 'target-start-302'], NOW + 1)
    recordCutoverEvent(stateDir, 'cutover-restore', 'ownership-stable', ['target', '302', 'target-start-302', '305', 'listener-start-305', '3000', '0'], NOW + 2)
    recordCutoverEvent(stateDir, 'cutover-restore', 'canary', ['target', 'fail', 'target credential rejected'], NOW + 3)
    recordCutoverEvent(stateDir, 'cutover-restore', 'attempt-failed', ['target', '1', 'readiness failed'], NOW + 4)
    recordCutoverEvent(stateDir, 'cutover-restore', 'restoring', ['approved full-spec recovery'], NOW + 5)
    expect(readLaunchState(stateDir)).toMatchObject({ mode: 'cutover', selected: 'previous' })
    recordCutoverEvent(stateDir, 'cutover-restore', 'child-started', ['previous', '1', '303', 'previous-start-303'], NOW + 6)
    recordCutoverEvent(stateDir, 'cutover-restore', 'ownership-stable', ['previous', '303', 'previous-start-303', '304', 'listener-start-304', '3000', '0'], NOW + 7)
    recordCutoverEvent(stateDir, 'cutover-restore', 'canary', ['previous', 'skipped', 'target credential is unrelated'], NOW + 8)
    recordCutoverEvent(stateDir, 'cutover-restore', 'ready', ['previous'], NOW + 9)

    expect(readLaunchState(stateDir)).toEqual({ version: 1, mode: 'stable', active: previous })
    expect(readCutoverReceipt(stateDir)).toMatchObject({
      phase: 'restored', child: { restoredPid: 303 },
      recovery: {
        policy: 'restore-previous', result: 'restored',
        validation: { canary: { outcome: 'skipped' }, readiness: { role: 'previous' } },
      },
      targetValidation: { canary: { outcome: 'fail', detail: 'target credential rejected' } },
    })
    expect(readCutoverReceipt(stateDir)?.canary).toBeUndefined()
    expect(JSON.parse(readFileSync(join(stateDir, STATE_FILES.lastRestart), 'utf8')).cutover.outcome).toBe('restored')
  })

  it('refuses terminal ready until ownership is stable, browser handoff is complete, and canary passes', () => {
    const stateDir = tmpDir('guard-cutover-proof-')
    const previous = spec('node previous-host.js', stateDir)
    const target = spec('node target-host.js', stateDir)
    prepareLaunchCutover(stateDir, {
      id: 'cutover-proof', previous, target,
      recoveryPolicy: 'restore-previous', browserHandoff: 'required',
      previousSupervisorPid: 801, previousSupervisorStartToken: 'supervisor-start-801', previousOwnership: fakeOwnership(802, 803), now: NOW,
    })
    recordCutoverEvent(stateDir, 'cutover-proof', 'child-started', ['target', '1', '804', 'target-start-804'], NOW + 1)
    recordCutoverEvent(stateDir, 'cutover-proof', 'launch-url', [], NOW + 2)
    expect(() => recordCutoverEvent(stateDir, 'cutover-proof', 'ready', ['target'], NOW + 3)).toThrow(/ownership was not stable/)
    expect(() => recordCutoverEvent(
      stateDir, 'cutover-proof', 'ownership-stable',
      ['target', '804', 'target-start-804', '805', 'listener-start-805', '3000', '1'], NOW + 4,
    )).toThrow(/retry count must be zero/)
    recordCutoverEvent(
      stateDir, 'cutover-proof', 'ownership-stable',
      ['target', '804', 'target-start-804', '805', 'listener-start-805', '3000', '0'], NOW + 5,
    )
    expect(() => recordCutoverEvent(
      stateDir, 'cutover-proof', 'browser-handoff',
      ['acknowledged', 'original-tab', 'existing-cookie', '127.0.0.1:3080'], NOW + 6,
    )).toThrow(/canary has not passed/)
    expect(() => recordCutoverEvent(stateDir, 'cutover-proof', 'ready', ['target'], NOW + 6)).toThrow(/canary has not passed/)
    recordCutoverEvent(stateDir, 'cutover-proof', 'canary', ['pass'], NOW + 7)
    expect(() => recordCutoverEvent(stateDir, 'cutover-proof', 'ready', ['target'], NOW + 8)).toThrow(/no browser acknowledgement/)
    recordCutoverEvent(stateDir, 'cutover-proof', 'browser-handoff', ['acknowledged', 'original-tab', 'existing-cookie', '127.0.0.1:3080'], NOW + 9)
    expect(recordCutoverEvent(stateDir, 'cutover-proof', 'ready', ['target'], NOW + 10).phase).toBe('ready')
  })

  it('does not upgrade a legacy opener-success receipt into a page acknowledgement', () => {
    const stateDir = tmpDir('guard-cutover-legacy-browser-')
    const previous = spec('node previous-host.js', stateDir)
    const target = spec('node target-host.js', stateDir)
    prepareLaunchCutover(stateDir, {
      id: 'cutover-legacy-browser', previous, target,
      recoveryPolicy: 'restore-previous', browserHandoff: 'required',
      previousSupervisorPid: 901, previousSupervisorStartToken: 'supervisor-start-901',
      previousOwnership: fakeOwnership(902, 903), now: NOW,
    })
    const file = join(stateDir, STATE_FILES.launchCutover)
    const legacy = JSON.parse(readFileSync(file, 'utf8'))
    legacy.phase = 'ready'
    legacy.authentication.browserHandoff = 'accepted'
    delete legacy.browserHandoff
    writeFileSync(file, JSON.stringify(legacy))

    expect(readCutoverReceipt(stateDir)).toMatchObject({
      phase: 'ready',
      authentication: { browserHandoff: 'fallback-opened' },
      browserHandoff: { required: true, status: 'fallback-opened' },
    })
  })

  it('gates target and previous launch events on the filesystem transition phase', () => {
    const stateDir = tmpDir('guard-cutover-transition-')
    const previous = spec('node previous-host.js', stateDir)
    const target = spec('node target-host.js', stateDir)
    const transition = {
      version: 1 as const,
      planPath: join(stateDir, 'launch-transitions/cutover-transition/plan.json'),
      planSha256: 'a'.repeat(64),
      operationCount: 1,
    }
    prepareLaunchCutover(stateDir, {
      id: 'cutover-transition', previous, target, transition,
      recoveryPolicy: 'restore-previous', browserHandoff: 'off',
      previousSupervisorPid: 1001, previousSupervisorStartToken: 'supervisor-start-1001',
      previousOwnership: fakeOwnership(1002, 1003), now: NOW,
    })

    expect(() => recordCutoverEvent(
      stateDir, 'cutover-transition', 'child-started', ['target', '1', '1004', 'target-start-1004'], NOW + 1,
    )).toThrow(/transition has not been applied/)
    expect(() => recordCutoverEvent(
      stateDir, 'cutover-transition', 'transition', ['applied', 'b'.repeat(64)], NOW + 2,
    )).toThrow(/digest does not match/)
    recordCutoverEvent(stateDir, 'cutover-transition', 'transition', ['applied', transition.planSha256], NOW + 3)
    recordCutoverEvent(
      stateDir, 'cutover-transition', 'child-started', ['target', '1', '1004', 'target-start-1004'], NOW + 4,
    )
    recordCutoverEvent(
      stateDir, 'cutover-transition', 'attempt-failed', ['target', '1', 'target failed'], NOW + 5,
    )
    expect(() => recordCutoverEvent(
      stateDir, 'cutover-transition', 'restoring', ['approved recovery'], NOW + 6,
    )).toThrow(/has not been rolled back/)

    recordCutoverEvent(stateDir, 'cutover-transition', 'transition', ['rolled-back', transition.planSha256], NOW + 7)
    expect(() => recordCutoverEvent(
      stateDir, 'cutover-transition', 'transition', ['applied', transition.planSha256], NOW + 8,
    )).toThrow(/cannot be applied/)
    recordCutoverEvent(stateDir, 'cutover-transition', 'restoring', ['approved recovery'], NOW + 9)
    recordCutoverEvent(
      stateDir, 'cutover-transition', 'child-started', ['previous', '1', '1005', 'previous-start-1005'], NOW + 10,
    )

    expect(readCutoverReceipt(stateDir)).toMatchObject({ transition: {
      planSha256: transition.planSha256,
      operationCount: 1,
      phase: 'rolled-back',
    } })
    const rendered = JSON.stringify(summarizeLaunchState(readLaunchState(stateDir)))
    expect(rendered).not.toContain(transition.planPath)
    expect(rendered).toContain(transition.planSha256)
  })

  it('summarizes launch state without exposing either command', () => {
    const stateDir = tmpDir('guard-cutover-')
    const previous = spec('do-not-print-previous-command', stateDir)
    const target = spec('do-not-print-target-command', stateDir)
    prepareLaunchCutover(stateDir, {
      id: 'cutover-summary', previous, target,
      recoveryPolicy: 'wait-for-user', browserHandoff: 'required',
      previousSupervisorPid: 401, previousSupervisorStartToken: 'supervisor-start-401', previousOwnership: fakeOwnership(402), now: NOW,
    })
    const rendered = JSON.stringify(summarizeLaunchState(readLaunchState(stateDir)))
    expect(rendered).not.toContain(previous.command)
    expect(rendered).not.toContain(target.command)
    expect(rendered).toContain('commandSha256')
    // Receipt-first preparation can crash before the launch-state commit. An
    // orphan nonterminal receipt must not gate a still-stable deployment.
    writeStableLaunchSpec(stateDir, previous)
    expect(cutoverBlocksWake(stateDir)).toBe(false)
  })
})

describe('cordis service (real git repo)', () => {
  it('record → verify → mutate → verify-denied → checkpoint → reset round trip', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-service-')
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [] } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()

    expect(ctx.selfRestartGuard.verify().ok).toBe(false)

    ctx.selfRestartGuard.record('build')
    expect(ctx.selfRestartGuard.verify().ok).toBe(true)

    commitChange(repo)
    const denied = ctx.selfRestartGuard.verify()
    expect(denied.ok).toBe(false)
    expect(denied.reason).toContain('bound to revision')

    const cp = ctx.selfRestartGuard.checkpoint('after change')
    expect(cp.ok).toBe(true)
    expect(ctx.selfRestartGuard.status().checkpoint?.revision).toBe(cp.ok ? cp.sha : '')

    // Roll back to the checkpoint: the change commit is discarded.
    const reset = ctx.selfRestartGuard.reset(cp.ok ? cp.sha : '')
    expect(reset.ok).toBe(true)
    await fiber.dispose()
  })

  it('record throws outside a git repository', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [] } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir: tmpDir('guard-state-'), repoDir: tmpDir('not-a-repo-'), maxAgeMinutes: 5 })
    await fiber.await()
    expect(() => ctx.selfRestartGuard.record('build')).toThrow(/outside a git repository/)
    await fiber.dispose()
  })
})

/** Capture CLI output for assertions. */
function cliIo(): { out: string[]; err: string[]; io: CliIo } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: l => out.push(l), stderr: l => err.push(l) } }
}

/** Mark this test process as the live watchdog owner for gate-only CLI tests. */
function markLiveWatchdog(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, STATE_FILES.watchdogPid), String(process.pid))
}

/** Set or unset $DSH_PREFLIGHT_COMMAND, restored after the test. `undefined` restores real app-bin resolution. */
function stubPreflight(command: string | undefined): void {
  const previous = process.env.DSH_PREFLIGHT_COMMAND
  if (command === undefined) delete process.env.DSH_PREFLIGHT_COMMAND
  else process.env.DSH_PREFLIGHT_COMMAND = command
  cleanups.push(() => {
    if (previous === undefined) delete process.env.DSH_PREFLIGHT_COMMAND
    else process.env.DSH_PREFLIGHT_COMMAND = previous
  })
}

/** Point the app-bin resolution at a fixed answer, restored after the test. */
function stubPreflightBin(resolveBin: () => string | undefined): void {
  const original = preflightInternals.resolveBin
  preflightInternals.resolveBin = resolveBin
  cleanups.push(() => { preflightInternals.resolveBin = original })
}

/** Point the standalone-runner resolution at a fixed answer, restored after the test. */
function stubPreflightRunner(resolveRunner: (harnessRoot: string) => string | undefined): void {
  const original = preflightInternals.resolveRunner
  preflightInternals.resolveRunner = resolveRunner
  cleanups.push(() => { preflightInternals.resolveRunner = original })
}

/** Explicit built-surface binding for reconfigure tests that do not exercise the real runner. */
function boundPreflightArgs(candidateProbeCommand = 'true', observedHarnessFile?: string): string[] {
  const root = tmpDir('guard-bound-preflight-')
  const installAnchor = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const runner = join(root, 'preflight-runner.js')
  mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(installAnchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }))
  writeFileSync(runner, observedHarnessFile === undefined
    ? 'process.exit(0)\n'
    : `require('node:fs').writeFileSync(${JSON.stringify(observedHarnessFile)}, process.env.DSH_HARNESS ?? '')\n`)
  return [
    '--preflight-surface', 'built',
    '--preflight-runner', runner,
    '--preflight-install-anchor', installAnchor,
    '--candidate-probe-command', candidateProbeCommand,
  ]
}

/** Fake the sandbox probe, restored after the test. */
function stubSandboxProbe(sandboxed: boolean): void {
  const original = envInternals.sandboxedByProbe
  envInternals.sandboxedByProbe = () => sandboxed
  cleanups.push(() => { envInternals.sandboxedByProbe = original })
}

describe('CLI', () => {
  const io = cliIo

  it('initializes launch state once and prints only redacted launch summaries', async () => {
    const repo = makeRepo()
    const home = tmpDir('guard-launch-home-')
    const stateDir = join(home, 'state')
    const firstCommand = 'do-not-print-first-launch-command'
    const replacementCommand = 'do-not-print-replacement-launch-command'
    expect(await runCli([
      'configure-launch', '--port', '3080', '--start', firstCommand,
      '--home', home, '--profile', 'web', '--state-dir', stateDir, '--repo', repo,
      '--harness-root', join(home, 'host-current'),
      ...boundPreflightArgs(),
    ], io().io)).toBe(0)
    expect(await runCli([
      'configure-launch', '--if-absent', '--port', '3080', '--start', replacementCommand,
      '--home', home, '--profile', 'web', '--state-dir', stateDir, '--repo', repo,
      '--harness-root', join(home, 'host-replacement'),
      ...boundPreflightArgs(),
    ], io().io)).toBe(0)
    expect(selectedLaunchSpec(readLaunchState(stateDir)!).command).toBe(firstCommand)
    expect(selectedLaunchSpec(readLaunchState(stateDir)!).preflight).toMatchObject({
      surface: 'built',
      candidateProbeProvenance: 'caller-supplied',
      targetCommandSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      runnerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    const status = io()
    expect(await runCli(['launch-status', '--state-dir', stateDir], status.io)).toBe(0)
    const text = status.out.join('')
    expect(text).not.toContain(firstCommand)
    expect(text).not.toContain(replacementCommand)
    expect(text).toContain('commandSha256')
    expect(text).toContain('targetCommandSha256')
    expect(text).toContain('runnerSha256')
  })

  it('refuses to invent a complete previous spec from the legacy instance-launch record', async () => {
    const stateDir = tmpDir('guard-legacy-launch-')
    const home = tmpDir('guard-legacy-home-')
    const targetRepo = makeRepo()
    writeInstanceLaunchAsSupervisor(stateDir, {
      command: 'legacy-current-command', source: 'supervisor', supervised: true, port: 3080, recordedAt: NOW,
    })
    const result = io()
    expect(await runCli([
      'reconfigure', '--start', 'target-command', '--on-failure', 'restore-previous',
      '--port', '3080', '--home', home, '--repo', targetRepo,
      '--harness-root', join(home, 'target-harness'), '--profile', 'web', '--state-dir', stateDir,
    ], result.io)).toBe(2)
    expect(result.err.join('')).toContain('legacy instance-launch record does not identify credential repo, host root, home, and profile independently')
    expect(result.err.join('')).toContain('configure-launch')
    expect(readLaunchState(stateDir)).toBeNull()
  })

  it('uses target credential repo for the gate and target harness root for reconfigure preflight', async () => {
    const stateDir = tmpDir('guard-split-roots-')
    const previousRepo = makeRepo()
    const targetRepo = makeRepo()
    const previousHarness = tmpDir('guard-previous-harness-')
    const targetHarness = tmpDir('guard-target-harness-')
    const home = tmpDir('guard-split-home-')
    writeStableLaunchSpec(stateDir, {
      version: 1,
      command: 'previous-command',
      port: 3080,
      home,
      credentialRepo: previousRepo,
      harnessRoot: previousHarness,
      profile: 'web',
    })
    recordCredential(stateDir, {
      scope: 'target build+test', revision: currentHead(targetRepo)!, command: 'pnpm test',
    }, Date.now())
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, STATE_FILES.watchdogPid), String(process.pid))
    // Stop after the two independent gates and before any cutover mutation.
    writeFileSync(join(stateDir, STATE_FILES.restartLock), String(process.pid))
    stubSandboxProbe(false)
    stubPreflight(undefined)
    const observedHarnessFile = join(stateDir, 'observed-harness')

    const result = io()
    expect(await runCli([
      'reconfigure', '--start', 'target-command', '--on-failure', 'restore-previous',
      '--repo', targetRepo, '--harness-root', targetHarness,
      '--state-dir', stateDir,
      ...boundPreflightArgs('true', observedHarnessFile),
    ], result.io)).toBe(1)
    expect(result.out.join('')).toContain('composition preflight PASS')
    expect(result.err.join('')).toContain('restart is in flight')
    expect(readFileSync(observedHarnessFile, 'utf8')).toBe(targetHarness)
    expect(selectedLaunchSpec(readLaunchState(stateDir)!)).toMatchObject({
      credentialRepo: previousRepo,
      harnessRoot: previousHarness,
    })
  })

  it('binds a candidate command probe to the target command and refuses before cutover when target argv is invalid', async () => {
    const stateDir = tmpDir('guard-candidate-probe-')
    const repo = makeRepo()
    const home = tmpDir('guard-candidate-home-')
    writeStableLaunchSpec(stateDir, {
      version: 1, command: 'previous-command', port: 3080, home,
      credentialRepo: repo, harnessRoot: home, profile: 'web',
    })
    recordCredential(stateDir, {
      scope: 'target build+test', revision: currentHead(repo)!, command: 'pnpm test',
    }, Date.now())
    markLiveWatchdog(stateDir)
    stubSandboxProbe(false)

    const result = io()
    expect(await runCli([
      'reconfigure', '--start', 'dsh web --profile web-target',
      '--on-failure', 'restore-previous', '--state-dir', stateDir, '--repo', repo,
      ...boundPreflightArgs(`"${process.execPath}" -e "console.error('unknown option --profile http://127.0.0.1:3080/?token=one-time-secret'); process.exit(2)"`),
    ], result.io)).toBe(1)
    expect(result.err.join('')).toContain('candidate command probe failed')
    expect(result.err.join('')).toContain('unknown option --profile')
    expect(result.err.join('')).toContain('token=<redacted>')
    expect(result.err.join('')).not.toContain('one-time-secret')
    expect(readLaunchState(stateDir)).toMatchObject({ mode: 'stable', active: { command: 'previous-command' } })
    expect(readCutoverReceipt(stateDir)).toBeNull()
  })

  it('refuses a dangling snapshot link before running the candidate or stopping previous', async () => {
    const stateDir = tmpDir('guard-snapshot-dangling-state-')
    const repo = makeRepo()
    const home = tmpDir('guard-snapshot-dangling-home-')
    const candidateMarker = join(stateDir, 'candidate-ran')
    writeStableLaunchSpec(stateDir, {
      version: 1, command: 'previous-command', port: 3080, home,
      credentialRepo: repo, harnessRoot: home, profile: 'web',
    })
    recordCredential(stateDir, {
      scope: 'target build+test', revision: currentHead(repo)!, command: 'pnpm test',
    }, Date.now())
    markLiveWatchdog(stateDir)
    symlinkSync('missing-target', join(home, 'dangling'))
    stubSandboxProbe(false)

    const result = io()
    expect(await runCli([
      'reconfigure', '--start', 'target-command',
      '--on-failure', 'restore-previous', '--state-dir', stateDir, '--repo', repo,
      ...boundPreflightArgs(`touch ${JSON.stringify(candidateMarker)}`),
    ], result.io)).toBe(1)
    expect(result.err.join('')).toContain('could not prepare an isolated home')
    expect(result.err.join('')).toContain('could not safely copy')
    expect(existsSync(candidateMarker)).toBe(false)
    expect(readLaunchState(stateDir)).toMatchObject({ mode: 'stable', active: { command: 'previous-command' } })
    expect(readCutoverReceipt(stateDir)).toBeNull()
    expect(Number(readFileSync(join(stateDir, STATE_FILES.watchdogPid), 'utf8'))).toBe(process.pid)
  })

  it('schedule-exit rejects flags or an instance record that diverge from the durable active launch spec', async () => {
    const stateDir = tmpDir('guard-schedule-spec-')
    const repo = makeRepo()
    const otherRepo = makeRepo()
    const home = tmpDir('guard-schedule-home-')
    const active = {
      version: 1 as const,
      command: 'durable-host-command',
      port: 3080,
      home,
      credentialRepo: repo,
      harnessRoot: join(home, 'host'),
      profile: 'web',
    }
    writeStableLaunchSpec(stateDir, active)
    writeInstanceLaunchAsSupervisor(stateDir, {
      command: active.command, source: 'supervisor', supervised: true, port: active.port, recordedAt: NOW,
    })
    markLiveWatchdog(stateDir)
    expect(await runCli([
      'record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo,
    ], io().io)).toBe(0)

    const flagConflict = io()
    expect(await runCli([
      'schedule-exit', '--port', '3080', '--delay-ms', '5000', '--state-dir', stateDir, '--repo', otherRepo,
    ], flagConflict.io)).toBe(1)
    expect(flagConflict.err.join('')).toContain('conflict with the durable active launch specification')
    expect(flagConflict.err.join('')).toContain('Use reconfigure')
    expect(existsSync(join(stateDir, STATE_FILES.restartRequested))).toBe(false)

    writeInstanceLaunchAsSupervisor(stateDir, {
      command: 'stale-rejected-target', source: 'supervisor', supervised: true, port: active.port, recordedAt: NOW,
    })
    const recordConflict = io()
    expect(await runCli([
      'schedule-exit', '--delay-ms', '5000', '--state-dir', stateDir,
    ], recordConflict.io)).toBe(1)
    expect(recordConflict.err.join('')).toContain('does not prove that its supervisor owns')
    expect(existsSync(join(stateDir, STATE_FILES.restartRequested))).toBe(false)
  })

  it('refuses a second stop or reconfigure while a launch cutover is active', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-cutover-')
    const base = {
      version: 1 as const,
      port: 3080,
      home: join(stateDir, 'home'),
      credentialRepo: repo,
      harnessRoot: join(stateDir, 'harness'),
      profile: 'web',
    }
    prepareLaunchCutover(stateDir, {
      id: 'exclusive-cutover',
      previous: { ...base, command: 'previous' },
      target: { ...base, command: 'target' },
      recoveryPolicy: 'wait-for-user', browserHandoff: 'off',
      previousSupervisorPid: 501, previousSupervisorStartToken: 'supervisor-start-501', previousOwnership: fakeOwnership(502), now: NOW,
    })
    const reconfigure = io()
    expect(await runCli([
      'reconfigure', '--start', 'another-target', '--on-failure', 'wait-for-user',
      '--state-dir', stateDir, '--repo', repo,
    ], reconfigure.io)).toBe(1)
    expect(reconfigure.err.join('')).toContain('exclusive-cutover')
    const scheduled = io()
    expect(await runCli([
      'schedule-exit', '--port', '3080', '--delay-ms', '1',
      '--state-dir', stateDir, '--repo', repo,
    ], scheduled.io)).toBe(1)
    expect(scheduled.err.join('')).toContain('launch cutover exclusive-cutover')
  })

  it('persists formal abort and restore-previous requests, with explicit restore taking precedence', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-control-')
    const base = {
      version: 1 as const,
      port: 3080,
      home: join(stateDir, 'home'),
      credentialRepo: repo,
      harnessRoot: join(stateDir, 'harness'),
      profile: 'web',
    }
    const ready = join(stateDir, 'watchdog-ready')
    const fakeProgram = `
      const fs = require('node:fs')
      const { pathToFileURL } = require('node:url')
      import(pathToFileURL(${JSON.stringify(testSeamModule)}).href).then(seam => {
        process.on('SIGUSR2', () => seam.appendTestLifecycleEvent('signal-received', { signal: 'SIGUSR2' }))
        seam.appendTestLifecycleEvent('handler-installed')
        setImmediate(() => {
          seam.appendTestLifecycleEvent('keepalive-first-tick')
          fs.writeFileSync(${JSON.stringify(ready)}, 'ready')
          seam.appendTestLifecycleEvent('ready')
        })
        setInterval(() => {}, 1000)
      })
    `
    const watchdog = spawn(process.execPath, ['-e', fakeProgram], {
      stdio: 'ignore',
      env: lifecycle.childEnv('fake-control-watchdog', process.env, { tempRoot: stateDir }),
    })
    const readyDeadline = performance.now() + 10_000
    while (!existsSync(ready) && performance.now() < readyDeadline) {
      if (watchdog.pid !== undefined) {
        let state = 'gone'
        try { state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(watchdog.pid)], { encoding: 'utf8' }).trim() || 'gone' } catch { /* gone */ }
        appendTestLifecycleEventForProcess(watchdog.pid, 'fake-control-watchdog', 'process-state-observed', { state }, 'ps-sampler')
        if (state === 'gone') break
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (!existsSync(ready)) throw new Error(`fake watchdog never became ready:\n${lifecycle.diagnostics()}`)
    writeFileSync(join(stateDir, STATE_FILES.watchdogPid), String(watchdog.pid))
    appendTestLifecycleEventForProcess(watchdog.pid!, 'fake-control-watchdog', 'pidfile-published', undefined, 'parent-observer')
    prepareLaunchCutover(stateDir, {
      id: 'controlled-cutover',
      previous: { ...base, command: 'previous' },
      target: { ...base, command: 'target' },
      recoveryPolicy: 'wait-for-user', browserHandoff: 'off',
      previousSupervisorPid: 901, previousSupervisorStartToken: 'supervisor-start-901', previousOwnership: fakeOwnership(902), now: NOW,
    })
    expect(await runCli(['abort-cutover', '--state-dir', stateDir], io().io)).toBe(0)
    expect(readCutoverControl(stateDir)).toMatchObject({ cutoverId: 'controlled-cutover', action: 'abort' })
    expect(await runCli(['restore-previous', '--state-dir', stateDir], io().io)).toBe(0)
    expect(readCutoverControl(stateDir)).toMatchObject({ cutoverId: 'controlled-cutover', action: 'restore-previous' })
    // A later weaker abort cannot downgrade the explicit restoration request.
    expect(await runCli(['abort-cutover', '--state-dir', stateDir], io().io)).toBe(0)
    expect(readCutoverControl(stateDir)?.action).toBe('restore-previous')

    // Cross-process writers cannot reproduce the old read-then-overwrite
    // ordering bug: the separate restore marker remains dominant regardless
    // of which CLI process renames its file last.
    rmSync(join(stateDir, STATE_FILES.cutoverAbort), { force: true })
    rmSync(join(stateDir, STATE_FILES.cutoverRestorePrevious), { force: true })
    const cli = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
    const cliSha256 = createHash('sha256').update(readFileSync(cli)).digest('hex')
    const actions = Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? 'abort-cutover' : 'restore-previous')
    const writers = actions.map((action, index) => spawn(process.execPath, [cli, action, '--state-dir', stateDir], {
      stdio: 'ignore',
      env: lifecycle.childEnv(`control-writer-${index}`, process.env, { tempRoot: stateDir }),
    }))
    const codes = await Promise.all(writers.map(writer => new Promise<number | null>(resolveExit => {
      writer.on('exit', resolveExit)
    })))
    const finalCliSha256 = createHash('sha256').update(readFileSync(cli)).digest('hex')
    expect(codes, `built CLI ${cli} sha256=${cliSha256}\n${lifecycle.diagnostics()}`).toEqual(actions.map(() => 0))
    expect(finalCliSha256).toBe(cliSha256)
    expect(readCutoverControl(stateDir)?.action).toBe('restore-previous')
    const childEvents = lifecycle.events().filter(event => event.pid === watchdog.pid)
    const eventIndex = (name: string): number => childEvents.findIndex(event => event.event === name)
    expect(eventIndex('handler-installed')).toBeGreaterThanOrEqual(0)
    expect(eventIndex('keepalive-first-tick')).toBeGreaterThan(eventIndex('handler-installed'))
    expect(eventIndex('ready')).toBeGreaterThan(eventIndex('keepalive-first-tick'))
    expect(eventIndex('signal-received')).toBeGreaterThan(eventIndex('ready'))
  }, 30_000)

  it('refuses to resume a legacy active cutover that lacks authoritative child/listener ownership', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-legacy-cutover-')
    const base = {
      version: 1 as const,
      port: 3080,
      home: join(stateDir, 'home'),
      credentialRepo: repo,
      harnessRoot: join(stateDir, 'harness'),
      profile: 'web',
    }
    prepareLaunchCutover(stateDir, {
      id: 'legacy-cutover',
      previous: { ...base, command: 'previous' },
      target: { ...base, command: 'target' },
      recoveryPolicy: 'wait-for-user', browserHandoff: 'off',
      previousSupervisorPid: 911, previousSupervisorStartToken: 'supervisor-start-911', previousOwnership: fakeOwnership(912), now: NOW,
    })
    const receiptFile = join(stateDir, STATE_FILES.launchCutover)
    const legacy = JSON.parse(readFileSync(receiptFile, 'utf8'))
    delete legacy.ownership
    writeFileSync(receiptFile, JSON.stringify(legacy))

    const output = io()
    expect(await runCli(['supervise', '--foreground', '--state-dir', stateDir], output.io)).toBe(1)
    expect(output.err.join('')).toContain('predates authoritative child/listener ownership evidence')
  })

  it('refuses a PID-only legacy cutover that lacks previous supervisor start identity', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-legacy-supervisor-')
    const base = {
      version: 1 as const,
      port: 3080,
      home: join(stateDir, 'home'),
      credentialRepo: repo,
      harnessRoot: join(stateDir, 'harness'),
      profile: 'web',
    }
    prepareLaunchCutover(stateDir, {
      id: 'legacy-supervisor-cutover',
      previous: { ...base, command: 'previous' },
      target: { ...base, command: 'target' },
      recoveryPolicy: 'wait-for-user', browserHandoff: 'off',
      previousSupervisorPid: 921, previousSupervisorStartToken: 'supervisor-start-921', previousOwnership: fakeOwnership(922), now: NOW,
    })
    const receiptFile = join(stateDir, STATE_FILES.launchCutover)
    const legacy = JSON.parse(readFileSync(receiptFile, 'utf8'))
    delete legacy.supervisor.previousStartToken
    writeFileSync(receiptFile, JSON.stringify(legacy))

    const output = io()
    expect(await runCli(['supervise', '--foreground', '--state-dir', stateDir], output.io)).toBe(1)
    expect(output.err.join('')).toContain('predates supervisor start identity evidence')
  })

  it('verify and record warn while no watchdog supervises the instance', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    // The agent's first contacts in any restart flow: the bootstrap gap must
    // surface HERE, before anyone considers a bare exit.
    const rec = io()
    expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', ...flags], rec.io)).toBe(0)
    expect(rec.err.join('')).toContain('no live watchdog')
    const ver = io()
    expect(await runCli(['verify', ...flags], ver.io)).toBe(0)
    expect(ver.err.join('')).toContain('no live watchdog')
  })

  it('refuses self-attestation and records only an exact successful argv on a clean unchanged tree', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-evidence-')
    const flags = ['--state-dir', stateDir, '--repo', repo]

    const selfAttested = io()
    expect(await runCli(['record', 'build', '--command', 'true', ...flags], selfAttested.io)).toBe(2)
    expect(selfAttested.err.join('')).toContain('refuses self-attestation')

    const observed = io()
    expect(await runCli([
      'record', 'build+test', ...flags, '--run', '--', process.execPath, '-e',
      "if (process.argv[1] !== 'argument with spaces') process.exit(7)", 'argument with spaces',
    ], observed.io)).toBe(0)
    expect(loadState(stateDir).credential?.command).toContain(JSON.stringify('argument with spaces'))

    const failed = io()
    expect(await runCli([
      'record', 'build+test', ...flags, '--run', '--', process.execPath, '-e', 'process.exit(9)',
    ], failed.io)).toBe(1)
    expect(failed.err.join('')).toContain('command exited 9')
    expect(loadState(stateDir).credential).toBeUndefined()
  })

  it('rejects a credential when any uncommitted input appears after recording', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-dirty-credential-')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    expect(await runCli([
      'record', 'build', '--trust-command', '--command', 'test fixture', ...flags,
    ], io().io)).toBe(0)
    writeFileSync(join(repo, 'untracked.txt'), 'not tested\n')
    const denied = io()
    expect(await runCli(['verify', ...flags], denied.io)).toBe(1)
    expect(denied.out.join('')).toContain('working tree is dirty')
  })

  it('records and verifies, then denies after a new commit', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const flags = ['--state-dir', stateDir, '--repo', repo]

    const rec = io()
    expect(await runCli(['record', 'build+test', '--trust-command', '--command', 'pnpm run build', ...flags], rec.io)).toBe(0)
    expect(rec.out.join('')).toContain('build+test')

    const ok = io()
    expect(await runCli(['verify', ...flags], ok.io)).toBe(0)
    expect(ok.out.join('')).toContain('valid')

    commitChange(repo)
    const denied = io()
    expect(await runCli(['verify', ...flags], denied.io)).toBe(1)
    expect(denied.out.join('')).toContain('bound to revision')

    const status = io()
    expect(await runCli(['status', '--state-dir', stateDir], status.io)).toBe(0)
    expect(JSON.parse(status.out.join('')) as GuardState).toMatchObject({ credential: { scope: 'build+test' } })
  })

  it('checkpoint and reset round trip', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const flags = ['--state-dir', stateDir, '--repo', repo]

    commitChange(repo)
    const cp = io()
    expect(await runCli(['checkpoint', '--message', 'batch', ...flags], cp.io)).toBe(0)
    const sha = cp.out.join('').trim().split(' ').pop()
    expect(sha).toMatch(/^[0-9a-f]{40}$/)

    writeFileSync(join(repo, 'a.txt'), '3')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-qm', 'post-checkpoint'])
    const reset = io()
    expect(await runCli(['reset', sha ?? '', '--repo', repo], reset.io)).toBe(0)
    expect(reset.out.join('')).toContain('reset to')
  })

  it('checkpoint refuses a dirty tree until the complete snapshot is explicitly approved', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    mkdirSync(join(repo, 'packages', 'x', 'y', 'src'), { recursive: true })
    writeFileSync(join(repo, 'packages', 'x', 'y', 'src', 'index.js'), '// stray emit\n')
    writeFileSync(join(repo, 'packages', 'x', 'y', 'src', 'index.ts'), 'export {}\n')
    const before = execFileSync('git', ['status', '--porcelain=v1'], { cwd: repo, encoding: 'utf8' })
    const refused = io()
    expect(await runCli(['checkpoint', '--message', 'batch', ...flags], refused.io)).toBe(1)
    expect(refused.err.join('')).toContain('--include-dirty')
    expect(execFileSync('git', ['status', '--porcelain=v1'], { cwd: repo, encoding: 'utf8' })).toBe(before)

    const cp = io()
    expect(await runCli(['checkpoint', '--message', 'batch', '--include-dirty', ...flags], cp.io)).toBe(0)
    expect(cp.out.join('')).toContain('1 build-artifact-looking')
    expect(cp.out.join('')).toContain('packages/x/y/src/index.js')
    // Explicit approval commits the complete snapshot and still flags likely artifacts.
    expect(execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' })).toContain('packages/x/y/src/index.js')
  })

  it('a failed approved checkpoint leaves HEAD and the caller staging area untouched', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-checkpoint-hook-')
    writeFileSync(join(repo, 'staged.txt'), 'staged\n')
    run(repo, ['add', 'staged.txt'])
    writeFileSync(join(repo, 'a.txt'), 'unstaged\n')
    const head = currentHead(repo)
    const status = execFileSync('git', ['status', '--porcelain=v1'], { cwd: repo, encoding: 'utf8' })
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)

    const out = io()
    expect(await runCli([
      'checkpoint', '--message', 'hook refusal', '--include-dirty', '--repo', repo, '--state-dir', stateDir,
    ], out.io)).toBe(1)
    expect(currentHead(repo)).toBe(head)
    expect(execFileSync('git', ['status', '--porcelain=v1'], { cwd: repo, encoding: 'utf8' })).toBe(status)
  })

  it('canary passes only when verify passes and the port is listening', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const flags = ['--state-dir', stateDir, '--repo', repo]

    // Nothing listening and no credential → FAIL.
    const fail = io()
    expect(await runCli(['canary', '--port', '1', ...flags], fail.io)).toBe(1)
    expect(fail.out.join('')).toContain('canary FAIL')

    // Credential recorded and a live listener → PASS.
    await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', ...flags], io().io)
    const server = await new Promise<Server>((resolve) => {
      const s = createServer(() => {})
      s.listen(0, '127.0.0.1', () => { resolve(s) })
    })
    const port = (server.address() as AddressInfo).port
    const pass = io()
    expect(await runCli(['canary', '--port', String(port), ...flags], pass.io)).toBe(0)
    expect(pass.out.join('')).toContain('canary PASS')
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })

  it('rejects unknown commands and flags with usage', async () => {
    const err = io()
    expect(await runCli(['frobnicate'], err.io)).toBe(2)
    expect(err.err.join('')).toContain('unknown command')
    const err2 = io()
    expect(await runCli(['verify', '--nope'], err2.io)).toBe(2)
    expect(err2.err.join('')).toContain('unknown flag')
  })

  it('restart refuses to stop an instance without a credential (the gate)', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    spawnServer(port, 'old')
    try {
      await waitForPort(port)
      const io2 = io()
      expect(await runCli(
        ['restart', '--sync', '--port', String(port), '--start', 'true', '--state-dir', stateDir, '--repo', repo],
        io2.io,
      )).toBe(1)
      expect(io2.err.join('')).toContain('restart refused')
      expect(await portListening(port)).toBe(true)
    } finally {
      await killListener(port)
    }
  })

  it('restart stops the old instance, starts the new one detached, and canaries it', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    spawnServer(port, 'old')
    try {
      await waitForPort(port)
      await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      const restarted = io()
      expect(await runCli(
        ['restart', '--sync', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        restarted.io,
      )).toBe(0)
      expect(restarted.out.join('')).toContain('restart + canary PASS')
      await waitForPort(port)
      expect(await fetchBody(port)).toBe('new')
    } finally {
      await killListener(port)
    }
  })

  it('restart starts the new instance without forwarding ambient WD_* variables', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    const dump = join(stateDir, 'instance-env.txt')
    spawnServer(port, 'old')
    // Simulate the caller being an agent shell inside a supervised instance:
    // it carries that instance's WD_* environment (the watchdog spawns the
    // instance with its own), and a bare restart must not forward it.
    const previousProbe = process.env.WD_PROBE_LEAK
    process.env.WD_PROBE_LEAK = 'must-not-reach-the-instance'
    try {
      await waitForPort(port)
      await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      const startCmd = `env > '${dump}'; "${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      const restarted = io()
      expect(await runCli(
        ['restart', '--sync', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        restarted.io,
      )).toBe(0)
      expect(restarted.out.join('')).toContain('restart + canary PASS')
      const leaked = readFileSync(dump, 'utf8').split('\n').filter(line => line.startsWith('WD_'))
      expect(leaked).toEqual([])
    } finally {
      if (previousProbe === undefined) delete process.env.WD_PROBE_LEAK
      else process.env.WD_PROBE_LEAK = previousProbe
      await killListener(port)
    }
  })

  it('restart --delay-ms waits before stopping (graceful self-restart)', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    spawnServer(port, 'old')
    try {
      await waitForPort(port)
      await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      const started = Date.now()
      const out = io()
      expect(await runCli(
        ['restart', '--sync', '--port', String(port), '--start', startCmd, '--delay-ms', '500',
          '--state-dir', stateDir, '--repo', repo],
        out.io,
      )).toBe(0)
      expect(Date.now() - started).toBeGreaterThanOrEqual(450)
      expect(out.out.join('')).toContain('scheduled restart in 500 ms')
      expect(await fetchBody(port)).toBe('new')
    } finally {
      await killListener(port)
    }
  })

  it('restart escalates to SIGKILL after --stop-timeout-ms and reports the forced stop', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    // A listener that swallows SIGTERM: only the SIGKILL escalation can stop it.
    spawn(process.execPath, ['-e',
      `process.on('SIGTERM', () => {}); require('http').createServer((q, s) => s.end('stubborn')).listen(${port}, '127.0.0.1')`],
    { stdio: 'ignore' })
    try {
      await waitForPort(port)
      await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      // The replacement retries binding: the stubborn listener's socket is
      // released asynchronously after its SIGKILL, so a single immediate bind
      // can race it (EADDRINUSE) and crash the replacement — a flake under
      // load. Retrying makes the takeover deterministic.
      const startCmd = `"${process.execPath}" -e "
const http = require('http');
const tryListen = () => http.createServer((q, s) => s.end('new')).listen(${port}, '127.0.0.1').on('error', (e) => { if (e.code === 'EADDRINUSE') setTimeout(tryListen, 100); else throw e; });
tryListen();
"`
      const out = io()
      const started = Date.now()
      expect(await runCli(
        ['restart', '--sync', '--port', String(port), '--start', startCmd, '--stop-timeout-ms', '700',
          '--state-dir', stateDir, '--repo', repo],
        out.io,
      )).toBe(0)
      // The grace deadline was honored before the SIGKILL escalation.
      expect(Date.now() - started).toBeGreaterThanOrEqual(600)
      expect(out.out.join('')).toContain('sending SIGKILL')
      expect(out.out.join('')).toContain('(forced)')
      // The takeover window is real: `restart`'s port probe can succeed against
      // the stubborn listener while it is still dying (SIGKILL delivery is
      // asynchronous) — the port then goes quiet until the replacement's
      // retrying bind wins. Probe until the NEW server answers.
      const takeoverDeadline = Date.now() + 5000
      let body = ''
      while (Date.now() < takeoverDeadline) {
        try {
          body = await fetchBody(port)
          if (body === 'new') break
        } catch { /* not up yet — the takeover window */ }
        await new Promise((resolve) => { setTimeout(resolve, 100) })
      }
      expect(body).toBe('new')
    } finally {
      await killListener(port)
    }
  })

  it('restart --rollback resets to the checkpoint when the new instance never comes up', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    spawnServer(port, 'old')
    try {
      await waitForPort(port)
      const cp = io()
      expect(await runCli(['checkpoint', '--message', 'pre', '--state-dir', stateDir, '--repo', repo], cp.io)).toBe(0)
      const sha = cp.out.join('').trim().split(' ').pop()
      commitChange(repo)
      await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      const broken = `"${process.execPath}" -e "process.exit(3)"`
      const failed = io()
      expect(await runCli(
        ['restart', '--sync', '--port', String(port), '--start', broken, '--rollback', '--timeout-ms', '2000',
          '--state-dir', stateDir, '--repo', repo],
        failed.io,
      )).toBe(1)
      expect(failed.out.join('')).toContain('rolled back to last known-good')
      // No boot stamp: the pre-batch checkpoint outranks the credential.
      expect(currentHead(repo)).toBe(sha)
    } finally {
      await killListener(port)
    }
  })

  it('restart refuses a dirty checkout before stopping the healthy instance', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    spawnServer(port, 'old')
    try {
      await waitForPort(port)
      // Checkpoint and credential both bind the CURRENT HEAD, but an input
      // appeared after evidence. It must not reach stop/start/rollback at all.
      const cp = io()
      expect(await runCli(['checkpoint', '--message', 'pre', '--state-dir', stateDir, '--repo', repo], cp.io)).toBe(0)
      await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      writeFileSync(join(repo, 'a.txt'), 'dirty')
      const broken = `"${process.execPath}" -e "process.exit(3)"`
      const failed = io()
      expect(await runCli(
        ['restart', '--sync', '--port', String(port), '--start', broken, '--rollback', '--timeout-ms', '2000',
          '--state-dir', stateDir, '--repo', repo],
        failed.io,
      )).toBe(1)
      expect(failed.err.join('')).toContain('working tree is dirty')
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('dirty')
      expect(await portListening(port)).toBe(true)
    } finally {
      await killListener(port)
    }
  })
})

describe('composition preflight gate', () => {
  const io = cliIo

  it('resolvePreflightBin finds the sibling app in this checkout and maps foreign layouts', () => {
    // Self-checkout resolution only applies when the package lives inside a dsh
    // repo checkout (a sibling apps/cli exists). In the standalone dsh-plugins
    // monorepo there is no sibling app, so the no-arg form stays undefined and
    // only the foreign-layout mapping is asserted.
    const here = resolvePreflightBin()
    if (here !== undefined) {
      expect(here).toContain('apps')
      // The production seam resolves the same bin.
      expect(preflightInternals.resolveBin()).toBe(here)
    }
    // Built-only layout: no src/bin.ts and no tsx, but lib/bin.js exists.
    const builtOnly = tmpDir('guard-layout-')
    mkdirSync(join(builtOnly, 'apps/cli/lib'), { recursive: true })
    writeFileSync(join(builtOnly, 'apps/cli/lib/bin.js'), '')
    const foreignCli = (root: string): string => join(root, 'packages/guard/ankh-guard/lib/cli.js')
    expect(resolvePreflightBin(foreignCli(builtOnly))).toBe(`node ${join(builtOnly, 'apps/cli/lib/bin.js')}`)
    // Source bin without tsx and no built bin: unresolvable.
    const noTsx = tmpDir('guard-layout-')
    mkdirSync(join(noTsx, 'apps/cli/src'), { recursive: true })
    writeFileSync(join(noTsx, 'apps/cli/src/bin.ts'), '')
    expect(resolvePreflightBin(foreignCli(noTsx))).toBeUndefined()
    // No app at all: unresolvable.
    expect(resolvePreflightBin(foreignCli(tmpDir('guard-layout-')))).toBeUndefined()
  })

  it('resolveHarnessRoot prefers the explicit host root, then DSH_HARNESS, then the conventional default', () => {
    expect(resolveHarnessRoot('/explicit-host')).toBe('/explicit-host')
    expect(resolveHarnessRoot(undefined, { DSH_HARNESS: '/env-harness' })).toBe('/env-harness')
    expect(resolveHarnessRoot('', { DSH_HARNESS: '  ' })).toBe(join(homedir(), 'code/deepseek-harness'))
  })

  it('resolveRunnerCommand maps a harness with tsx, and degrades without it', () => {
    // No tsx in the harness: unresolvable.
    const noTsx = tmpDir('guard-harness-')
    expect(resolveRunnerCommand(noTsx)).toBeUndefined()
    // tsx present: the command forms, naming the harness tsx and this
    // checkout's runner script (the runner always sits beside the CLI).
    const withTsx = tmpDir('guard-harness-')
    mkdirSync(join(withTsx, 'node_modules/tsx/dist/esm'), { recursive: true })
    writeFileSync(join(withTsx, 'node_modules/tsx/dist/esm/index.mjs'), '')
    const command = resolveRunnerCommand(withTsx)
    expect(command).toBeDefined()
    expect(command).toContain(withTsx)
    expect(command).toContain('preflight-runner')
    expect(command).toContain('tsx')
    // The production seam resolves the same command for the live harness.
    const live = preflightInternals.resolveRunner(resolveHarnessRoot(undefined, {}))
    if (live !== undefined) {
      expect(live).toContain('preflight-runner')
    }
  })

  it('preflight maps the subprocess verdict onto exit codes', async () => {
    stubPreflight('true')
    const pass = io()
    expect(await runCli(['preflight', '--profile', 'custom', '--timeout-ms', '5000'], pass.io)).toBe(0)

    stubPreflight(`"${process.execPath}" -e "console.error('composition is broken'); process.exit(1)"`)
    const failed = io()
    expect(await runCli(['preflight'], failed.io)).toBe(1)
    expect(failed.err.join('')).toContain('composition is broken')

    stubPreflight(`"${process.execPath}" -e "process.exit(3)"`)
    const infra = io()
    expect(await runCli(['preflight'], infra.io)).toBe(3)

    stubPreflight(`"${process.execPath}" -e "process.exit(2)"`)
    const unexpected = io()
    expect(await runCli(['preflight'], unexpected.io)).toBe(3)
    expect(unexpected.err.join('')).toContain('unexpected code 2')
  })

  it('gate treats a host CLI without the preflight subcommand as unavailable', async () => {
    // An official checkout (or older npm host) has bin.ts but no `preflight`
    // subcommand: commander answers exit 1 with an unknown-command error. The
    // gate must degrade and proceed, not refuse restarts on a phantom verdict.
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
    markLiveWatchdog(stateDir)
    stubPreflight(`"${process.execPath}" -e "console.error(\\"error: unknown command 'preflight'\\"); process.exit(1)"`)
    const out = io()
    await runCli(['schedule-exit', '--port', String(port), '--delay-ms', '100', '--state-dir', stateDir, '--repo', repo], out.io)
    expect(out.err.join('')).not.toContain('composition preflight failed')
    expect(out.out.join('')).toContain('unavailable')
  })

  it('preflight resolves the profile from $DSH_PROFILE when no flag is given', async () => {
    stubPreflight('true')
    const previous = process.env.DSH_PROFILE
    process.env.DSH_PROFILE = 'envprofile'
    cleanups.push(() => {
      if (previous === undefined) delete process.env.DSH_PROFILE
      else process.env.DSH_PROFILE = previous
    })
    expect(await runCli(['preflight'], io().io)).toBe(0)
  })

  it('an empty DSH_PREFLIGHT_COMMAND falls back to the resolved app bin', async () => {
    stubPreflight('')
    stubPreflightBin(() => 'true')
    stubPreflightRunner(() => undefined)
    const out = io()
    expect(await runCli(['preflight', '--profile', "it's"], out.io)).toBe(0)
  })

  it('preflight exits 3 with a clear message when no sibling dsh app exists', async () => {
    stubPreflight(undefined)
    stubPreflightBin(() => undefined)
    stubPreflightRunner(() => undefined)
    const out = io()
    expect(await runCli(['preflight'], out.io)).toBe(3)
    expect(out.err.join('')).toContain('preflight unavailable outside the dsh app layout')
  })

  it('schedule-exit refuses when the composition preflight fails, quoting the diagnostics', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
    markLiveWatchdog(stateDir)
    const lines = Array.from({ length: 50 }, (_, i) => `console.error('layer ${i} failed')`).join(';')
    stubPreflight(`"${process.execPath}" -e "${lines}; process.exit(1)"`)
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', String(port), '--delay-ms', '100', '--state-dir', stateDir, '--repo', repo],
      out.io,
    )).toBe(1)
    expect(out.err.join('')).toContain('schedule-exit refused: composition preflight failed')
    expect(out.err.join('')).toContain('layer 0 failed')
    expect(out.err.join('')).toContain('more lines')
    expect(out.err.join('')).not.toContain('layer 49 failed')
  })

  it('schedule-exit refuses with the infrastructure wording when preflight exits 3', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
    markLiveWatchdog(stateDir)
    stubPreflight(`"${process.execPath}" -e "process.exit(3)"`)
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', String(port), '--delay-ms', '100', '--state-dir', stateDir, '--repo', repo],
      out.io,
    )).toBe(1)
    expect(out.err.join('')).toContain('schedule-exit refused: the composition preflight itself failed')
    expect(out.err.join('')).toContain('NOT a verdict on the composition')
    expect(out.err.join('')).toContain('manual override')
  })

  it('schedule-exit refuses when the preflight times out', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
    markLiveWatchdog(stateDir)
    // exec replaces the shell, so the timeout's SIGKILL kills the sleeper itself.
    stubPreflight('exec sleep 10')
    const out = io()
    const pending = runCli(
      ['schedule-exit', '--port', String(port), '--delay-ms', '100', '--preflight-timeout-ms', '300',
        '--state-dir', stateDir, '--repo', repo],
      out.io,
    )
    // A caller whose own tool deadline expires while the gate is running must
    // still see which stage was active and the larger internal budget. The
    // completion verdict remains absent until the child actually settles.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    expect(out.out.join('')).toContain('composition preflight START (profile "web", timeout 300 ms)')
    expect(out.out.join('')).not.toContain('composition preflight PASS')
    expect(await pending).toBe(1)
    expect(out.err.join('')).toContain('preflight timed out after 300 ms')
  }, 15_000)

  it('schedule-exit warns and proceeds when no sibling dsh app exists (standalone layout)', async () => {
    const repo = makeRepo()
    const home = tmpDir('guard-home-')
    const port = await freePort()
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    })
    await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', join(home, 'state'), '--repo', repo], io().io)
    markLiveWatchdog(join(home, 'state'))
    stubPreflight(undefined)
    stubPreflightBin(() => undefined)
    stubPreflightRunner(() => undefined)
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', String(port), '--delay-ms', '60000', '--state-dir', join(home, 'state'), '--repo', repo],
      out.io,
    )).toBe(0)
    expect(out.out.join('')).toContain('preflight unavailable outside the dsh app layout — proceeding without it')
    expect(out.out.join('')).toContain('exit scheduled')
  })

  it('restart refuses on a composition preflight failure without stopping the instance', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    spawnServer(port, 'old')
    try {
      await waitForPort(port)
      await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('false')
      const out = io()
      expect(await runCli(
        ['restart', '--sync', '--port', String(port), '--start', 'true', '--state-dir', stateDir, '--repo', repo],
        out.io,
      )).toBe(1)
      expect(out.err.join('')).toContain('restart refused: composition preflight failed')
      expect(await portListening(port)).toBe(true)
    } finally {
      await killListener(port)
    }
  })

  it('caps captured preflight output instead of growing without bound', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)
    markLiveWatchdog(stateDir)
    stubPreflight(`"${process.execPath}" -e "process.stderr.write('x'.repeat(300000)); process.exit(1)"`)
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', String(port), '--delay-ms', '100', '--state-dir', stateDir, '--repo', repo],
      out.io,
    )).toBe(1)
    // The refusal holds, and the diagnostics are far below the raw 300 KB.
    expect(out.err.join('')).toContain('composition preflight failed')
    expect(out.err.join('').length).toBeLessThan(150_000)
  })

  it('rejects a bad --preflight-timeout-ms', async () => {
    const err = io()
    expect(await runCli(['preflight', '--preflight-timeout-ms', '10'], err.io)).toBe(2)
    expect(err.err.join('')).toContain('--preflight-timeout-ms must be an integer >= 100')
  })
})

/** Spawn a detached throwaway http server answering the given body on a port. */
function spawnServer(port: number, body: string): ReturnType<typeof spawn> {
  const script = `require('http').createServer((q,s)=>s.end(${JSON.stringify(body)})).listen(${port},'127.0.0.1')`
  const child = spawnPortRuntime(process.execPath, ['-e', script], port, { detached: true, stdio: 'ignore' })
  child.unref()
  return child
}

/** Whether something is listening on a TCP port. */
function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1500, () => { done(false) })
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
  })
}

/** Poll until a port listens (bounded). */
async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portListening(port)) return
    await new Promise((resolve) => { setTimeout(resolve, 200) })
  }
  throw new Error(`port ${port} never listened`)
}

/** Poll a lifecycle predicate with a named, load-resilient deadline. */
async function waitForCondition(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for ${description}`
    + `${lastError === undefined ? '' : `; last observation error: ${String(lastError)}`}`
    + `\n${lifecycle.diagnostics()}`,
  )
}

/** GET the body from a local http server. */
async function fetchBody(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ port, host: '127.0.0.1' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => { chunks.push(c) })
      res.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    })
    req.on('error', reject)
  })
}

/** GET only the status from a local HTTP server. */
async function fetchStatus(port: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    const req = httpGet({ port, host: '127.0.0.1' }, (res) => {
      res.resume()
      res.on('end', () => { resolve(res.statusCode ?? 0) })
    })
    req.on('error', reject)
  })
}

/** Stop only runtime identities explicitly bound to this run's port ledger. */
async function killListener(port: number): Promise<void> {
  const stopped = await lifecycle.stopPortProcesses(port)
  if (stopped === 0 && findPidOnPort(port) !== null) {
    throw new Error(`port ${port} has a listener but no registered runtime identity; refusing port-based cleanup\n${lifecycle.diagnostics()}`)
  }
}

describe('supervise', () => {
  // Separate Vitest processes isolate process.env/mocks while the machine-wide
  // port lease coordinates their real watchdogs. An ordinary direct run has
  // count=1 and still executes every case.
  const it = superviseIt
  const io = cliIo

  /** Throwaway DSH_HOME isolation + watchdog cleanup for the spawned supervisor. */
  function supervisedEnv(): { home: string; restore: () => void; stop: () => void } {
    const home = tmpDir('guard-home-')
    const previousHome = process.env.DSH_HOME
    const previousHarness = process.env.DSH_HARNESS
    process.env.DSH_HOME = home
    process.env.DSH_HARNESS = join(home, 'harness-root')
    mkdirSync(process.env.DSH_HARNESS, { recursive: true })
    const stop = (): void => {
      try {
        mkdirSync(join(home, 'state'), { recursive: true })
        writeFileSync(join(home, 'state', 'watchdog-stop'), '')
      } catch { /* best-effort */ }
    }
    const restore = (): void => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousHarness === undefined) delete process.env.DSH_HARNESS
      else process.env.DSH_HARNESS = previousHarness
    }
    // Publish the protocol marker before identity-gated TERM→wait→KILL. The
    // ordinary cleanup list runs later, after no child can recreate the home.
    gracefulStops.push(stop)
    cleanups.push(restore)
    return { home, restore, stop }
  }

  it('spawns a watchdog that idles, then takes over when the current owner exits', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    const host = spawn(process.execPath, ['-e',
      `require('http').createServer((q,s)=>s.end('host')).listen(${port},'127.0.0.1')`],
    { detached: true, stdio: 'ignore' })
    host.unref()
    try {
      await waitForPort(port)
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      const out = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', join(env.home, 'state'), '--repo', repo],
        out.io,
      )).toBe(0)
      expect(out.out.join('')).toContain('watchdog spawned')
      // The watchdog waits for the current owner to exit, then takes over.
      lifecycle.signalExact(host, 'SIGTERM')
      const deadline = Date.now() + 20_000
      let portDown = false
      while (Date.now() < deadline) {
        if (!portDown && !(await portListening(port))) portDown = true
        if (portDown && (await portListening(port))) break
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(await fetchBody(port)).toBe('new')
      expect(readFileSync(join(env.home, 'state', STATE_FILES.watchdogLog), 'utf8'))
        .toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} \[watchdog] /)
      // A live owner existed at supervise time: this takeover is an ADOPTION
      // restart, and the watchdog files a report record addressed to the
      // supervising session (empty initiator here — no DSH_SESSION_ID in this
      // test's env). The no-false-positive guard covers the first-EVER boot
      // (no owner), asserted by the next test.
      const record = join(env.home, 'state', 'last-restart.json')
      await waitForCondition('the adoption report record', () => existsSync(record))
      const outcome = JSON.parse(readFileSync(record, 'utf8'))
      expect(outcome.unexpected).toBeUndefined()
      expect(typeof outcome.exitAt).toBe('number')
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 60_000)

  it('a first-EVER boot (no previous owner) files no report record', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    try {
      // Nothing listens on the port: supervise boots the instance directly.
      // No owner was stopped, nothing was interrupted — a record here would be
      // a false alarm on first contact.
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', join(env.home, 'state'), '--repo', repo],
        io().io,
      )).toBe(0)
      await waitForPort(port)
      expect(await fetchBody(port)).toBe('new')
      await new Promise((resolve) => { setTimeout(resolve, 1500) })
      expect(existsSync(join(env.home, 'state', 'last-restart.json'))).toBe(false)
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 30_000)

  it('apply records how the instance was launched (instance-launch.json)', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = stateDir
    cleanups.push(() => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    })
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [], list: () => [] } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    const deadline = Date.now() + 5000
    const file = join(stateDir, 'instance-launch.json')
    while (!existsSync(file) && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
    const launch = JSON.parse(readFileSync(file, 'utf8'))
    expect(launch.source).toBe('instance')
    expect(launch.command).toContain(process.execPath)
    expect(launch.command.startsWith(`cd '`)).toBe(true)
    expect(launch.command).toContain(`DSH_HOME='${stateDir}'`)
    await fiber.dispose()
  })

  it('restart without --start uses the recorded launch command', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    const port = await freePort()
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'instance-launch.json'), JSON.stringify({
        command: buildLaunchCommand(process.execPath, [], ['-e', `require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')`], repo, {}),
        source: 'instance',
        recordedAt: Date.now(),
      }))
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', ...flags], io().io)).toBe(0)
      stubPreflight('true')
      const host = spawn(process.execPath, ['-e',
        `require('http').createServer((q,s)=>s.end('old')).listen(${port},'127.0.0.1')`],
      { detached: true, stdio: 'ignore' })
      host.unref()
      await waitForPort(port)
      // No --start: the launch record drives the respawn.
      const out = io()
      expect(await runCli(['restart', '--sync', '--port', String(port), ...flags], out.io)).toBe(0)
      expect(out.out.join('')).toContain('restart + canary PASS')
      expect(await fetchBody(port)).toBe('new')
      await killListener(port)
    } finally {
      env.restore()
    }
  }, 30_000)

  it('restart FALLBACK refuses only when a watchdog is ALIVE; a dead-supervised record warns and rescues', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    try {
      writeInstanceLaunchAsSupervisor(stateDir, { command: `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('ok')).listen(1,'127.0.0.1')"`, source: 'supervisor', supervised: true, recordedAt: Date.now() })
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', ...flags], io().io)).toBe(0)
      stubPreflight('true')
      // Watchdog DEAD despite the supervised record: refusing here would send
      // the agent to schedule-exit → the instance dies with nobody to respawn
      // it. Warn and rescue with the recorded command instead.
      const rescue = io()
      await runCli(['restart', '--sync', '--port', '1', ...flags], rescue.io)
      expect(rescue.err.join()).toContain('no live watchdog was found')
      expect(rescue.err.join()).not.toContain('schedule-exit` (the watchdog respawns')
      // Watchdog ALIVE (live pidfile): refuse all fallbacks, point at schedule-exit.
      // (A SLEEPER's pid, never the test worker's own — env.stop() SIGKILLs
      // whatever the pidfile names at teardown.)
      mkdirSync(stateDir, { recursive: true })
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
      sleeper.unref()
      writeFileSync(join(stateDir, 'watchdog.pid'), String(sleeper.pid))
      const out = io()
      expect(await runCli(['restart', '--sync', '--port', '1', ...flags], out.io)).toBe(2)
      expect(out.err.join()).toContain('schedule-exit')
      expect(out.err.join()).not.toContain('pass --start explicitly')
      rmSync(join(stateDir, 'watchdog.pid'), { force: true })
      lifecycle.signalExact(sleeper, 'SIGKILL')
      // The instance side never overwrites the supervisor's record.
      expect(writeInstanceLaunch(stateDir, { command: 'echo inner', source: 'instance', recordedAt: Date.now() })).toBe(false)
    } finally {
      env.restore()
    }
  }, 15_000)

  it('buildLaunchCommand preserves execArgv (tsx chains stay bootable)', () => {
    const command = buildLaunchCommand(
      '/usr/local/bin/node',
      ['--import', '/repo/node_modules/tsx/dist/esm/index.mjs'],
      ['/repo/apps/cli/src/bin.ts', 'web', '--port', '8801'],
      '/repo',
      { DSH_HOME: '/home/user/.dsh' },
    )
    expect(command).toContain("--import")
    expect(command).toContain('tsx/dist/esm/index.mjs')
    expect(command.indexOf('--import')).toBeLessThan(command.indexOf('bin.ts'))
    expect(command).toContain("DSH_HOME='/home/user/.dsh'")
    expect(command.startsWith("cd '/repo' && ")).toBe(true)
  })

  it('supervise without --start falls back to the record and writes the supervisor record', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    try {
      writeInstanceLaunch(stateDir, { command: `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')"`, source: 'instance', recordedAt: Date.now() })
      const out = io()
      // No --start: supervise resolves the record, writes its own authoritative
      // supervisor record, and spawns the watchdog.
      expect(await runCli(
        ['supervise', '--port', String(port), '--state-dir', stateDir, '--repo', repo],
        out.io,
      )).toBe(0)
      expect(out.out.join('')).toContain('watchdog spawned')
      const record = readInstanceLaunch(stateDir)
      expect(record?.source).toBe('supervisor')
      expect(record?.supervised).toBe(true)
      expect(record?.command).toContain(String(port))
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 30_000)

  it('check-env reports supervision, the restart command, and the bare-exit warning', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    try {
      // Unsupervised: warning present, and the start command discovered live.
      const host = spawnPortRuntime(process.execPath, ['-e',
        `require('http').createServer((q,s)=>s.end('x')).listen(${port},'127.0.0.1')`],
      port, { detached: true, stdio: 'ignore', env: { ...process.env, DSH_PROBE_MARKER: 'discovered-1' } })
      host.unref()
      await waitForPort(port)
      const out = io()
      expect(await runCli(['check-env', '--state-dir', stateDir, '--repo', repo, '--port', String(port)], out.io)).toBe(0)
      const text = out.out.join('')
      expect(text).toContain('supervision: NOT supervised')
      expect(text).toContain('leaves the service DOWN')
      expect(text).toContain('live discovery')
      expect(text).toContain(String(port))
      await killListener(port)
      // Supervised: pidfile with a live pid → the chain names the watchdog.
      // (A SLEEPER's pid, never the test worker's own — env.stop() SIGKILLs
      // whatever the pidfile names at teardown.)
      mkdirSync(stateDir, { recursive: true })
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
      sleeper.unref()
      writeFileSync(join(stateDir, 'watchdog.pid'), String(sleeper.pid))
      const out2 = io()
      expect(await runCli(['check-env', '--state-dir', stateDir, '--repo', repo], out2.io)).toBe(0)
      expect(out2.out.join('')).toContain(`supervised by ankh watchdog (pid ${sleeper.pid})`)
      lifecycle.signalExact(sleeper, 'SIGKILL')
    } finally {
      env.restore()
    }
  }, 15_000)

  it('restart without --start or a record discovers the launch live from the port listener', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    const port = await freePort()
    const serverFile = join(env.home, 'server.js')
    writeFileSync(serverFile, `require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')`)
    try {
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', ...flags], io().io)).toBe(0)
      stubPreflight('true')
      // The "instance": a node process running serverFile — discovery must
      // reconstruct `node <serverFile>` and re-run it after the stop.
      const host = spawn(process.execPath, [serverFile], { detached: true, stdio: 'ignore' })
      host.unref()
      await waitForPort(port)
      const out = io()
      expect(await runCli(['restart', '--sync', '--port', String(port), ...flags], out.io)).toBe(0)
      expect(out.out.join('')).toContain('restart + canary PASS')
      expect(await fetchBody(port)).toBe('new')
      await killListener(port)
    } finally {
      env.restore()
    }
  }, 30_000)

  it('restart self-detaches by default: the driver survives the caller and completes the loop', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    const port = await freePort()
    const host = spawn(process.execPath, ['-e',
      `require('http').createServer((q,s)=>s.end('old')).listen(${port},'127.0.0.1')`],
    { detached: true, stdio: 'ignore' })
    host.unref()
    try {
      await waitForPort(port)
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', ...flags], io().io)).toBe(0)
      stubPreflight('true')
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      // No --sync: the caller returns as soon as the driver is detached.
      const out = io()
      expect(await runCli(['restart', '--port', String(port), '--start', startCmd, ...flags], out.io)).toBe(0)
      expect(out.out.join('')).toContain('driver detached')
      // The driver does the real work: old stops, new comes up, lock released.
      const deadline = Date.now() + 20_000
      let body = ''
      while (Date.now() < deadline) {
        try {
          body = await fetchBody(port)
          if (body === 'new') break
        } catch { /* mid-restart */ }
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(body).toBe('new')
      const recordDeadline2 = Date.now() + 10_000
      const outcomeFile = join(stateDir, 'last-restart.json')
      while (!existsSync(outcomeFile) && Date.now() < recordDeadline2) {
        await new Promise((resolve) => { setTimeout(resolve, 200) })
      }
      // The restart verb records its outcome so the next boot reports it.
      const outcome = JSON.parse(readFileSync(outcomeFile, 'utf8'))
      expect(outcome.pid).toBe(host.pid)
      expect(outcome.error).toBeUndefined()
      const lockFile = join(stateDir, 'restart.lock')
      const lockDeadline = Date.now() + 10_000
      while (existsSync(lockFile) && Date.now() < lockDeadline) {
        await new Promise((resolve) => { setTimeout(resolve, 200) })
      }
      expect(existsSync(lockFile)).toBe(false)
      expect(readFileSync(join(stateDir, 'restart.log'), 'utf8')).toContain('restart + canary PASS')
    } finally {
      await killListener(port)
      env.restore()
    }
  }, 30_000)

  it('restart refuses while another restart holds the lock; a stale lock is reclaimed', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    try {
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', ...flags], io().io)).toBe(0)
      stubPreflight('true')
      const port = await freePort()
      // A LIVE holder (this test process): the second restart must refuse,
      // and nothing must be stopped.
      writeFileSync(join(stateDir, 'restart.lock'), String(process.pid))
      const refused = io()
      expect(await runCli(
        ['restart', '--sync', '--port', String(port), '--start', 'true', ...flags], refused.io,
      )).toBe(1)
      expect(refused.err.join('')).toContain('already in flight')
      // A STALE holder (dead pid): reclaimed, the restart proceeds (here it
      // reaches the port check and finds nothing to restart).
      writeFileSync(join(stateDir, 'restart.lock'), '999999')
      const proceeded = io()
      await runCli(['restart', '--sync', '--port', String(port), '--start', 'true', ...flags], proceeded.io)
      expect(proceeded.err.join()).not.toContain('already in flight')
      // An EMPTY lock (a writer SIGKILLed mid-create): nobody's claim —
      // Number('') is 0 and kill(0, 0) always succeeds, which once read as
      // "alive" and refused every restart forever.
      writeFileSync(join(stateDir, 'restart.lock'), '')
      const emptyLock = io()
      await runCli(['restart', '--sync', '--port', String(port), '--start', 'true', ...flags], emptyLock.io)
      expect(emptyLock.err.join()).not.toContain('already in flight')
      // A FRESH pending marker (schedule-exit in flight): restart must see
      // the other pending stop and refuse — the exit agent would otherwise
      // SIGTERM the instance this restart just started.
      writeFileSync(join(stateDir, 'restart-requested.json'), JSON.stringify({ requestedAt: Date.now() }))
      const marked = io()
      expect(await runCli(['restart', '--sync', '--port', String(port), '--start', 'true', ...flags], marked.io)).toBe(1)
      expect(marked.err.join()).toContain('scheduled exit is still pending')
    } finally {
      env.restore()
    }
  }, 15_000)

  it('schedule-exit refuses while a restart marker is still pending', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    mkdirSync(stateDir, { recursive: true })
    try {
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--repo', repo, '--state-dir', stateDir], io().io)).toBe(0)
      markLiveWatchdog(stateDir)
      stubPreflight('true')
      writeFileSync(join(stateDir, 'restart-requested.json'), JSON.stringify({ requestedAt: Date.now() }))
      const out = io()
      // Two sessions racing to schedule: the second must not overwrite the
      // first's initiator.
      expect(await runCli(
        ['schedule-exit', '--port', '1', '--delay-ms', '60000', '--state-dir', stateDir, '--repo', repo],
        out.io,
      )).toBe(1)
      expect(out.err.join('')).toContain('already scheduled')
      // A STALE marker (older than the TTL — a watchdog that died mid-flow
      // never cleared it) is overwritten with a warning, not refused forever.
      writeFileSync(join(stateDir, 'restart-requested.json'),
        JSON.stringify({ requestedAt: Date.now() - 20 * 60_000 }))
      const stale = io()
      expect(await runCli(
        ['schedule-exit', '--port', '1', '--delay-ms', '60000', '--state-dir', stateDir, '--repo', repo],
        stale.io,
      )).toBe(0)
      expect(stale.err.join()).toContain('stale restart marker')
      // schedule-exit holds the restart lock only across its check→write→spawn
      // critical section: a completed schedule leaves no lock behind.
      expect(existsSync(join(stateDir, 'restart.lock'))).toBe(false)
      // And the reverse direction: a live restart lock means an instance is
      // being restarted right now — the exit agent would kill the one it starts.
      rmSync(join(stateDir, 'restart-requested.json'), { force: true })
      writeFileSync(join(stateDir, 'restart.lock'), String(process.pid))
      const locked = io()
      expect(await runCli(
        ['schedule-exit', '--port', '1', '--delay-ms', '60000', '--state-dir', stateDir, '--repo', repo],
        locked.io,
      )).toBe(1)
      expect(locked.err.join()).toContain('restart is in flight')
      rmSync(join(stateDir, 'restart.lock'), { force: true })
    } finally {
      rmSync(join(stateDir, STATE_FILES.watchdogPid), { force: true })
      env.restore()
    }
  }, 15_000)

  it('takeover of a previously-healthy deployment leaves an unplanned-exit record', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    // The deployment has come up before: the stamp exists (written by any
    // healthy boot), so recovering an unplanned exit files the report record.
    mkdirSync(join(env.home, 'state'), { recursive: true })
    writeFileSync(join(env.home, 'state', 'last-good-boot.json'),
      `${JSON.stringify({ revision: currentHead(repo), at: Date.now() })}\n`)
    const host = spawn(process.execPath, ['-e',
      `require('http').createServer((q,s)=>s.end('host')).listen(${port},'127.0.0.1')`],
    { detached: true, stdio: 'ignore' })
    host.unref()
    try {
      await waitForPort(port)
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', join(env.home, 'state'), '--repo', repo],
        io().io,
      )).toBe(0)
      lifecycle.signalExact(host, 'SIGTERM')
      const deadline = Date.now() + 20_000
      let portDown = false
      while (Date.now() < deadline) {
        if (!portDown && !(await portListening(port))) portDown = true
        if (portDown && (await portListening(port))) break
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(await fetchBody(port)).toBe('new')
      const crashRecord = join(env.home, 'state', 'last-restart.json')
      await waitForCondition('the unplanned-exit report record', () => existsSync(crashRecord))
      expect(JSON.parse(readFileSync(crashRecord, 'utf8')).unexpected).toBe(true)
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 60_000)

  it('record-unexpected-exit writes once and never overwrites a pending record', async () => {
    const stateDir = tmpDir('guard-cli-')
    const first = io()
    expect(await runCli(['record-unexpected-exit', '--state-dir', stateDir], first.io)).toBe(0)
    expect(first.out.join('')).toContain('left a report record')
    const record = JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8'))
    expect(record.unexpected).toBe(true)
    // A second recovery while the first still awaits its report: kept, not overwritten.
    const second = io()
    expect(await runCli(['record-unexpected-exit', '--state-dir', stateDir], second.io)).toBe(0)
    expect(second.out.join('')).toContain('still pending')
    expect(JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8'))).toEqual(record)
  })

  it('record-composition-recovery carries the detail and merges over a bare exit record', async () => {
    const stateDir = tmpDir('guard-cli-')
    const first = io()
    expect(await runCli(['record-composition-recovery', '--state-dir', stateDir, '--detail', '卸载挂载行: @demo/x'], first.io)).toBe(0)
    expect(first.out.join('')).toContain('composition rollback recovery')
    const record = JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8'))
    expect(record.compositionRecovered).toBe(true)
    expect(record.detail).toBe('卸载挂载行: @demo/x')
    expect(record.unexpected).toBeUndefined()
    const second = io()
    expect(await runCli(['record-composition-recovery', '--state-dir', stateDir], second.io)).toBe(0)
    expect(second.out.join('')).toContain('still pending')
    expect(JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8'))).toEqual(record)
  })

  it('record-composition-recovery merges over a bare exit outcome, inheriting its initiator', async () => {
    const stateDir = tmpDir('guard-cli-')
    // The exit agent's bare outcome (no diagnostics) is pending; the watchdog
    // then recovers via composition rollback — its record is the truthful one.
    writeFileSync(join(stateDir, 'last-restart.json'), `${JSON.stringify({ exitAt: NOW, pid: 4242, initiator: 'session-owner' })}\n`)
    const out = io()
    expect(await runCli(['record-composition-recovery', '--state-dir', stateDir, '--detail', 'd'], out.io)).toBe(0)
    const record = JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8'))
    expect(record.compositionRecovered).toBe(true)
    expect(record.initiator).toBe('session-owner')
    // …but a pending record WITH diagnostics (a crash report) is never clobbered.
    acknowledgeRestartRecord(stateDir, JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8')), NOW)
    const crash = io()
    expect(await runCli(['record-unexpected-exit', '--state-dir', stateDir], crash.io)).toBe(0)
    expect(crash.out.join('')).toContain('left a report record')
    const blocked = io()
    expect(await runCli(['record-composition-recovery', '--state-dir', stateDir], blocked.io)).toBe(0)
    expect(blocked.out.join('')).toContain('still pending')
    expect(JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8')).unexpected).toBe(true)
  })

  it('the report text describes a composition-rollback recovery', () => {
    const text = restartContextText({ exitAt: NOW, compositionRecovered: true }, false)
    expect(text).toContain('回滚到上次健康的 profile 组合')
    expect(text).toContain('composition-backup-*')
  })

  it('the watchdog snapshots the healthy composition and restores it over a boot-killing profile change', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    // A fake profile whose composition input decides whether the "instance"
    // boots: the fixture start command fails (with an error subject OUTSIDE
    // the repo, like a plugin in the profile's node_modules) when the patch
    // layer carries the bad row.
    const profileDir = join(env.home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '# good composition\n')
    writeFileSync(join(profileDir, 'package.json'), '{"name":"profile-web"}\n')
    const startCmd = `"${process.execPath}" -e "const fs=require('fs');const c=fs.readFileSync('${profileDir}/cordis.patch.yml','utf8');if(c.includes('bad-plugin')){console.error('Error: apply failed at ${profileDir}/node_modules/bad-plugin/index.js');process.exit(1)}require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')"`
    try {
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        io().io,
      )).toBe(0)
      await waitForPort(port)
      // Healthy boot snapshotted the composition.
      const snap = join(stateDir, 'last-good-composition', 'cordis.patch.yml')
      await waitForCondition('the healthy composition snapshot', () => existsSync(snap))
      expect(readFileSync(snap, 'utf8')).toContain('good composition')
      // A plugin install lands a bad row, then the instance stops (any cause).
      writeFileSync(join(profileDir, 'cordis.patch.yml'), '# good composition\n# + bad-plugin row\n')
      const rejectedCompositionSha256 = createHash('sha256').update(readFileSync(join(profileDir, 'cordis.patch.yml'))).digest('hex')
      await killListener(port)
      // The watchdog fails to boot the bad composition, rolls the composition
      // back to the snapshot, and comes up — service recovered, plugin unmounted.
      const upDeadline = Date.now() + 45_000
      let recovered = false
      while (Date.now() < upDeadline) {
        if ((await portListening(port)) && readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').includes('bad-plugin') === false) {
          recovered = true
          break
        }
        await new Promise((resolve) => { setTimeout(resolve, 500) })
      }
      const listenerPid = findPidOnPort(port)
      const diagnostic = {
        message: 'the watchdog restored the healthy composition and the instance came up',
        deadlineAt: upDeadline,
        deadlineMs: 45_000,
        rejectedCompositionSha256,
        currentCompositionSha256: createHash('sha256').update(readFileSync(join(profileDir, 'cordis.patch.yml'))).digest('hex'),
        repoHead: currentHead(repo),
        listener: listenerPid === null ? null : processIdentity(Number(listenerPid)),
        receipt: readCutoverReceipt(stateDir),
        watchdogLogTail: readFileSync(join(stateDir, STATE_FILES.watchdogLog), 'utf8').slice(-12_000),
        lifecycle: JSON.parse(lifecycle.diagnostics()),
      }
      expect(recovered, JSON.stringify(diagnostic, null, 2)).toBe(true)
      expect(await fetchBody(port)).toBe('ok')
      // The failing inputs were backed up, and the recovery left a report record.
      const backups = readdirSync(stateDir).filter(name => name.startsWith('composition-backup-'))
      expect(backups.length).toBe(1)
      expect(readFileSync(join(stateDir, backups[0]!, 'cordis.patch.yml'), 'utf8')).toContain('bad-plugin')
      // The record write trails the port by the CLI spawn — wait for it.
      const recordFile = join(stateDir, 'last-restart.json')
      await waitForCondition('the composition-recovery report record', () => existsSync(recordFile))
      const record = JSON.parse(readFileSync(recordFile, 'utf8'))
      expect(record.compositionRecovered).toBe(true)
      expect(record.detail).toContain('回滚 profile patch 层变更')
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 90_000)

  it('record-adoption carries the initiator and never overwrites a pending record', async () => {
    const stateDir = tmpDir('guard-cli-')
    const first = io()
    expect(await runCli(['record-adoption', '--state-dir', stateDir, '--initiator', 'session-x'], first.io)).toBe(0)
    expect(first.out.join('')).toContain('adoption takeover')
    const record = JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8'))
    expect(record.initiator).toBe('session-x')
    expect(record.unexpected).toBeUndefined()
    expect(typeof record.exitAt).toBe('number')
    const second = io()
    expect(await runCli(['record-adoption', '--state-dir', stateDir, '--initiator', 'session-y'], second.io)).toBe(0)
    expect(second.out.join('')).toContain('still pending')
    expect(JSON.parse(readFileSync(join(stateDir, 'last-restart.json'), 'utf8'))).toEqual(record)
  })

  it('the adoption takeover reports back to the session that established supervision', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    // No last-good-boot stamp: this deployment has never come up — the first
    // takeover must file an ADOPTION record (addressed to the supervising
    // session), never an unexpected-exit one.
    const host = spawn(process.execPath, ['-e',
      `require('http').createServer((q,s)=>s.end('host')).listen(${port},'127.0.0.1')`],
    { detached: true, stdio: 'ignore' })
    host.unref()
    const previousSession = process.env.DSH_SESSION_ID
    process.env.DSH_SESSION_ID = 'session-supervisor'
    try {
      await waitForPort(port)
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', join(env.home, 'state'), '--repo', repo],
        io().io,
      )).toBe(0)
      // The detached watchdog waits for the owner to exit, then takes over.
      lifecycle.signalExact(host, 'SIGTERM')
      const record = join(env.home, 'state', 'last-restart.json')
      const deadline = Date.now() + 20_000
      while (!existsSync(record) && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      const outcome = JSON.parse(readFileSync(record, 'utf8'))
      expect(outcome.initiator).toBe('session-supervisor')
      expect(outcome.unexpected).toBeUndefined()
      expect(await fetchBody(port)).toBe('new')
    } finally {
      if (previousSession === undefined) delete process.env.DSH_SESSION_ID
      else process.env.DSH_SESSION_ID = previousSession
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 30_000)


  it('reports an existing live watchdog instead of spawning a second', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    try {
      const startCmd = `"${process.execPath}" -e "require('http').createServer().listen(${port},'127.0.0.1')"`
      const first = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', join(env.home, 'state'), '--repo', repo],
        first.io,
      )).toBe(0)
      const pidfile = join(env.home, 'state', 'watchdog.pid')
      const deadline = Date.now() + 10_000
      while (!existsSync(pidfile) && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 200) })
      }
      const second = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', join(env.home, 'state'), '--repo', repo],
        second.io,
      )).toBe(0)
      expect(second.out.join('')).toContain('already supervised')
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  })

  it('the supervised instance starts without the watchdog\'s WD_* supervision environment', async () => {
    // The watchdog spawns the instance with its own environment: every WD_*
    // (the CLI's explicit WD_PORT/WD_HOME/WD_STATE_DIR/WD_START, plus ambient
    // leaks from a caller inside another supervised instance) must be scrubbed
    // at launch, or they land in every shell the instance hosts.
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    const dump = join(env.home, 'instance-env.txt')
    const previousProbe = process.env.WD_PROBE_LEAK
    process.env.WD_PROBE_LEAK = 'must-not-reach-the-instance'
    try {
      const startCmd = `env > '${dump}'; "${process.execPath}" -e "require('http').createServer().listen(${port},'127.0.0.1')"`
      const first = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', join(env.home, 'state'), '--repo', repo],
        first.io,
      )).toBe(0)
      // The dump is written before the server starts listening.
      await waitForPort(port)
      const leaked = readFileSync(dump, 'utf8').split('\n').filter(line => line.startsWith('WD_'))
      expect(leaked).toEqual([])
    } finally {
      if (previousProbe === undefined) delete process.env.WD_PROBE_LEAK
      else process.env.WD_PROBE_LEAK = previousProbe
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 30_000)

  it('reconfigure transfers supervision before stopping the old host and settles the target receipt', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const oldStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('old-host')).listen(${port},'127.0.0.1')"`
    const targetStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('target-host')).listen(${port},'127.0.0.1')"`
    try {
      expect(await runCli([
        'supervise', '--port', String(port), '--start', oldStart,
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      await waitForPort(port)
      expect(await fetchBody(port)).toBe('old-host')
      await waitForCondition(
        'initial previous watchdog to finish its healthy boot',
        () => lastGoodBootRevision(stateDir) === currentHead(repo),
        30_000,
      )
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)).toBe(0)
      stubPreflight('true')
      stubSandboxProbe(false)

      const result = io()
      const previousPath = process.env.PATH
      process.env.PATH = (previousPath ?? '').split(':').filter(entry => entry !== '/usr/sbin').join(':')
      try {
        expect(await runCli([
          'reconfigure', '--start', targetStart,
          '--on-failure', 'restore-previous', '--browser-handoff', 'off',
          '--delay-ms', '3000', '--state-dir', stateDir, '--repo', repo,
          ...boundPreflightArgs(),
        ], result.io)).toBe(0)
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
      }
      expect(result.out.join('')).toContain('replacement watchdog stops the old child')
      const claimed = readCutoverReceipt(stateDir)
      expect(claimed?.supervisor.targetPid).not.toBe(claimed?.supervisor.previousPid)
      expect(claimed?.supervisor.previousStartToken).toMatch(/^(darwin|linux|posix):/)
      expect(claimed?.supervisor.targetDriverStartToken).toMatch(/^(darwin|linux|posix):/)
      expect(claimed?.supervisor.targetStartToken).toMatch(/^(darwin|linux|posix):/)
      expect(claimed?.ownership.previous.childPid).not.toBe(claimed?.supervisor.previousPid)
      expect(claimed?.ownership.previous.childPid).not.toBe(claimed?.ownership.previous.listenerPid)
      expect(claimed?.ownership.previous.childStartToken).not.toBe('')
      expect(claimed?.ownership.previous.listenerStartToken).not.toBe('')
      // The new watchdog owns the pidfile, but its grace window keeps the old
      // host continuously available until the committed successor stops it.
      expect(await fetchBody(port)).toBe('old-host')

      try {
        await waitForCondition(
          'successful reconfigure target to settle its ready receipt',
          () => readCutoverReceipt(stateDir)?.phase === 'ready',
          60_000,
          200,
        )
      } catch (error) {
        const receipt = readCutoverReceipt(stateDir)
        const logFile = join(stateDir, STATE_FILES.watchdogLog)
        const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '<watchdog log absent>'
        throw new Error(`${String(error)}\n${JSON.stringify(receipt, null, 2)}\n${log.slice(-12000)}`)
      }
      const settledReceipt = readCutoverReceipt(stateDir)
      const cutoverLog = readFileSync(join(stateDir, STATE_FILES.watchdogLog), 'utf8')
      expect(settledReceipt?.phase, `${JSON.stringify(settledReceipt, null, 2)}\n${cutoverLog.slice(-12000)}`).toBe('ready')
      expect(await fetchBody(port)).toBe('target-host')
      expect(settledReceipt, `cutover did not settle; marker=${existsSync(join(stateDir, STATE_FILES.restartRequested))}\n${cutoverLog.slice(-8000)}`).toMatchObject({
        phase: 'ready',
        preflight: {
          surface: 'built', candidateProbe: 'pass', composition: 'pass',
          candidateProbeProvenance: 'caller-supplied',
          targetCommandSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          runnerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        authentication: { transportStatus: 200, browserHandoff: 'off' },
        readiness: { role: 'target', stableWindowMs: 3000, retryCount: 0 },
        canary: { outcome: 'pass' },
        recovery: { result: 'not-needed' },
      })
      expect(settledReceipt?.ownership.target?.childPid).toBe(settledReceipt?.child.targetPid)
      expect(settledReceipt?.ownership.target?.listenerPid).toBeGreaterThan(0)
      expect(processIdentityMatches({
        pid: settledReceipt!.ownership.previous.childPid,
        startToken: settledReceipt!.ownership.previous.childStartToken,
      })).toBe(false)
      expect(processIdentityMatches({
        pid: settledReceipt!.ownership.previous.listenerPid,
        startToken: settledReceipt!.ownership.previous.listenerStartToken,
      })).toBe(false)
      expect(readLaunchState(stateDir)).toMatchObject({ mode: 'stable', active: { command: targetStart } })
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 120_000)

  it('settles a protected previous-watchdog → candidate-watchdog cutover only after page acknowledgement', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const oldStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('old-protected-cutover-host')).listen(${port},'127.0.0.1')"`
    const targetFixture = join(env.home, 'protected-ack-target.cjs')
    writeFileSync(targetFixture, `
const fs = require('fs')
const http = require('http')
const path = require('path')
const port = Number(process.argv[2])
const stateDir = process.argv[3]
const grant = 'final-' + process.pid + '-' + Date.now()
let armed = false
let acknowledged = false
const writeAtomic = (file, value) => {
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value) + '\\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + port)
  if (url.searchParams.get('grant') === grant) {
    res.writeHead(303, { location: '/', 'set-cookie': 'guard-session=ready; Path=/; HttpOnly' })
    res.end()
  } else if ((req.headers.cookie || '').includes('guard-session=ready')) {
    res.end('protected-target')
  } else {
    res.statusCode = 401
    res.end('authentication required')
  }
}).listen(port, '127.0.0.1', () => {
  console.log('http://127.0.0.1:' + port + '/?grant=' + grant)
})
const timer = setInterval(() => {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(stateDir, 'launch-cutover.json'), 'utf8'))
    if (!armed) {
      writeAtomic(path.join(stateDir, 'browser-handoff-request.json'), {
        version: 2,
        cutoverId: receipt.id,
        registrations: [{
          authority: '127.0.0.1:' + port,
          capabilitySha256: 'a'.repeat(64),
          armedAt: Date.now(),
        }],
      })
      armed = true
    }
    const ownership = receipt.ownership && receipt.ownership.target
    if (!acknowledged && receipt.canary && receipt.canary.outcome === 'pass'
      && receipt.readiness && receipt.readiness.role === 'target'
      && ownership && ownership.listenerPid === process.pid) {
      writeAtomic(path.join(stateDir, 'browser-handoff-ack.json'), {
        version: 1,
        cutoverId: receipt.id,
        role: 'target',
        authority: '127.0.0.1:' + port,
        listenerPid: ownership.listenerPid,
        listenerStartToken: ownership.listenerStartToken,
        channel: 'original-tab',
        authentication: 'launch-url',
        acknowledgedAt: Date.now(),
      })
      acknowledged = true
      clearInterval(timer)
    }
  } catch {}
}, 20)
`)
    const targetStart = `"${process.execPath}" ${JSON.stringify(targetFixture)} ${port} ${JSON.stringify(stateDir)}`
    try {
      expect(await runCli([
        'supervise', '--port', String(port), '--start', oldStart,
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      await waitForPort(port)
      expect(await runCli([
        'record', 'build', '--trust-command', '--command', 'test fixture',
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      stubPreflight('true')
      stubSandboxProbe(false)
      expect(await runCli([
        'reconfigure', '--start', targetStart,
        '--on-failure', 'restore-previous', '--browser-handoff', 'required',
        '--delay-ms', '200', '--state-dir', stateDir, '--repo', repo,
        ...boundPreflightArgs(),
      ], io().io)).toBe(0)

      const deadline = Date.now() + 30_000
      while (readCutoverReceipt(stateDir)?.phase !== 'ready' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const receipt = readCutoverReceipt(stateDir)
      const log = readFileSync(join(stateDir, STATE_FILES.watchdogLog), 'utf8')
      expect(receipt?.phase, `${JSON.stringify(receipt, null, 2)}\n${log.slice(-12000)}`).toBe('ready')
      expect(receipt).toMatchObject({
        readiness: { role: 'target', retryCount: 0 },
        browserHandoff: {
          required: true,
          status: 'acknowledged',
          channel: 'original-tab',
          authentication: 'launch-url',
          authority: `127.0.0.1:${port}`,
        },
        authentication: { transportStatus: 401, browserHandoff: 'acknowledged' },
        canary: { outcome: 'pass' },
        recovery: { result: 'not-needed' },
      })
      const eventKinds = receipt?.events.map(event => event.kind) ?? []
      expect(eventKinds.indexOf('canary')).toBeLessThan(eventKinds.indexOf('browser-handoff'))
      expect(eventKinds.indexOf('browser-handoff')).toBeLessThan(eventKinds.indexOf('ready'))
      expect(receipt?.events.some(event => event.kind === 'browser-fallback-opened')).toBe(false)
      expect(log).toContain('original browser tab acknowledged handoff')
      expect(log).not.toContain('?grant=')
      expect(readFileSync(join(stateDir, STATE_FILES.launchCutover), 'utf8')).not.toContain('?grant=')
      expect(await fetchStatus(port)).toBe(401)
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 45_000)

  it('bounds a hung previous watchdog, consumes restore while waiting, and retires only its frozen identity', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const previousStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('previous-after-hung-supervisor')).listen(${port},'127.0.0.1')"`
    const targetStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('target-must-not-start')).listen(${port},'127.0.0.1')"`
    let previousSupervisor: ReturnType<typeof processIdentity> = null
    try {
      expect(await runCli([
        'supervise', '--port', String(port), '--start', previousStart,
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      await waitForPort(port)
      const previousPid = Number(readFileSync(join(stateDir, STATE_FILES.watchdogPid), 'utf8'))
      previousSupervisor = processIdentity(previousPid)
      expect(previousSupervisor).not.toBeNull()
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)).toBe(0)
      stubPreflight('true')
      stubSandboxProbe(false)

      // Establish the wedged-previous precondition before the successor can
      // retire it. The previous host is a separate child and keeps serving;
      // the successor must still claim supervision, consume restore while it
      // waits, and retire exactly this frozen identity after the bound yield.
      expect(freezeFixtureIdentity(previousSupervisor!)).toBe('frozen')
      expect(await fetchBody(port)).toBe('previous-after-hung-supervisor')
      expect(await runCli([
        'reconfigure', '--start', targetStart,
        '--on-failure', 'wait-for-user', '--browser-handoff', 'off',
        '--delay-ms', '200', '--supervisor-yield-timeout-ms', '3000',
        '--state-dir', stateDir, '--repo', repo,
        ...boundPreflightArgs(),
      ], io().io)).toBe(0)

      const logFile = join(stateDir, STATE_FILES.watchdogLog)
      // Claiming supervision and reaching the bounded-yield loop traverses
      // multiple real shell/process observations. A five-second precondition
      // budget raced that progress under the full gate even though the
      // production 3 s yield bound itself had not started yet.
      await waitForCondition(
        'replacement watchdog to enter the bounded previous-supervisor yield',
        () => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('waiting up to 3000ms'),
        30_000,
        50,
      )
      expect(readFileSync(logFile, 'utf8')).toContain('waiting up to 3000ms')
      expect(await fetchBody(port)).toBe('previous-after-hung-supervisor')
      expect(await runCli(['restore-previous', '--state-dir', stateDir], io().io)).toBe(0)

      await waitForCondition(
        'hung-previous cutover to restore the previous launch',
        () => readCutoverReceipt(stateDir)?.phase === 'restored',
        60_000,
      )
      const receipt = readCutoverReceipt(stateDir)
      expect(receipt?.phase, `${JSON.stringify(receipt, null, 2)}\n${readFileSync(logFile, 'utf8').slice(-12000)}`).toBe('restored')
      expect(receipt).toMatchObject({
        supervisor: { previousPid, previousRetirement: 'forced' },
        failureCount: { target: 0, previous: 0 },
        readiness: { role: 'previous', retryCount: 0 },
        recovery: { result: 'restored' },
      })
      expect(receipt?.attempts.some(attempt => attempt.role === 'target')).toBe(false)
      expect(receipt?.events.some(event => event.kind === 'control-requested' && event.detail === 'restore-previous')).toBe(true)
      expect(processIdentityMatches(previousSupervisor!)).toBe(false)
      expect(await fetchBody(port)).toBe('previous-after-hung-supervisor')
    } finally {
      if (previousSupervisor !== null && processIdentityMatches(previousSupervisor)) {
        signalProcessIdentity(previousSupervisor, 'SIGKILL')
      }
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 90_000)

  it('reconfigure restores the complete previous spec after target readiness failures', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const previousStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('previous-restored')).listen(${port},'127.0.0.1')"`
    const brokenTarget = `"${process.execPath}" -e "process.stderr.write('target boot failed\\n'); process.exit(1)"`
    try {
      expect(await runCli([
        'supervise', '--port', String(port), '--start', previousStart,
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      await waitForPort(port)
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)).toBe(0)
      stubPreflight('true')
      stubSandboxProbe(false)
      expect(await runCli([
        'reconfigure', '--start', brokenTarget,
        '--on-failure', 'restore-previous', '--browser-handoff', 'off',
        '--delay-ms', '500', '--state-dir', stateDir, '--repo', repo,
        ...boundPreflightArgs(),
      ], io().io)).toBe(0)

      await waitForCondition(
        'failed reconfigure target to restore the complete previous launch spec',
        () => readCutoverReceipt(stateDir)?.phase === 'restored',
        60_000,
        200,
      )
      expect(await fetchBody(port)).toBe('previous-restored')
      const receipt = readCutoverReceipt(stateDir)
      expect(receipt).toMatchObject({
        phase: 'restored',
        recovery: { policy: 'restore-previous', result: 'restored' },
      })
      expect(receipt?.attempts.filter(attempt => attempt.role === 'target').length).toBe(2)
      expect(receipt?.attempts.some(attempt => attempt.role === 'previous' && attempt.outcome === 'ready')).toBe(true)
      expect(readLaunchState(stateDir)).toMatchObject({ mode: 'stable', active: { command: previousStart } })
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 90_000)

  it('applies a live-home transition only after takeover and rolls it back before restoring previous', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const legacyState = join(env.home, 'storages/session_projcache.json')
    const targetState = join(env.home, 'storages/session_projcache')
    mkdirSync(join(env.home, 'storages'), { recursive: true })
    writeFileSync(legacyState, 'previous-version-3')
    const previousStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('previous-with-v3')).listen(${port},'127.0.0.1')"`
    const failingTarget = join(env.home, 'target-writes-v5.cjs')
    writeFileSync(failingTarget, `
const fs = require('fs')
const path = ${JSON.stringify(join(targetState, 'sessions/rebuilt.json'))}
fs.mkdirSync(require('path').dirname(path), { recursive: true })
fs.writeFileSync(path, 'rejected-target-version-5')
process.stderr.write('target boot failed after writing v5\\n')
process.exit(1)
`)
    const transitionFile = join(env.home, 'transition-plan.json')
    writeFileSync(transitionFile, `${JSON.stringify({
      schemaVersion: 1,
      home: env.home,
      operations: [
        { kind: 'quarantine', path: 'storages/session_projcache.json', expect: 'present' },
        { kind: 'quarantine', path: 'storages/session_projcache', expect: 'absent' },
      ],
    }, null, 2)}\n`)
    try {
      expect(await runCli([
        'supervise', '--port', String(port), '--start', previousStart,
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      await waitForPort(port)
      expect(await fetchBody(port)).toBe('previous-with-v3')
      expect(readFileSync(legacyState, 'utf8')).toBe('previous-version-3')
      expect(await runCli([
        'record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      stubPreflight('test ! -e "$DSH_HOME/storages/session_projcache.json"')
      stubSandboxProbe(false)

      const result = io()
      expect(await runCli([
        'reconfigure', '--start', `"${process.execPath}" ${JSON.stringify(failingTarget)}`,
        '--transition-file', transitionFile,
        '--on-failure', 'restore-previous', '--browser-handoff', 'off',
        '--delay-ms', '500', '--state-dir', stateDir, '--repo', repo,
        ...boundPreflightArgs(),
      ], result.io)).toBe(0)
      expect(result.out.join('')).toContain('filesystem transition preflight PASS on an isolated copy')

      await waitForCondition(
        'transition rollback to restore the previous launch',
        () => readCutoverReceipt(stateDir)?.phase === 'restored',
        60_000,
        200,
      )
      const receipt = readCutoverReceipt(stateDir)
      const log = readFileSync(join(stateDir, STATE_FILES.watchdogLog), 'utf8')
      expect(receipt?.phase, `${JSON.stringify(receipt, null, 2)}\n${log.slice(-12000)}`).toBe('restored')
      expect(receipt).toMatchObject({
        transition: { phase: 'rolled-back', operationCount: 2 },
        recovery: { policy: 'restore-previous', result: 'restored' },
      })
      expect(receipt?.events.filter(event => event.kind === 'transition').map(event => event.detail)).toEqual([
        expect.stringMatching(/^applied [a-f0-9]{64}$/),
        expect.stringMatching(/^rolled-back [a-f0-9]{64}$/),
      ])
      expect(await fetchBody(port)).toBe('previous-with-v3')
      expect(readFileSync(legacyState, 'utf8')).toBe('previous-version-3')
      expect(readFileSync(join(
        stateDir, 'launch-transitions', receipt!.id,
        'rejected-target/storages/session_projcache/sessions/rebuilt.json',
      ), 'utf8')).toBe('rejected-target-version-5')
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 90_000)

  it('does not accept a stale 200 when the target reports EADDRINUSE, and counts failures before restoring previous', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const releaseStale = join(env.home, 'release-stale-listener')
    const previousProgram = `const fs=require('fs');const server=require('http').createServer((q,s)=>s.end('previous-after-eaddr'));server.on('error',error=>{fs.writeFileSync(${JSON.stringify(releaseStale)},'release');throw error});server.listen(${port},'127.0.0.1')`
    const previousStart = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(previousProgram)}`
    const staleServer = join(env.home, 'stale-listener.cjs')
    writeFileSync(staleServer, `const fs=require('fs');const server=require('http').createServer((q,s)=>s.end('stale-old-listener-200'));server.listen(${port},'127.0.0.1');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseStale)})){clearInterval(timer);server.close(()=>process.exit(0))}},25);setTimeout(()=>server.close(()=>process.exit(0)),10000)\n`)
    const orphanLauncher = join(env.home, 'orphan-listener.cjs')
    writeFileSync(orphanLauncher, `const {spawn}=require('child_process');const child=spawn(process.execPath,[${JSON.stringify(staleServer)}],{detached:true,stdio:'ignore'});child.unref()\n`)
    const targetScript = join(env.home, 'target-eaddr.sh')
    writeFileSync(targetScript, `#!/bin/bash
"${process.execPath}" "${orphanLauncher}"
sleep 0.2
"${process.execPath}" -e "require('http').createServer().listen(${port},'127.0.0.1')" || true
printf 'EADDRINUSE :${port}\\n' >&2
sleep 0.6
exit 1
`)
    chmodSync(targetScript, 0o700)
    try {
      expect(await runCli([
        'supervise', '--port', String(port), '--start', previousStart,
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      await waitForPort(port)
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)).toBe(0)
      stubPreflight('true')
      stubSandboxProbe(false)
      expect(await runCli([
        'reconfigure', '--start', `/bin/bash ${JSON.stringify(targetScript)}`,
        '--on-failure', 'restore-previous', '--browser-handoff', 'off',
        '--delay-ms', '200', '--state-dir', stateDir, '--repo', repo,
        ...boundPreflightArgs(),
      ], io().io)).toBe(0)

      const deadline = Date.now() + 35_000
      while (readCutoverReceipt(stateDir)?.phase !== 'restored' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      expect(await fetchBody(port)).toBe('previous-after-eaddr')
      const receipt = readCutoverReceipt(stateDir)
      const targetAttempts = receipt?.attempts.filter(attempt => attempt.role === 'target') ?? []
      expect(targetAttempts).toHaveLength(2)
      expect(targetAttempts.every(attempt => attempt.outcome === 'failed')).toBe(true)
      expect(receipt).toMatchObject({ phase: 'restored', failureCount: { target: 2, previous: 1 }, recovery: { result: 'restored' } })
      expect(receipt?.ownership.target).toBeUndefined()
      const log = readFileSync(join(stateDir, STATE_FILES.watchdogLog), 'utf8')
      expect(log).toContain(`cutover target hit EADDRINUSE on :${port}`)
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 45_000)

  it('rejects a target that exits after authenticated 200 without handing its URL to the browser, then restores previous', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const previousStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('previous-after-short-ready')).listen(${port},'127.0.0.1')"`
    const shortTargetFixture = join(env.home, 'short-protected-target.cjs')
    writeFileSync(shortTargetFixture, `
const http = require('http')
const grant = 'short-' + process.pid
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:${port}')
  if (url.searchParams.get('grant') === grant) {
    res.statusCode = 303
    res.setHeader('location', '/')
    res.setHeader('set-cookie', 'short-ready=yes; Path=/; HttpOnly')
    res.end()
  } else if ((req.headers.cookie || '').includes('short-ready=yes')) {
    res.statusCode = 200
    res.end('short-target')
  } else {
    res.statusCode = 401
    res.end('authentication required')
  }
}).listen(${port}, '127.0.0.1', () => console.log('http://127.0.0.1:${port}/?grant=' + grant))
setTimeout(() => process.exit(23), 1800)
`)
    const shortTarget = `"${process.execPath}" ${JSON.stringify(shortTargetFixture)}`
    const handoffFile = join(env.home, 'rejected-target-handoff.txt')
    const opener = join(env.home, 'rejected-target-open.sh')
    writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(handoffFile)}\n`)
    chmodSync(opener, 0o700)
    try {
      expect(await runCli([
        'supervise', '--port', String(port), '--start', previousStart,
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      await waitForPort(port)
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)).toBe(0)
      stubPreflight('true')
      stubSandboxProbe(false)
      const previousOpenCommand = process.env.WD_BROWSER_OPEN_COMMAND
      process.env.WD_BROWSER_OPEN_COMMAND = opener
      try {
        expect(await runCli([
          'reconfigure', '--start', shortTarget,
          '--on-failure', 'restore-previous', '--browser-handoff', 'required',
          '--delay-ms', '200', '--state-dir', stateDir, '--repo', repo,
          ...boundPreflightArgs(),
        ], io().io)).toBe(0)
      } finally {
        if (previousOpenCommand === undefined) delete process.env.WD_BROWSER_OPEN_COMMAND
        else process.env.WD_BROWSER_OPEN_COMMAND = previousOpenCommand
      }

      const deadline = Date.now() + 50_000
      while (readCutoverReceipt(stateDir)?.phase !== 'restored' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      expect(await fetchBody(port)).toBe('previous-after-short-ready')
      const receipt = readCutoverReceipt(stateDir)
      const log = readFileSync(join(stateDir, STATE_FILES.watchdogLog), 'utf8')
      expect(receipt, `${JSON.stringify(receipt, null, 2)}\n${log.slice(-12000)}`).toMatchObject({
        phase: 'restored', recovery: { result: 'restored' },
      })
      expect(receipt?.attempts.filter(attempt => attempt.role === 'target')).toHaveLength(2)
      expect(receipt?.attempts.some(attempt => attempt.role === 'target' && attempt.outcome === 'ready')).toBe(false)
      expect(receipt?.readiness?.role).toBe('previous')
      expect(receipt?.authentication.browserHandoff).toBe('not-required')
      expect(existsSync(handoffFile)).toBe(false)
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 65_000)

  it('restore-previous interrupts an in-flight target and overrides a recorded wait-for-user policy', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const previousStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('previous-after-operator-restore')).listen(${port},'127.0.0.1')"`
    const pendingTarget = `"${process.execPath}" -e "require('http').createServer((q,s)=>{s.statusCode=503;s.end('target-not-ready')}).listen(${port},'127.0.0.1')"`
    try {
      expect(await runCli([
        'supervise', '--port', String(port), '--start', previousStart,
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      await waitForPort(port)
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)).toBe(0)
      stubPreflight('true')
      stubSandboxProbe(false)
      expect(await runCli([
        'reconfigure', '--start', pendingTarget,
        '--on-failure', 'wait-for-user', '--browser-handoff', 'off',
        '--delay-ms', '200', '--state-dir', stateDir, '--repo', repo,
        ...boundPreflightArgs(),
      ], io().io)).toBe(0)
      const targetDeadline = Date.now() + 15_000
      while (readCutoverReceipt(stateDir)?.phase !== 'target-starting' && Date.now() < targetDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(readCutoverReceipt(stateDir)?.phase).toBe('target-starting')
      const restore = io()
      expect(await runCli(['restore-previous', '--state-dir', stateDir], restore.io)).toBe(0)
      expect(restore.out.join('')).toContain('explicit restore-previous requested')

      const deadline = Date.now() + 25_000
      while (readCutoverReceipt(stateDir)?.phase !== 'restored' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      const lifecycleReceipt = readCutoverReceipt(stateDir)
      const lifecycleLog = readFileSync(join(stateDir, STATE_FILES.watchdogLog), 'utf8')
      expect(lifecycleReceipt?.phase, `${JSON.stringify(lifecycleReceipt, null, 2)}\n${lifecycleLog.slice(-12000)}`).toBe('restored')
      expect(await fetchBody(port)).toBe('previous-after-operator-restore')
      const receipt = lifecycleReceipt
      expect(receipt).toMatchObject({
        phase: 'restored',
        recovery: { policy: 'wait-for-user', result: 'restored' },
      })
      expect(receipt?.events.some(event => event.kind === 'control-requested' && event.detail === 'restore-previous')).toBe(true)
      expect(readCutoverControl(stateDir)).toBeNull()
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 45_000)

  it('abort-cutover applies the recorded wait-for-user policy and parks without declaring target ready', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const previousStart = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('previous-before-abort')).listen(${port},'127.0.0.1')"`
    const pendingTarget = `"${process.execPath}" -e "require('http').createServer((q,s)=>{s.statusCode=503;s.end('target-not-ready')}).listen(${port},'127.0.0.1')"`
    try {
      expect(await runCli([
        'supervise', '--port', String(port), '--start', previousStart,
        '--state-dir', stateDir, '--repo', repo,
      ], io().io)).toBe(0)
      await waitForPort(port)
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--state-dir', stateDir, '--repo', repo], io().io)).toBe(0)
      stubPreflight('true')
      stubSandboxProbe(false)
      expect(await runCli([
        'reconfigure', '--start', pendingTarget,
        '--on-failure', 'wait-for-user', '--browser-handoff', 'off',
        '--delay-ms', '200', '--state-dir', stateDir, '--repo', repo,
        ...boundPreflightArgs(),
      ], io().io)).toBe(0)
      const targetDeadline = Date.now() + 15_000
      while (readCutoverReceipt(stateDir)?.phase !== 'target-starting' && Date.now() < targetDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const abort = io()
      expect(await runCli(['abort-cutover', '--state-dir', stateDir], abort.io)).toBe(0)
      expect(abort.out.join('')).toContain('apply the pre-approved wait-for-user policy')

      const deadline = Date.now() + 15_000
      while (readCutoverReceipt(stateDir)?.phase !== 'awaiting-user' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      expect(readCutoverReceipt(stateDir)).toMatchObject({
        phase: 'awaiting-user', recovery: { policy: 'wait-for-user', result: 'waiting-for-user' },
      })
      // The durable receipt is intentionally written before the crash page is
      // spawned. Wait for the presentation side instead of assuming the state
      // rename and socket bind are one atomic operation.
      let parkedStatus: number | undefined
      const pageDeadline = Date.now() + 5_000
      while (Date.now() < pageDeadline) {
        try {
          parkedStatus = await fetchStatus(port)
          if (parkedStatus === 503) break
        } catch { /* receipt is durable; the page bind follows */ }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(parkedStatus).toBe(503)
      expect(readCutoverReceipt(stateDir)?.attempts.some(attempt => attempt.role === 'target' && attempt.outcome === 'ready')).toBe(false)
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 40_000)

  it('a foreground supervisor waiting behind a cutover reloads restored previous state before takeover', async () => {
    const env = supervisedEnv()
    const stateDir = join(env.home, 'state')
    const port = await freePort()
    const previousRepo = makeRepo()
    const targetRepo = makeRepo()
    const previousHarness = tmpDir('guard-waiter-previous-host-')
    const targetHarness = tmpDir('guard-waiter-target-host-')
    const previousMarker = join(env.home, 'previous-started.txt')
    const targetMarker = join(env.home, 'target-started.txt')
    const hostCommand = (marker: string, body: string): string => {
      const program = `const fs=require('fs'),http=require('http');fs.writeFileSync(${JSON.stringify(marker)},process.env.DSH_HARNESS||'');http.createServer((q,s)=>s.end(${JSON.stringify(body)})).listen(${port},'127.0.0.1')`
      return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`
    }
    const previous: LaunchSpec = {
      version: 1,
      command: hostCommand(previousMarker, 'previous-after-wait'),
      port,
      home: env.home,
      credentialRepo: previousRepo,
      harnessRoot: previousHarness,
      profile: 'web',
    }
    const target: LaunchSpec = {
      ...previous,
      command: hostCommand(targetMarker, 'rejected-target'),
      credentialRepo: targetRepo,
      harnessRoot: targetHarness,
    }
    const successor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    const waiterOutput = io()
    let waiter: Promise<number> | undefined
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, STATE_FILES.watchdogPid), String(successor.pid))
      prepareLaunchCutover(stateDir, {
        id: 'waiter-refresh-cutover', previous, target,
        recoveryPolicy: 'restore-previous', browserHandoff: 'off',
        previousSupervisorPid: successor.pid!, previousSupervisorStartToken: 'successor-start', previousOwnership: fakeOwnership(successor.pid!), now: NOW,
      })

      // This models launchd/systemd restarting its stable foreground launcher
      // while the cutover successor owns supervision. It initially observes
      // selected target, then waits behind that live owner.
      waiter = runCli(['supervise', '--foreground', '--state-dir', stateDir], waiterOutput.io)
      const waitingDeadline = Date.now() + 5_000
      while (!waiterOutput.out.join('').includes('waiting for it to exit') && Date.now() < waitingDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(waiterOutput.out.join('')).toContain('waiting for it to exit')

      recordCutoverEvent(stateDir, 'waiter-refresh-cutover', 'restoring', ['target rejected'], NOW + 1)
      recordCutoverEvent(stateDir, 'waiter-refresh-cutover', 'child-started', ['previous', '1', String(successor.pid), 'waiter-previous-start'], NOW + 2)
      recordCutoverEvent(stateDir, 'waiter-refresh-cutover', 'ownership-stable', ['previous', String(successor.pid), 'waiter-previous-start', String(successor.pid), 'waiter-listener-start', '3000', '0'], NOW + 3)
      recordCutoverEvent(stateDir, 'waiter-refresh-cutover', 'canary', ['pass'], NOW + 4)
      recordCutoverEvent(stateDir, 'waiter-refresh-cutover', 'ready', ['previous'], NOW + 5)
      lifecycle.signalExact(successor, 'SIGTERM')

      const previousDeadline = Date.now() + 15_000
      while (!existsSync(previousMarker) && Date.now() < previousDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(readFileSync(previousMarker, 'utf8')).toBe(previousHarness)
      expect(existsSync(targetMarker)).toBe(false)
      await waitForPort(port)
      expect(await fetchBody(port)).toBe('previous-after-wait')
      expect(readLaunchState(stateDir)).toMatchObject({
        mode: 'stable',
        active: { command: previous.command, credentialRepo: previousRepo, harnessRoot: previousHarness },
      })
      expect(waiterOutput.out.join('')).toContain('launch state refreshed after wait')
    } finally {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, STATE_FILES.watchdogStop), '')
      await killListener(port)
      if (waiter !== undefined) await Promise.race([waiter, new Promise<number>(resolve => setTimeout(() => resolve(-1), 3_000))])
      env.stop()
      env.restore()
    }
  }, 30_000)

  it('treats naked 401 as transport-up and requires launch URL → 303 → cookie 200 for server readiness', async () => {
    const home = tmpDir('guard-auth-ready-')
    const repo = makeRepo()
    const stateDir = join(home, 'state')
    mkdirSync(join(home, 'home'), { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const port = await freePort()
    const hostFixture = join(home, 'protected-host.cjs')
    writeFileSync(hostFixture, `
const http = require('http')
const port = Number(process.argv[2])
const grant = 'process-' + process.pid + '-' + Date.now()
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + port)
  if (url.searchParams.get('grant') === grant) {
    res.statusCode = 303
    res.setHeader('location', '/')
    res.setHeader('set-cookie', 'guard-session=ready; Path=/; HttpOnly')
    res.end()
    return
  }
  if ((req.headers.cookie || '').includes('guard-session=ready')) {
    res.statusCode = 200
    res.end('authenticated')
    return
  }
  res.statusCode = 401
  res.end('authentication required')
})
server.listen(port, '127.0.0.1', () => {
  console.log('host launch: http://127.0.0.1:' + port + '/?grant=' + grant)
})
`)
    const script = fileURLToPath(new URL('../scripts/dsh-watchdog.sh', import.meta.url))
    let output = ''
    const watchdog = spawn('bash', [script, '--supervise'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: watchdogEnv({
        WD_HOME: home,
        WD_STATE_DIR: stateDir,
        WD_PORT: String(port),
        WD_REPO: repo,
        WD_START: `${JSON.stringify(process.execPath)} ${JSON.stringify(hostFixture)} ${port}`,
        WD_BOOT_TIMEOUT: '10',
        WD_BROWSER_HANDOFF: 'off',
      }),
    })
    watchdog.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    watchdog.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    try {
      const deadline = Date.now() + 20_000
      while (!output.includes('instance ready') && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 100) })
      }
      expect(output).toContain(`transport up on :${port} (HTTP 401)`)
      expect(output).toContain('instance ready')
      expect(await fetchStatus(port)).toBe(401)
      const attempt = readFileSync(join(stateDir, STATE_FILES.bootAttemptLog), 'utf8')
      expect(attempt).toContain('[launch-url-redacted]')
      expect(attempt).not.toContain('?grant=')
      expect(output).not.toContain('?grant=')
    } finally {
      await killListener(port)
    }
  }, 30_000)

  it('does not treat a successful system opener as browser acknowledgement', async () => {
    const home = tmpDir('guard-browser-no-ack-')
    const repo = makeRepo()
    const stateDir = join(home, 'state')
    mkdirSync(stateDir, { recursive: true })
    const port = await freePort()
    const hostFixture = join(home, 'protected-no-ack.cjs')
    writeFileSync(hostFixture, `
const http = require('http')
const port = Number(process.argv[2])
const grant = 'attempt-' + process.pid
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + port)
  if (url.searchParams.get('grant') === grant) {
    res.writeHead(303, { location: '/', 'set-cookie': 'guard-session=ready; Path=/; HttpOnly' })
    res.end()
  } else if ((req.headers.cookie || '').includes('guard-session=ready')) {
    res.end('authenticated')
  } else {
    res.statusCode = 401
    res.end('authentication required')
  }
}).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port + '/?grant=' + grant))
`)
    const opened = join(home, 'open-returned-zero')
    const opener = join(home, 'browser-open.sh')
    writeFileSync(opener, `#!/bin/sh\nprintf opened > ${JSON.stringify(opened)}\n`)
    chmodSync(opener, 0o700)
    const cutoverId = 'cutover-browser-no-ack'
    const targetCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(hostFixture)} ${port}`
    const previous = {
      version: 1, command: 'previous-host', port, home,
      credentialRepo: repo, harnessRoot: home, profile: 'web',
    } satisfies LaunchSpec
    prepareLaunchCutover(stateDir, {
      id: cutoverId,
      previous,
      target: { ...previous, command: targetCommand },
      recoveryPolicy: 'wait-for-user',
      browserHandoff: 'required',
      previousSupervisorPid: 999_998,
      previousSupervisorStartToken: 'gone-supervisor',
      previousOwnership: {
        childPid: 999_999,
        childStartToken: 'gone-child',
        listenerPid: 999_999,
        listenerStartToken: 'gone-listener',
      },
    })
    recordCredential(stateDir, {
      scope: 'build+test', revision: currentHead(repo)!, command: 'test fixture',
    }, Date.now())
    const script = fileURLToPath(new URL('../scripts/dsh-watchdog.sh', import.meta.url))
    let output = ''
    const watchdog = spawn('bash', [script, '--supervise'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: watchdogEnv({
        WD_HOME: home,
        WD_STATE_DIR: stateDir,
        WD_PORT: String(port),
        WD_REPO: repo,
        WD_HARNESS_ROOT: home,
        WD_START: targetCommand,
        WD_BOOT_TIMEOUT: '10',
        WD_BROWSER_HANDOFF: 'required',
        WD_BROWSER_HANDOFF_TIMEOUT_SECONDS: '1',
        WD_BROWSER_OPEN_COMMAND: opener,
        WD_CUTOVER_ID: cutoverId,
        WD_CUTOVER_POLICY: 'wait-for-user',
        WD_CUTOVER_ROLE: 'target',
        WD_PREVIOUS_START: previous.command,
        WD_PREVIOUS_HOME: previous.home,
        WD_PREVIOUS_REPO: previous.credentialRepo,
        WD_PREVIOUS_HARNESS_ROOT: previous.harnessRoot,
        WD_PREVIOUS_PROFILE: previous.profile,
        WD_PREVIOUS_CHILD_PID: '999999',
        WD_PREVIOUS_CHILD_START: 'gone-child',
        WD_PREVIOUS_LISTENER_PID: '999999',
        WD_PREVIOUS_LISTENER_START: 'gone-listener',
        WD_GUARD: `${process.execPath} ${fileURLToPath(new URL('../lib/cli.js', import.meta.url))}`,
      }),
    })
    watchdog.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    watchdog.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    try {
      await waitForCondition('the browser handoff failure output', () => output.includes('no page acknowledgement'), 30_000)
      await waitForCondition('the terminal awaiting-user receipt', () => readCutoverReceipt(stateDir)?.phase === 'awaiting-user', 30_000, 50)
      expect(existsSync(opened), output).toBe(true)
      expect(output).toContain('browser fallback open requested')
      expect(output).toContain('browser handoff failed: no page acknowledgement')
      expect(output).toContain('instance ready')
      expect(readCutoverReceipt(stateDir)).toMatchObject({
        phase: 'awaiting-user',
        canary: { outcome: 'pass' },
        browserHandoff: { status: 'failed' },
        failureCount: { target: 1 },
      })
    } finally {
      await killListener(port)
    }
  }, 75_000)

  it('reclaims a pidfile deleted underneath it, and yields to a live replacement owner', async () => {
    // The state dir cleaned under a RUNNING watchdog must not fork
    // supervision: the watchdog reclaims its claim within one poll; and when
    // the claim is held by another live process it yields instead of fighting.
    const home = tmpDir('guard-heal-')
    mkdirSync(join(home, 'state'), { recursive: true })
    mkdirSync(join(home, 'home'), { recursive: true })
    const script = fileURLToPath(new URL('../scripts/dsh-watchdog.sh', import.meta.url))
    const port = await freePort()
    const wd = spawn('bash', [script, '--supervise'], {
      env: watchdogEnv({ WD_HOME: home, WD_PORT: String(port), WD_TEST_FAKE: '1' }),
      stdio: 'ignore',
      detached: true,
    })
    wd.unref()
    const pidfile = join(home, 'state', 'watchdog.pid')
    const until = async (fn: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (fn()) return true
        await new Promise((resolve) => { setTimeout(resolve, 200) })
      }
      return false
    }
    // Up and claimed.
    expect(await until(() => existsSync(pidfile) && readFileSync(pidfile, 'utf8').trim() === String(wd.pid), 15_000)).toBe(true)
    // Deleted underneath → reclaimed by the same pid. The reclaim runs once
    // per supervise-loop iteration (~6s in fake-instance mode: spawn + health
    // poll + two sleeps), so the window must absorb a couple of SLOW
    // iterations — a machine running a multi-package deploy gate stretches a
    // single iteration past a tight one.
    unlinkSync(pidfile)
    expect(await until(() => existsSync(pidfile) && readFileSync(pidfile, 'utf8').trim() === String(wd.pid), 25_000)).toBe(true)
    // A live replacement owner → the watchdog yields (exits) rather than fighting.
    writeFileSync(pidfile, String(process.pid))
    expect(await until(() => {
      try { process.kill(wd.pid ?? 0, 0); return false } catch { return true }
    }, 25_000)).toBe(true)
    // ...and its pidfile claim was NOT stolen back or deleted (it names us).
    expect(readFileSync(pidfile, 'utf8').trim()).toBe(String(process.pid))
  }, 45_000)

  it('claims the pidfile atomically — concurrent watchdogs leave exactly one supervisor', async () => {
    // The CLI check above serializes two SEQUENTIAL supervise calls. This
    // covers the script's own claim, which is what a simultaneous start races
    // on: with a check-then-write claim several racers pass the liveness test
    // before any of them writes, and the port ends up with more than one
    // supervisor.
    const home = tmpDir('guard-race-')
    mkdirSync(join(home, 'state'), { recursive: true })
    mkdirSync(join(home, 'home'), { recursive: true })
    const script = fileURLToPath(new URL('../scripts/dsh-watchdog.sh', import.meta.url))
    const port = await freePort()
    // One launcher backgrounding all racers from a single shell: they reach the
    // claim within the same few milliseconds. Spawning them one-by-one from
    // node staggers them by enough process-setup time that the first racer has
    // already written the pidfile, which hides the very race under test.
    const launcher = spawn('bash', ['-c', 'for _ in 1 2 3 4 5 6 7 8; do bash "$0" --supervise >/dev/null 2>&1 & done; wait', script], {
      env: watchdogEnv({ WD_HOME: home, WD_PORT: String(port), WD_TEST_FAKE: '1' }),
      stdio: 'ignore',
    })
    const survivors = (): number[] => {
      try {
        return execFileSync('pgrep', ['-P', String(launcher.pid)], { encoding: 'utf8' })
          .split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 0)
      } catch { return [] } // pgrep exits 1 once every racer but the winner is gone
    }
    // Settle on a STABLE count rather than on the first reading of 1: while the
    // launcher is still forking, `pgrep -P` legitimately reports one racer, and
    // stopping there would pass before the race has even happened.
    const start = Date.now()
    let last = -1
    let unchangedSince = start
    while (Date.now() - start < 20_000) {
      await new Promise((resolve) => { setTimeout(resolve, 500) })
      const count = survivors().length
      if (count !== last) { last = count; unchangedSince = Date.now() }
      else if (Date.now() - unchangedSince >= 2_000 && Date.now() - start >= 3_000) break
    }
    expect(survivors()).toHaveLength(1)
    expect(readFileSync(join(home, 'state', 'watchdog.pid'), 'utf8').trim())
      .toBe(String(survivors()[0]))
  }, 30_000)

  it('give-up parks when the crash page cannot bind — no boot-loop fight, SIGUSR1 re-arms', async () => {
    // Give-up with the port still occupied is the COMMON shape (the boot
    // failures were often EADDRINUSE themselves). The crash page's listen must
    // survive it: pre-fix the page died on an unhandled 'error' event, the
    // watchdog's `wait` returned, and the boot loop resumed — fighting the
    // healthy occupant the watchdog had just given up against (observed in an
    // e2e rig, 2026-08-30: give-up → page crash → more boot attempts, the
    // occupant killed on every pass).
    const home = tmpDir('guard-giveup-')
    mkdirSync(join(home, 'state'), { recursive: true })
    mkdirSync(join(home, 'home'), { recursive: true })
    const script = fileURLToPath(new URL('../scripts/dsh-watchdog.sh', import.meta.url))
    const port = await freePort()
    const wdLog = join(home, 'state', 'watchdog.log')
    const wd = spawn('bash', [script, '--supervise'], {
      env: watchdogEnv({ WD_HOME: home, WD_PORT: String(port), WD_TEST_BREAK: '1' }),
      stdio: ['ignore', openSync(wdLog, 'a'), openSync(wdLog, 'a')],
      detached: true,
    })
    wd.unref()
    const attempts = (): number => (readFileSync(wdLog, 'utf8').match(/starting instance/g) ?? []).length
    const until = async (fn: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (fn()) return true
        await new Promise((resolve) => { setTimeout(resolve, 200) })
      }
      return false
    }
    // The port must become occupied only AFTER the watchdog's startup
    // free_port sweep — and the holder must never answer HTTP 200, or the
    // loop-bottom health check frees it as a stale listener. A bare TCP
    // listener (accepts, never responds) is exactly the "half-dead process
    // still holding the port" shape the crash page faces in the field.
    let holder: ReturnType<typeof spawn> | undefined
    try {
      // WD_TEST_BREAK fails every boot instantly; the backoff sleeps
      // (failures*5) put give-up at ~35s of wall time.
      expect(await until(() => readFileSync(wdLog, 'utf8').includes('failure #1'), 20_000)).toBe(true)
      holder = spawn(process.execPath, ['-e', `require('net').createServer(()=>{}).listen(${port},'127.0.0.1')`], { stdio: 'ignore' })
      const gaveUp = join(home, 'state', 'watchdog-gave-up')
      expect(await until(() => existsSync(gaveUp), 50_000)).toBe(true)
      // Parked: no further boot attempts, the page crash is absent, and the
      // occupant is NOT touched.
      const settled = attempts()
      await new Promise((resolve) => { setTimeout(resolve, 4000) })
      expect(attempts()).toBe(settled)
      const log = readFileSync(wdLog, 'utf8')
      expect(log).not.toContain("Unhandled 'error' event")
      expect(log).toContain('crash page cannot bind')
      try { process.kill(holder.pid ?? 0, 0) } catch { throw new Error('port holder was killed') }
      // SIGUSR1 re-arms the boot loop.
      lifecycle.signalExact(wd, 'SIGUSR1')
      expect(await until(() => attempts() > settled, 15_000), readFileSync(wdLog, 'utf8')).toBe(true)
    } finally {
      if (holder !== undefined) lifecycle.signalExact(holder, 'SIGKILL')
      await new Promise((resolve) => { setTimeout(resolve, 300) })
      await killListener(port)
    }
  }, 75_000)

  it('schedule-exit refuses without a credential (the gate)', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    markLiveWatchdog(join(env.home, 'state'))
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', String(port), '--delay-ms', '1000', '--state-dir', join(env.home, 'state'), '--repo', repo],
      out.io,
    )).toBe(1)
    expect(out.err.join('')).toContain('no green-build credential')
    rmSync(join(env.home, 'state', STATE_FILES.watchdogPid), { force: true })
    env.restore()
  })

  it('resolveWdHome: the explicit flag beats DSH_HOME, like every other resolver here', () => {
    expect(resolveWdHome('/explicit', { DSH_HOME: '/env' })).toBe('/explicit')
    expect(resolveWdHome('', { DSH_HOME: '/env' })).toBe('/env')
    expect(resolveWdHome('', {})).toBeUndefined()
    expect(resolveWdHome('', { DSH_HOME: '' })).toBeUndefined()
  })

  it('supervise without DSH_HOME or --home fails loud instead of guessing a home', async () => {
    // The watchdog exports the home as the instance's DSH_HOME — deriving it
    // from --state-dir would silently boot the instance on the wrong
    // profiles/credentials, so a missing home is a loud refusal.
    const previous = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      const out = io()
      const code = await runCli(
        ['supervise', '--port', '1', '--start', 'true', '--state-dir', tmpDir('guard-cli-'), '--repo', makeRepo()],
        out.io,
      )
      expect(code).toBe(2)
      expect(out.err.join('')).toContain('--home')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('schedule-exit hard-refuses when no live watchdog will respawn the instance', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    try {
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--repo', repo, '--state-dir', stateDir], io().io)).toBe(0)
      stubPreflight('true')
      const port = await freePort()
      const out = io()
      // No watchdog has ever run here: scheduling the kill would guarantee an outage.
      expect(await runCli(
        ['schedule-exit', '--port', String(port), '--delay-ms', '60000', '--state-dir', stateDir, '--repo', repo],
        out.io,
      )).toBe(1)
      expect(out.err.join('')).toContain('schedule-exit refused: no live watchdog')
      expect(existsSync(join(stateDir, 'restart-requested.json'))).toBe(false)
    } finally {
      env.restore()
    }
  }, 15_000)

  it('restart refuses in a sandboxed environment; --force overrides', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    try {
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', ...flags], io().io)).toBe(0)
      stubSandboxProbe(true)
      const refused = io()
      expect(await runCli(['restart', '--sync', '--port', '1', '--start', 'true', ...flags], refused.io)).toBe(1)
      expect(refused.err.join()).toContain('/permission danger-full-access')
      stubPreflight('true')
      const forced = io()
      await runCli(['restart', '--sync', '--port', '1', '--start', 'true', '--force', ...flags], forced.io)
      expect(forced.err.join()).not.toContain('/permission danger-full-access')
    } finally {
      env.restore()
    }
  }, 15_000)

  it('check-env reports sandbox, watchdog, and git readiness', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = join(env.home, 'state')
    try {
      const out = io()
      // This test process is unsandboxed → exit 0 with the full readout.
      expect(await runCli(['check-env', '--state-dir', stateDir, '--repo', repo], out.io)).toBe(0)
      const text = out.out.join('')
      expect(text).toContain('unsandboxed')
      expect(text).toContain('supervision: NOT supervised')
      expect(text).toContain('git repo: yes')
      // No skill-registration marker in this throwaway state: reported as absent.
      expect(text).toContain('skill: not recorded')
      // A registered marker surfaces as the catalog confirmation.
      writeSkillRegistration(stateDir, { registered: true, at: Date.now() })
      const second = io()
      expect(await runCli(['check-env', '--state-dir', stateDir, '--repo', repo], second.io)).toBe(0)
      expect(second.out.join('')).toContain('skill: dsh-self-restart-guard registered')
      // And a failure marker names the reason.
      writeSkillRegistration(stateDir, { registered: false, reason: 'skills service absent in this composition', at: Date.now() })
      const third = io()
      expect(await runCli(['check-env', '--state-dir', stateDir, '--repo', repo], third.io)).toBe(0)
      expect(third.out.join('')).toContain('skill: NOT registered (skills service absent')
    } finally {
      env.restore()
    }
  })

  it('schedule-exit fires a detached exit agent that kills the host; the watchdog takes over', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    // Green credential in the throwaway state (bound to the throwaway HEAD).
    const rec = io()
    expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--repo', repo, '--state-dir', join(env.home, 'state')], rec.io)).toBe(0)
    stubPreflight('true')
    const host = spawn(process.execPath, ['-e',
      `require('http').createServer((q,s)=>s.end('host')).listen(${port},'127.0.0.1')`],
    { detached: true, stdio: 'ignore' })
    host.unref()
    try {
      await waitForPort(port)
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      const sup = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', join(env.home, 'state'), '--repo', repo],
        sup.io,
      )).toBe(0)
      // Schedule the exit: the detached exit agent kills the host after 1.5s.
      const out = io()
      expect(await runCli(
        ['schedule-exit', '--port', String(port), '--delay-ms', '1500', '--initiator', 'session-scheduler',
          '--state-dir', join(env.home, 'state'), '--repo', repo],
        out.io,
      )).toBe(0)
      expect(out.out.join('')).toContain('exit scheduled')
      // The initiator rides the marker so the watchdog canary sees it too.
      expect(readFileSync(join(env.home, 'state', 'restart-requested.json'), 'utf8')).toContain('"initiator":"session-scheduler"')
      // Old owner exits (the exit agent kills it) → the watchdog respawns →
      // marker canary PASS → marker cleared → result file written.
      const deadline = Date.now() + 20_000
      let portDown = false
      while (Date.now() < deadline) {
        if (!portDown && !(await portListening(port))) portDown = true
        if (portDown && (await portListening(port))) break
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(await fetchBody(port)).toBe('new')
      // The watchdog's canary runs after the respawn is up; wait for it to
      // clear the marker, then require the PASS path (not the FAIL rollback).
      const marker = join(env.home, 'state', 'restart-requested.json')
      const clearDeadline = Date.now() + 10_000
      while (existsSync(marker) && Date.now() < clearDeadline) {
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(existsSync(marker)).toBe(false)
      expect(readFileSync(join(env.home, 'state', 'watchdog.log'), 'utf8')).toContain('canary PASS')
      expect(existsSync(join(env.home, 'state', 'last-restart.json'))).toBe(true)
      expect(readFileSync(join(env.home, 'state', 'last-restart.json'), 'utf8')).toContain('"initiator":"session-scheduler"')
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 30_000)

  it('schedule-exit writes marker and result into an explicit state dir, not a derived home', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    // Deliberately NOT <home>/state: the write side once derived a home from
    // stateDir and re-appended 'state', landing markers in <cwd>/state while
    // the plugin read <cwd>/.dsh-guard-state — report and resume both lost.
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    try {
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--repo', repo, '--state-dir', stateDir], io().io)).toBe(0)
      markLiveWatchdog(stateDir)
      stubPreflight('true')
      expect(await runCli(
        ['schedule-exit', '--port', String(port), '--delay-ms', '20', '--initiator', 'session-x',
          '--state-dir', stateDir, '--repo', repo],
        io().io,
      )).toBe(0)
      expect(existsSync(join(stateDir, 'restart-requested.json'))).toBe(true)
      expect(existsSync(join(env.home, 'state', 'restart-requested.json'))).toBe(false)
      // No listener on the port: the exit agent records its error result in
      // the same state directory.
      const deadline = Date.now() + 5000
      while (!existsSync(join(stateDir, 'last-restart.json')) && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 50) })
      }
      expect(existsSync(join(stateDir, 'last-restart.json'))).toBe(true)
      expect(existsSync(join(env.home, 'state', 'last-restart.json'))).toBe(false)
    } finally {
      env.restore()
    }
  }, 15_000)

  it('schedule-exit warns when --initiator contradicts this session\'s DSH_SESSION_ID', async () => {
    // The wake-up report routes to the recorded initiator: an agent that
    // invents one (observed 2026-08-29: a branch-derived slug) strands its own
    // resume. The CLI warns loudly instead of refusing — scheduling on behalf
    // of another session is legitimate.
    const env = supervisedEnv()
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = await freePort()
    const previousSession = process.env.DSH_SESSION_ID
    process.env.DSH_SESSION_ID = 'session-real'
    try {
      expect(await runCli(['record', 'build', '--trust-command', '--command', 'test fixture', '--repo', repo, '--state-dir', stateDir], io().io)).toBe(0)
      markLiveWatchdog(stateDir)
      stubPreflight('true')
      const out = io()
      expect(await runCli(
        ['schedule-exit', '--port', String(port), '--delay-ms', '60000', '--initiator', 'skill-styles-merge',
          '--state-dir', stateDir, '--repo', repo],
        out.io,
      )).toBe(0)
      const warning = out.err.join('')
      expect(warning).toContain('does not match')
      expect(warning).toContain('skill-styles-merge')
      expect(warning).toContain('session-real')
      // The marker still records what was asked for (warn, not refuse).
      const marker = JSON.parse(readFileSync(join(stateDir, 'restart-requested.json'), 'utf8'))
      expect(marker.initiator).toBe('skill-styles-merge')
      // A matching (or omitted) --initiator stays silent.
      const quiet = io()
      unlinkSync(join(stateDir, 'restart-requested.json'))
      expect(await runCli(
        ['schedule-exit', '--port', String(port), '--delay-ms', '60000', '--initiator', 'session-real',
          '--state-dir', stateDir, '--repo', repo],
        quiet.io,
      )).toBe(0)
      expect(quiet.err.join('')).not.toContain('does not match')
    } finally {
      if (previousSession === undefined) delete process.env.DSH_SESSION_ID
      else process.env.DSH_SESSION_ID = previousSession
      env.restore()
    }
  }, 15_000)

  it('rolls back to the deployment-proven boot stamp, leaving HEAD and WIP anchors', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    const stateDir = join(env.home, 'state')
    mkdirSync(stateDir, { recursive: true })
    const checkpointSha = currentHead(repo)
    // Four revisions: checkpoint (oldest) → boot stamp (deployment-proven) →
    // credential (green build+test, never booted) → the bad HEAD.
    writeFileSync(join(repo, 'a.txt'), '2')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-qm', 'booted'])
    const stampSha = currentHead(repo)
    writeFileSync(join(repo, 'a.txt'), '3')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-qm', 'green'])
    const greenSha = currentHead(repo)
    setCheckpoint(stateDir, { revision: checkpointSha ?? '', message: 'old' }, NOW)
    recordCredential(stateDir, { scope: 'build+test', revision: greenSha ?? '', command: '' }, NOW)
    writeFileSync(join(stateDir, 'last-good-boot.json'), `${JSON.stringify({ revision: stampSha, at: NOW })}\n`)
    // A bad commit on top, plus uncommitted work the rollback must not lose.
    writeFileSync(join(repo, 'a.txt'), '4')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-qm', 'bad'])
    const badSha = currentHead(repo)
    writeFileSync(join(repo, 'a.txt'), '4-dirty')
    try {
      // Boot failure whose error subject is INSIDE the repo → rollback fires.
      const startCmd = `"${process.execPath}" -e "console.error('Error: boot failed - cannot load ${join(repo, 'src', 'boom.ts')}');process.exit(1)"`
      const sup = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        sup.io,
      )).toBe(0)
      const logFile = join(env.home, 'state', 'watchdog.log')
      const deadline = Date.now() + 30_000
      let log = ''
      while (Date.now() < deadline) {
        if (existsSync(logFile)) {
          log = readFileSync(logFile, 'utf8')
          if (log.includes('rolling repo back to last known-good') && log.includes('-wip')) break
        }
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(log).toContain(`rolling repo back to last known-good ${stampSha}`)
      expect(log).toContain('recovery anchor: branch')
      // The stamp beats both the older checkpoint and the newer (never-booted)
      // credential: it is the last revision that actually came up.
      expect(currentHead(repo)).toBe(stampSha)
      const branches = execFileSync('git', ['branch', '--list', 'guard-backup-*'], { cwd: repo, encoding: 'utf8' })
        .split('\n').map(branch => branch.trim()).filter(branch => branch !== '')
      const headAnchor = branches.find(branch => !branch.endsWith('-wip'))
      const wipAnchor = branches.find(branch => branch.endsWith('-wip'))
      expect(headAnchor).toBeDefined()
      expect(wipAnchor).toBeDefined()
      // The HEAD anchor keeps the discarded commit; the WIP anchor keeps the
      // uncommitted worktree state (git stash create snapshots it).
      expect(execFileSync('git', ['rev-parse', headAnchor ?? ''], { cwd: repo, encoding: 'utf8' }).trim()).toBe(badSha)
      expect(execFileSync('git', ['show', `${wipAnchor}:a.txt`], { cwd: repo, encoding: 'utf8' })).toBe('4-dirty')
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 45_000)

  it('falls back to the pre-batch checkpoint when no boot stamp exists', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    const stateDir = join(env.home, 'state')
    mkdirSync(stateDir, { recursive: true })
    const checkpointSha = currentHead(repo)
    commitChange(repo)
    const greenSha = currentHead(repo)
    setCheckpoint(stateDir, { revision: checkpointSha ?? '', message: 'old' }, NOW)
    recordCredential(stateDir, { scope: 'build+test', revision: greenSha ?? '', command: '' }, NOW)
    try {
      const startCmd = `"${process.execPath}" -e "console.error('Error: boot failed - cannot load ${join(repo, 'src', 'boom.ts')}');process.exit(1)"`
      const sup = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        sup.io,
      )).toBe(0)
      const logFile = join(env.home, 'state', 'watchdog.log')
      const deadline = Date.now() + 30_000
      let log = ''
      while (Date.now() < deadline) {
        if (existsSync(logFile)) {
          log = readFileSync(logFile, 'utf8')
          // The anchor line prints after the reset completes — the barrier
          // that makes the HEAD assertion below race-free.
          if (log.includes('rolling repo back to last known-good') && log.includes('recovery anchor')) break
        }
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      // No stamp: the checkpoint (pre-batch) outranks the credential, whose
      // green HEAD is exactly what failed to boot.
      expect(log).toContain(`rolling repo back to last known-good ${checkpointSha}`)
      expect(currentHead(repo)).toBe(checkpointSha)
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 45_000)

  it('skips the repository rollback when the boot failure originates outside the repo', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    const stateDir = join(env.home, 'state')
    mkdirSync(stateDir, { recursive: true })
    const head = currentHead(repo)
    recordCredential(stateDir, { scope: 'build+test', revision: head ?? '', command: '' }, NOW)
    try {
      // The incident shape: node's uncaught-exception printout leads with the
      // throw site (a path INSIDE the repo — the parser), while the Error
      // message line names the offending path OUTSIDE it (a profile overlay).
      // The classifier must follow the Error line, not the preamble.
      const outside = join(env.home, 'profiles', 'web', 'node_modules', '@x', 'cordis.patch.yml')
      const throwSite = join(repo, 'packages', 'boot', 'app-boot', 'src', 'index.ts')
      const output = [
        `${throwSite}:327`,
        '    throw new Error(`failed to parse ${file}`)',
        '          ^',
        '',
        `Error: dsh: failed to parse overlay ${outside}: YAMLException: bad indentation of a mapping entry (9:13)`,
        `    at parsePatchList (${throwSite}:327:11)`,
        '',
      ].join('\n')
      const boom = join(env.home, 'boom.js')
      writeFileSync(boom, `console.error(${JSON.stringify(output)});process.exit(1)\n`)
      const startCmd = `"${process.execPath}" "${boom}"`
      const sup = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        sup.io,
      )).toBe(0)
      const logFile = join(env.home, 'state', 'watchdog.log')
      const deadline = Date.now() + 30_000
      let log = ''
      while (Date.now() < deadline) {
        if (existsSync(logFile)) {
          log = readFileSync(logFile, 'utf8')
          if (log.includes('originates outside')) break
        }
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(log).toContain(`boot failure originates outside ${repo} — repository rollback cannot fix it`)
      // The checkout is untouched: HEAD unchanged, no backup branches created.
      expect(currentHead(repo)).toBe(head)
      expect(execFileSync('git', ['branch', '--list', 'guard-backup-*'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('')
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 45_000)

  it('treats EADDRINUSE as a port race: frees the port and retries without counting toward rollback or give-up', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    const stateDir = join(env.home, 'state')
    mkdirSync(stateDir, { recursive: true })
    const head = currentHead(repo)
    recordCredential(stateDir, { scope: 'build+test', revision: head ?? '', command: '' }, NOW)
    // Five consecutive EADDRINUSE attempts before the instance binds: if they
    // counted as boot failures, #2 would roll the repo back and #4 would give
    // up — reaching 'new' proves neither happened.
    const counter = join(env.home, 'attempts')
    const boom = join(env.home, 'eaddr.js')
    writeFileSync(boom, `
      const fs = require('node:fs')
      const count = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0
      fs.writeFileSync(${JSON.stringify(counter)}, String(count + 1))
      if (count < 5) {
        console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}')
        process.exit(1)
      }
      require('node:http').createServer((q, s) => s.end('new')).listen(${port}, '127.0.0.1')
    `)
    try {
      const startCmd = `"${process.execPath}" "${boom}"`
      const sup = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        sup.io,
      )).toBe(0)
      const deadline = Date.now() + 20_000
      let body = ''
      while (Date.now() < deadline) {
        try {
          body = await fetchBody(port)
          if (body === 'new') break
        } catch { /* not up yet */ }
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(body).toBe('new')
      const log = readFileSync(join(env.home, 'state', 'watchdog.log'), 'utf8')
      expect(log).toContain('boot hit EADDRINUSE')
      expect(log).not.toContain('rolling repo back')
      expect(log).not.toContain('giving up')
      expect(currentHead(repo)).toBe(head)
      expect(existsSync(join(env.home, 'state', 'watchdog-gave-up'))).toBe(false)
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
    // Six spawn-and-fail cycles do not fit in vitest's 5 s default, which the
    // 20 s deadline above already assumed.
  }, 30_000)

  it('counts an EADDRINUSE on a foreign port as a boot failure instead of retrying forever', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    const foreign = port + 1
    const stateDir = join(env.home, 'state')
    mkdirSync(stateDir, { recursive: true })
    const head = currentHead(repo)
    recordCredential(stateDir, { scope: 'build+test', revision: head ?? '', command: '' }, NOW)
    // A start command aimed at a port this watchdog does not own. Freeing the
    // supervised port cannot release the foreign one, so the port-race escape
    // hatch must NOT apply: it skips the failure counter, and taking it here
    // respawned the instance in a tight loop that never backed off, never gave
    // up, and never surfaced the misconfiguration.
    const counter = join(env.home, 'attempts')
    const boom = join(env.home, 'foreign-eaddr.js')
    writeFileSync(boom, `
      const fs = require('node:fs')
      const count = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0
      fs.writeFileSync(${JSON.stringify(counter)}, String(count + 1))
      console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:${foreign}')
      process.exit(1)
    `)
    try {
      const startCmd = `"${process.execPath}" "${boom}"`
      const sup = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        sup.io,
      )).toBe(0)
      const logPath = join(stateDir, 'watchdog.log')
      const deadline = Date.now() + 20_000
      let log = ''
      while (Date.now() < deadline) {
        log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
        // The classification line is written before the generic counted-
        // failure line. Under load, observing only the first is not a settled
        // attempt and used to race the assertion immediately below.
        if (log.includes('other than the supervised') && log.includes('instance failed to come up')) break
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(log).toContain('other than the supervised')
      expect(log).toContain('instance failed to come up')
      // The counted failures carry the backoff, so attempts stay in single
      // digits over this window; the uncounted retry loop reached dozens.
      const attempts = Number(readFileSync(counter, 'utf8'))
      expect(attempts).toBeLessThanOrEqual(5)
      // The command line is wrong, not the checkout — the rollback stays unspent.
      expect(log).not.toContain('rolling repo back')
      expect(currentHead(repo)).toBe(head)
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 30_000)

  it('skips the reset when the rollback target already is HEAD — uncommitted work survives', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = await freePort()
    const stateDir = join(env.home, 'state')
    mkdirSync(stateDir, { recursive: true })
    // No stamp, no credential: the chain falls to the checkpoint, which IS
    // the current HEAD — the reset would only wipe the dirty tree.
    const head = currentHead(repo)
    setCheckpoint(stateDir, { revision: head ?? '', message: 'pre' }, NOW)
    writeFileSync(join(repo, 'a.txt'), 'someone-elses-dirty-work')
    try {
      const startCmd = `"${process.execPath}" -e "console.error('Error: boot failed - cannot load ${join(repo, 'src', 'boom.ts')}');process.exit(1)"`
      const sup = io()
      expect(await runCli(
        ['supervise', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        sup.io,
      )).toBe(0)
      const logFile = join(env.home, 'state', 'watchdog.log')
      const deadline = Date.now() + 30_000
      let log = ''
      while (Date.now() < deadline) {
        if (existsSync(logFile)) {
          log = readFileSync(logFile, 'utf8')
          if (log.includes('skipping reset')) break
        }
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(log).toContain(`rollback target ${head} is the current HEAD — skipping reset`)
      expect(log).not.toContain('rolling repo back')
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('someone-elses-dirty-work')
      expect(currentHead(repo)).toBe(head)
      expect(execFileSync('git', ['branch', '--list', 'guard-backup-*'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('')
    } finally {
      env.stop()
      await killListener(port)
      env.restore()
    }
  }, 45_000)
})

describe('restart context injection', () => {
  it('holds wake-up until the cutover receipt is terminal, then reports exactly once', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-cutover-')
    const launchBase = {
      version: 1 as const,
      port: 3080,
      home: join(stateDir, 'home'),
      credentialRepo: repo,
      harnessRoot: join(stateDir, 'harness-root'),
      profile: 'web',
    }
    prepareLaunchCutover(stateDir, {
      id: 'wake-gated-cutover',
      previous: { ...launchBase, command: 'previous-host' },
      target: { ...launchBase, command: 'target-host' },
      recoveryPolicy: 'restore-previous', browserHandoff: 'off',
      previousSupervisorPid: 701, previousSupervisorStartToken: 'supervisor-start-701', previousOwnership: fakeOwnership(702),
      initiator: 'session-cutover-owner', now: NOW,
    })
    const followup = vi.fn()
    const agent = { id: 'session-cutover-owner', followup } as never
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [agent], list: () => [agent] } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    ctx.emit('agent/created', { agent })
    expect(followup).not.toHaveBeenCalled()

    recordCutoverEvent(stateDir, 'wake-gated-cutover', 'child-started', ['target', '1', '703', 'target-start-703'], NOW + 1)
    recordCutoverEvent(stateDir, 'wake-gated-cutover', 'ownership-stable', ['target', '703', 'target-start-703', '704', 'listener-start-704', '3000', '0'], NOW + 2)
    recordCutoverEvent(stateDir, 'wake-gated-cutover', 'canary', ['pass'], NOW + 3)
    recordCutoverEvent(stateDir, 'wake-gated-cutover', 'ready', ['target'], NOW + 4)
    const deadline = Date.now() + 3000
    while (followup.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
    expect(followup).toHaveBeenCalledTimes(1)
    expect(pendingRestartRecord(stateDir)).toBeNull()
    await fiber.dispose()
  })

  it('queues the restart report as a followup turn on root-agent creation (autonomous)', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'last-restart.json'), JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9 }))
    const followup = vi.fn()
    const agent = { followup } as never
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [agent] } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    ctx.emit('agent/created', { agent })
    expect(followup).toHaveBeenCalledTimes(1)
    // Acknowledged: a second creation does not re-followup.
    ctx.emit('agent/created', { agent })
    expect(followup).toHaveBeenCalledTimes(1)
    expect(pendingRestartRecord(stateDir)).toBeNull()
    await fiber.dispose()
  })

  it('does not followup for a non-root (subagent) agent', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'last-restart.json'), JSON.stringify({ exitAt: 1_700_000_000_000 }))
    const followup = vi.fn()
    const child = { followup } as never
    const root = { followup: vi.fn() } as never
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [root] } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    ctx.emit('agent/created', { agent: child })
    expect(followup).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('returns the report to the initiating session while it is live', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    const initiatorId = 'session-initiator'
    const otherId = 'session-other'
    writeFileSync(join(stateDir, 'last-restart.json'),
      JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: initiatorId }))
    const initiatorFollowup = vi.fn()
    const otherFollowup = vi.fn()
    const initiatorAgent = { id: initiatorId, followup: initiatorFollowup } as never
    const otherAgent = { id: otherId, followup: otherFollowup } as never
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', {
      roots: () => [initiatorAgent, otherAgent],
      list: () => [initiatorAgent, otherAgent],
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    // A non-initiator root resuming first must NOT claim the record.
    ctx.emit('agent/created', { agent: otherAgent })
    expect(otherFollowup).not.toHaveBeenCalled()
    expect(initiatorFollowup).not.toHaveBeenCalled()
    // The initiating session's agent claims it (and acknowledges).
    ctx.emit('agent/created', { agent: initiatorAgent })
    expect(initiatorFollowup).toHaveBeenCalledTimes(1)
    expect(pendingRestartRecord(stateDir)).toBeNull()
    await fiber.dispose()
  })

  it('stays silent for other sessions while the initiator is absent; the owner reports whenever it resumes', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    const initiatorId = 'session-initiator'
    writeFileSync(join(stateDir, 'last-restart.json'),
      JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: initiatorId }))
    const otherFollowup = vi.fn()
    const initiatorFollowup = vi.fn()
    const otherAgent = { id: 'session-other', followup: otherFollowup } as never
    const initiatorAgent = { id: initiatorId, followup: initiatorFollowup } as never
    const ctx = new Context()
    await ctx.plugin(Loader)
    let liveAgents: unknown[] = [otherAgent]
    ctx.provide('agents', {
      roots: () => liveAgents,
      list: () => liveAgents,
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    // A non-initiator root resuming first is never woken for reporting; the
    // record simply stays pending — restore is lazy, so no fallback can race.
    ctx.emit('agent/created', { agent: otherAgent })
    expect(otherFollowup).not.toHaveBeenCalled()
    expect(pendingRestartRecord(stateDir)).not.toBeNull()
    // The owner resumes much later — no grace window, no fallback — and
    // still receives the full report, settling the record.
    liveAgents = [otherAgent, initiatorAgent]
    ctx.emit('agent/created', { agent: initiatorAgent })
    expect(initiatorFollowup).toHaveBeenCalledTimes(1)
    const text = (initiatorFollowup.mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('请向用户简要回报')
    expect(text).toContain(new Date(1_700_000_000_000).toISOString())
    expect(pendingRestartRecord(stateDir)).toBeNull()
    await fiber.dispose()
  })

  it('snapshots running root sessions on SIGTERM; disposal removes the listener', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'restart-requested.json'), JSON.stringify({ initiator: 'session-init' }))
    const running = { id: 'session-busy', status: 'running', followup: vi.fn() }
    const idle = { id: 'session-idle', status: 'idle', followup: vi.fn() }
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', { roots: () => [running, idle], list: () => [running, idle] } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    process.emit('SIGTERM')
    const snapshot = JSON.parse(readFileSync(join(stateDir, 'interrupted-sessions.json'), 'utf8')) as {
      resume: string[]
      interrupted: string[]
    }
    // Only the live turn is interrupted; the restart's initiator rides along
    // so the report's owner is resumed even when its own turn had finished.
    expect(snapshot.interrupted).toEqual(['session-busy'])
    expect(snapshot.resume).toEqual(['session-init'])
    await fiber.dispose()
    // Disposal removed the signal listener: a later SIGTERM snapshots nothing.
    unlinkSync(join(stateDir, 'interrupted-sessions.json'))
    process.emit('SIGTERM')
    expect(existsSync(join(stateDir, 'interrupted-sessions.json'))).toBe(false)
  })

  it('resumes interrupted sessions on a restart boot: the owner gets the report, the interrupted get continue', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    // Restart-boot markers: a pending restart record plus the SIGTERM snapshot.
    writeFileSync(join(stateDir, 'last-restart.json'),
      JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: 'session-init' }))
    writeFileSync(join(stateDir, 'interrupted-sessions.json'),
      JSON.stringify({ exitAt: Date.now(), resume: ['session-init'], interrupted: ['session-busy'] }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    const resumed: string[] = []
    const resumeOptions = new Map<string, { agentOptions?: unknown; setup?: (agentCtx: never) => Promise<void> }>()
    const followups = new Map<string, ReturnType<typeof vi.fn>>()
    const liveAgents: Array<{ id: string; status: string; followup: ReturnType<typeof vi.fn> }> = []
    ctx.provide('agents', {
      roots: () => liveAgents,
      list: () => liveAgents,
      resume: async (options: { resumeSessionId: string; agentOptions?: unknown; setup?: (agentCtx: never) => Promise<void> }) => {
        const id = options.resumeSessionId
        resumed.push(id)
        resumeOptions.set(id, options)
        const agent = { id, status: 'idle', followup: vi.fn() }
        followups.set(id, agent.followup)
        liveAgents.push(agent)
        ctx.emit('agent/created', { agent } as never)
        return agent
      },
    } as never)
    // The composition services a faithful resume consults.
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) } as never)
    const mount = vi.fn()
    ctx.provide('agentPresets', {
      resolve: async (presetId?: string) => ({ id: presetId ?? 'default' }),
      mount,
    } as never)
    ctx.provide('sessionPersistence', {
      inspect: async (id: string) => ({ meta: { agentPreset: `preset-of-${id}` }, events: [] }),
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, resumeDelayMs: 1 })
    await fiber.await()
    const deadline = Date.now() + 5000
    while (resumed.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    expect([...resumed].sort()).toEqual(['session-busy', 'session-init'])
    // Faithful composition: the default model selection seeds agentOptions
    // (without it the persona's {{model}} interpolation fails every turn),
    // and setup mounts the session's stored preset (resolved from the log).
    expect(resumeOptions.get('session-busy')?.agentOptions).toEqual({ provider: 'deepseek', model: 'v4' })
    const setup = resumeOptions.get('session-busy')?.setup
    expect(setup).toBeTypeOf('function')
    await setup!({} as never)
    expect(mount).toHaveBeenCalledWith({}, 'preset-of-session-busy')
    // The report's owner received the full report (its created event claimed it).
    expect(followups.get('session-init')).toHaveBeenCalledTimes(1)
    const report = (followups.get('session-init')!.mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(report).toContain('请向用户简要回报')
    // The interrupted session received the continue prompt, not the report.
    expect(followups.get('session-busy')).toHaveBeenCalledTimes(1)
    const cont = (followups.get('session-busy')!.mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(cont).toContain('被中断')
    expect(cont).toContain('继续未完成的任务')
    expect(cont).not.toContain('请向用户简要回报')
    // The snapshot is consumed: a later boot does not replay it.
    expect(existsSync(join(stateDir, 'interrupted-sessions.json'))).toBe(false)
    await fiber.dispose()
  })

  it('a session parked on user input is NOT resumed: the card in the log is the continuation', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'interrupted-sessions.json'),
      JSON.stringify({ exitAt: Date.now(), resume: [], interrupted: ['session-parked', 'session-working'] }))
    const parkedEvents = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' } },
      { type: 'tool/result', seq: 3, data: { turn: 1, step: 1, callId: 'c1', message: { content: 'interrupted' } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'interrupted' } } },
    ]
    const workingEvents = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'interrupted' } } },
    ]
    const ctx = new Context()
    await ctx.plugin(Loader)
    const resumed: string[] = []
    const followups = new Map<string, ReturnType<typeof vi.fn>>()
    const liveAgents: Array<{ id: string; status: string; followup: ReturnType<typeof vi.fn> }> = []
    ctx.provide('agents', {
      roots: () => liveAgents,
      list: () => liveAgents,
      resume: async (options: { resumeSessionId: string }) => {
        resumed.push(options.resumeSessionId)
        const agent = { id: options.resumeSessionId, status: 'idle', followup: vi.fn() }
        followups.set(agent.id, agent.followup)
        liveAgents.push(agent)
        ctx.emit('agent/created', { agent } as never)
        return agent
      },
    } as never)
    ctx.provide('sessionPersistence', {
      inspect: async (id: string) => ({
        meta: {},
        events: id === 'session-parked' ? parkedEvents : workingEvents,
      }),
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, resumeDelayMs: 1 })
    await fiber.await()
    const deadline = Date.now() + 5000
    while (!resumed.includes('session-working') && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    expect(resumed).toEqual(['session-working'])
    // The working session got its continue; the parked one got nothing — the
    // question card in its log is still the live continuation surface.
    expect(followups.get('session-working')).toHaveBeenCalledTimes(1)
    expect(followups.has('session-parked')).toBe(false)
    await fiber.dispose()
  })

  it('isParkedOnUserInput: parked iff the interrupted turn blocked on a question or an approval', () => {
    const interrupt = (turn: number) => ({ type: 'turn/end', seq: 99, data: { turn, reason: { kind: 'interrupted' } } })
    const start = (turn: number) => ({ type: 'turn/start', seq: 1, data: { turn } })
    // Parked on an open ask_user_question at the tail.
    expect(isParkedOnUserInput([
      start(1),
      { type: 'tool/call', seq: 2, data: { turn: 1, name: 'bash' } },
      { type: 'tool/result', seq: 3, data: { turn: 1 } },
      { type: 'tool/call', seq: 4, data: { turn: 1, name: 'ask_user_question' } },
      interrupt(1),
    ])).toBe(true)
    // Parked on an undecided approval (asked without decided within the turn).
    expect(isParkedOnUserInput([
      start(1),
      { type: 'approval/asked', seq: 2, data: { turn: 1 } },
      interrupt(1),
    ])).toBe(true)
    // Approval asked AND decided, then real work interrupted: not parked.
    expect(isParkedOnUserInput([
      start(1),
      { type: 'approval/asked', seq: 2, data: { turn: 1 } },
      { type: 'approval/decided', seq: 3, data: { turn: 1 } },
      { type: 'tool/call', seq: 4, data: { turn: 1, name: 'bash' } },
      interrupt(1),
    ])).toBe(false)
    // Mid-work interruption (no user-input call at the tail): not parked.
    expect(isParkedOnUserInput([start(1), { type: 'tool/call', seq: 2, data: { turn: 1, name: 'bash' } }, interrupt(1)])).toBe(false)
    // A question earlier in the turn, answered, then real work: not parked.
    expect(isParkedOnUserInput([
      start(1),
      { type: 'tool/call', seq: 2, data: { turn: 1, name: 'ask_user_question' } },
      { type: 'tool/result', seq: 3, data: { turn: 1 } },
      { type: 'tool/call', seq: 4, data: { turn: 1, name: 'bash' } },
      interrupt(1),
    ])).toBe(false)
    // No interrupted turn at all: not parked.
    expect(isParkedOnUserInput([start(1), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }])).toBe(false)
  })

  it('merges continue and report into ONE message when the initiator was itself interrupted', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'last-restart.json'),
      JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: 'session-init' }))
    // The initiator's own turn was still running when its scheduled exit fired.
    writeFileSync(join(stateDir, 'interrupted-sessions.json'),
      JSON.stringify({ exitAt: Date.now(), resume: ['session-init'], interrupted: ['session-init'] }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    const liveAgents: Array<{ id: string; status: string; followup: ReturnType<typeof vi.fn> }> = []
    ctx.provide('agents', {
      roots: () => liveAgents,
      list: () => liveAgents,
      resume: async (options: { resumeSessionId: string }) => {
        const agent = { id: options.resumeSessionId, status: 'idle', followup: vi.fn() }
        liveAgents.push(agent)
        ctx.emit('agent/created', { agent } as never)
        return agent
      },
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, resumeDelayMs: 1 })
    await fiber.await()
    const deadline = Date.now() + 5000
    while (liveAgents.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    // Exactly one injection carrying both purposes; the record settles.
    expect(liveAgents[0]?.followup).toHaveBeenCalledTimes(1)
    const text = (liveAgents[0]!.followup.mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('继续未完成的任务')
    expect(text).toContain('向用户简要回报本次重启结果')
    expect(text).toContain(new Date(1_700_000_000_000).toISOString())
    expect(pendingRestartRecord(stateDir)).toBeNull()
    await fiber.dispose()
  })

  it('injects continue exactly once into an already-live interrupted session (reactivated by UI/schedule)', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'restart-requested.json'), JSON.stringify({}))
    writeFileSync(join(stateDir, 'interrupted-sessions.json'),
      JSON.stringify({ exitAt: Date.now(), resume: [], interrupted: ['session-busy'] }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    const busy = { id: 'session-busy', status: 'idle', followup: vi.fn() }
    const resume = vi.fn()
    ctx.provide('agents', {
      roots: () => [busy],
      list: () => [busy],
      resume,
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, resumeDelayMs: 1 })
    await fiber.await()
    const deadline = Date.now() + 5000
    while (busy.followup.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    // Already live (the user reopened it, or a reminder woke it): no resume
    // needed, but the continue injection still lands — exactly once.
    expect(resume).not.toHaveBeenCalled()
    expect(busy.followup).toHaveBeenCalledTimes(1)
    const cont = (busy.followup.mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(cont).toContain('继续未完成的任务')
    expect(existsSync(join(stateDir, 'interrupted-sessions.json'))).toBe(false)
    await fiber.dispose()
  })

  it('honors a fresh snapshot even without restart markers (a quick manual stop/start rescues too)', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    // No restart marker, no pending record: freshness is the only gate.
    writeFileSync(join(stateDir, 'interrupted-sessions.json'),
      JSON.stringify({ exitAt: Date.now(), resume: [], interrupted: ['session-busy'] }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    const resumed: string[] = []
    const liveAgents: Array<{ id: string; status: string; followup: ReturnType<typeof vi.fn> }> = []
    ctx.provide('agents', {
      roots: () => liveAgents,
      list: () => liveAgents,
      resume: async (options: { resumeSessionId: string }) => {
        resumed.push(options.resumeSessionId)
        const agent = { id: options.resumeSessionId, status: 'idle', followup: vi.fn() }
        liveAgents.push(agent)
        ctx.emit('agent/created', { agent } as never)
        return agent
      },
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, resumeDelayMs: 1 })
    await fiber.await()
    const deadline = Date.now() + 5000
    while (resumed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    expect(resumed).toEqual(['session-busy'])
    expect(existsSync(join(stateDir, 'interrupted-sessions.json'))).toBe(false)
    await fiber.dispose()
  })

  it('resumes even when the canary cleared the restart marker before the delayed pass ran', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    // The marker exists at plugin apply (boot), but the watchdog's canary
    // clears it as soon as the instance is healthy — seconds before the
    // delayed resume pass evaluates its gate. The gate is captured at apply.
    writeFileSync(join(stateDir, 'restart-requested.json'), JSON.stringify({}))
    writeFileSync(join(stateDir, 'interrupted-sessions.json'),
      JSON.stringify({ exitAt: Date.now(), resume: [], interrupted: ['session-busy'] }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    const resumed: string[] = []
    const liveAgents: Array<{ id: string; status: string; followup: ReturnType<typeof vi.fn> }> = []
    ctx.provide('agents', {
      roots: () => liveAgents,
      list: () => liveAgents,
      resume: async (options: { resumeSessionId: string }) => {
        resumed.push(options.resumeSessionId)
        const agent = { id: options.resumeSessionId, status: 'idle', followup: vi.fn() }
        liveAgents.push(agent)
        ctx.emit('agent/created', { agent } as never)
        return agent
      },
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, resumeDelayMs: 20 })
    await fiber.await()
    // The canary clears the marker before the pass fires.
    unlinkSync(join(stateDir, 'restart-requested.json'))
    const deadline = Date.now() + 5000
    while (resumed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    expect(resumed).toEqual(['session-busy'])
    expect(liveAgents[0]?.followup).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('drops a stale snapshot even on a restart boot (manual stop/start hours later)', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'restart-requested.json'), JSON.stringify({}))
    writeFileSync(join(stateDir, 'interrupted-sessions.json'),
      JSON.stringify({ exitAt: Date.now() - 20 * 60_000, resume: [], interrupted: ['session-busy'] }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    const resume = vi.fn()
    ctx.provide('agents', { roots: () => [], list: () => [], resume } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, resumeDelayMs: 1 })
    await fiber.await()
    const deadline = Date.now() + 5000
    while (existsSync(join(stateDir, 'interrupted-sessions.json')) && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    expect(resume).not.toHaveBeenCalled()
    expect(existsSync(join(stateDir, 'interrupted-sessions.json'))).toBe(false)
    await fiber.dispose()
  })

  it('resumeInterrupted: off skips the resume pass and keeps the snapshot', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'restart-requested.json'), JSON.stringify({}))
    writeFileSync(join(stateDir, 'interrupted-sessions.json'),
      JSON.stringify({ exitAt: Date.now(), resume: [], interrupted: ['session-busy'] }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    const resume = vi.fn()
    ctx.provide('agents', { roots: () => [], list: () => [], resume } as never)
    const fiber = ctx.plugin(selfRestartGuard,
      { stateDir, repoDir: repo, maxAgeMinutes: 5, resumeInterrupted: false, resumeDelayMs: 1 })
    await fiber.await()
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(resume).not.toHaveBeenCalled()
    expect(existsSync(join(stateDir, 'interrupted-sessions.json'))).toBe(true)
    await fiber.dispose()
  })

  it("reportRestartContext: 'off' still resumes interrupted sessions — report and resume are independent", async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'interrupted-sessions.json'),
      JSON.stringify({ exitAt: Date.now(), resume: [], interrupted: ['session-busy'] }))
    const ctx = new Context()
    await ctx.plugin(Loader)
    const resumed: string[] = []
    const liveAgents: Array<{ id: string; status: string; followup: ReturnType<typeof vi.fn> }> = []
    ctx.provide('agents', {
      roots: () => liveAgents,
      list: () => liveAgents,
      resume: async (options: { resumeSessionId: string }) => {
        resumed.push(options.resumeSessionId)
        const agent = { id: options.resumeSessionId, status: 'idle', followup: vi.fn() }
        liveAgents.push(agent)
        ctx.emit('agent/created', { agent } as never)
        return agent
      },
    } as never)
    // Regression: the whole resume half once lived inside `reportMode ===
    // 'followup'`, so 'off' (or 'step') silently disabled session recovery.
    const fiber = ctx.plugin(selfRestartGuard,
      { stateDir, repoDir: repo, maxAgeMinutes: 5, reportRestartContext: 'off', resumeDelayMs: 20 })
    await fiber.await()
    const deadline = Date.now() + 5000
    while (resumed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    expect(resumed).toEqual(['session-busy'])
    expect(liveAgents[0]?.followup).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('a second restart replaces the record; the new record reports to its own initiator', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'last-restart.json'),
      JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: 'session-a' }))
    const aFollowup = vi.fn()
    const bFollowup = vi.fn()
    const otherFollowup = vi.fn()
    const aAgent = { id: 'session-a', followup: aFollowup } as never
    const bAgent = { id: 'session-b', followup: bFollowup } as never
    const otherAgent = { id: 'session-other', followup: otherFollowup } as never
    const ctx = new Context()
    await ctx.plugin(Loader)
    const liveAgents: unknown[] = [otherAgent]
    ctx.provide('agents', {
      roots: () => liveAgents,
      list: () => liveAgents,
    } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    ctx.emit('agent/created', { agent: otherAgent })
    expect(otherFollowup).not.toHaveBeenCalled()
    // A second restart replaces the record (new exitAt, new initiator).
    writeFileSync(join(stateDir, 'last-restart.json'),
      JSON.stringify({ exitAt: 1_700_000_000_500, pid: 10, initiator: 'session-b' }))
    // A's initiator resumes: the replaced record is not its record — silence.
    liveAgents.push(aAgent)
    ctx.emit('agent/created', { agent: aAgent })
    expect(aFollowup).not.toHaveBeenCalled()
    // B's initiator resumes: it claims B's facts and settles the record.
    liveAgents.push(bAgent)
    ctx.emit('agent/created', { agent: bAgent })
    expect(bFollowup).toHaveBeenCalledTimes(1)
    const text = (bFollowup.mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain(new Date(1_700_000_000_500).toISOString())
    expect(text).toContain('请向用户简要回报')
    expect(pendingRestartRecord(stateDir)).toBeNull()
    await fiber.dispose()
  })

  it('reports a pending restart record and acknowledges it after one injection', () => {
    const dir = tmpDir('guard-ctx-')
    const record = { exitAt: 1_700_000_000_000, pid: 123 }
    writeFileSync(join(dir, 'last-restart.json'), JSON.stringify(record))
    expect(pendingRestartRecord(dir)).toEqual(record)
    const text = restartContextText(pendingRestartRecord(dir)!, false)
    expect(text).toContain('重启过')
    expect(text).toContain('成功')
    acknowledgeRestartRecord(dir, record, 1_700_000_000_100)
    expect(pendingRestartRecord(dir)).toBeNull()
  })

  it('flags a pending canary while the restart marker is still present', () => {
    const dir = tmpDir('guard-ctx-')
    writeFileSync(join(dir, 'last-restart.json'), JSON.stringify({ exitAt: 1_700_000_000_000 }))
    const text = restartContextText(pendingRestartRecord(dir)!, true)
    expect(text).toContain('金丝雀尚未完成')
  })

  it('renders a failure and stays silent for an empty record', () => {
    expect(restartContextText({ error: 'no listener' }, false)).toContain('失败')
    expect(restartContextText({}, false)).toBe('')
  })

  it('renders an unplanned-exit recovery record (crash → watchdog respawn)', () => {
    // The watchdog leaves { unexpected: true } when it respawns without a
    // restart marker — crash recovery must reach the user, not stay silent.
    const text = restartContextText({ exitAt: 1_700_000_000_000, unexpected: true }, false)
    expect(text).toContain('非计划退出')
    expect(text).toContain('请向用户简要回报')
    expect(continueAndReportText({ exitAt: 1_700_000_000_000, unexpected: true }, false)).toContain('非计划退出')
  })

  it('exit-agent performExit SIGTERMs the listener and records the outcome', async () => {
    const port = await freePort()
    const host = spawn(process.execPath, ['-e',
      `require('http').createServer((q,s)=>s.end('x')).listen(${port},'127.0.0.1')`],
    { detached: true, stdio: 'ignore' })
    host.unref()
    const resultFile = join(tmpDir('guard-cli-'), 'last-restart.json')
    try {
      await waitForPort(port)
      performExit(port, resultFile, 'session-x')
      const record = JSON.parse(readFileSync(resultFile, 'utf8'))
      expect(record.pid).toBe(host.pid)
      expect(record.initiator).toBe('session-x')
      expect(record.exitAt).toBeGreaterThan(0)
      // The listener actually dies.
      const deadline = Date.now() + 5000
      while ((await portListening(port)) && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 100) })
      }
      expect(await portListening(port)).toBe(false)
    } finally {
      await killListener(port)
    }
  })

  it('exit-agent performExit records an error when nothing listens', () => {
    const resultFile = join(tmpDir('guard-cli-'), 'last-restart.json')
    performExit(1, resultFile, undefined)
    const record = JSON.parse(readFileSync(resultFile, 'utf8'))
    expect(record.error).toContain('no listener on port 1')
    expect(record.initiator).toBeUndefined()
  })

  it('writes the shutdown snapshot even when the state directory does not exist yet', () => {
    // Fresh deployments have no $DSH_HOME/state — the write must create it
    // (observed: the first-ever restart on a clean install lost the snapshot).
    const dir = join(tmpDir('guard-ctx-'), 'not-created-yet')
    writeInterruptedSnapshot(dir, { exitAt: NOW, resume: [], interrupted: ['session-x'] })
    expect(readInterruptedSnapshot(dir)?.interrupted).toEqual(['session-x'])
  })
})

describe('invariant', () => {
  it('fails on a malformed state file at the default location', () => {
    const home = tmpDir('guard-home-')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      mkdirSync(join(home, 'state'), { recursive: true })
      writeFileSync(join(home, 'state', 'self-restart-guard.json'), '{ nope')
      const fail = vi.fn((message: string): never => { throw new Error(message) })
      expect(() => installInvariant({} as never, fail)).toThrow(/malformed/)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('passes when no state file exists', () => {
    const home = tmpDir('guard-home-')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const fail = vi.fn((message: string): never => { throw new Error(message) })
      expect(() => installInvariant({} as never, fail)).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('pack smoke', () => {
  // The published artifact must be self-contained: tsdown splits shared state
  // and git helpers into hashed chunks (lib/state-*.js, lib/git-*.js) that the
  // entry files import relatively. `files` must glob them in — a tarball that
  // drops them makes every consumer import crash. This test packs the real
  // tarball and asserts every relative import inside lib/*.js resolves within
  // the artifact (not just the entry list — publint cannot see deep relative
  // imports, so this gate owns that invariant).
  it('the tarball contains every relative import of the lib entries', async () => {
    const pkgDir = fileURLToPath(new URL('..', import.meta.url))
    const libDir = join(pkgDir, 'lib')
    const entries = ['index.js', 'invariant.js', 'cli.js', 'client.js']
    for (const entry of entries) {
      expect(existsSync(join(libDir, entry)), `lib/${entry} missing — run the host build first`).toBe(true)
    }
    const tmp = tmpDir('guard-pack-')
    execFileSync('pnpm', ['pack', '--pack-destination', tmp], { cwd: pkgDir, stdio: 'pipe' })
    const tgz = readdirSync(tmp).find(name => name.endsWith('.tgz'))
    expect(tgz, 'pnpm pack produced a tarball').toBeDefined()
    const unpack = join(tmp, 'unpack')
    mkdirSync(unpack)
    execFileSync('tar', ['-xzf', join(tmp, tgz!), '-C', unpack], { stdio: 'pipe' })
    const artifactLib = join(unpack, 'package', 'lib')
    const jsFiles = readdirSync(artifactLib).filter(name => name.endsWith('.js'))
    expect(jsFiles.length, 'artifact lib contains the bundled js').toBeGreaterThanOrEqual(entries.length)
    for (const name of jsFiles) {
      const source = readFileSync(join(artifactLib, name), 'utf8')
      for (const match of source.matchAll(/from "(\.[^"]+)"/g)) {
        const target = resolve(artifactLib, match[1] ?? '')
        expect(existsSync(target), `${name} imports ${match[1]} which is missing from the artifact`).toBe(true)
      }
    }
    // The bin entry is a runnable shebang script, not just a bundled file.
    expect(readFileSync(join(artifactLib, 'cli.js'), 'utf8')).toMatch(/^#!\/usr\/bin\/env node/)
    // The restart-protocol skill ships with the package — apply() reads it
    // from <pkg>/skills/ and degrades to a bare warning when it is missing.
    expect(existsSync(join(unpack, 'package', 'skills', 'dsh-self-restart-guard', 'SKILL.md')),
      'the restart-protocol skill is missing from the tarball').toBe(true)
  })
})
