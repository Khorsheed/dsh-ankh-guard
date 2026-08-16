/**
 * Coverage for the self-restart guard: the pure state core (freshness,
 * HEAD binding, clear, checkpoint), the mounted cordis service over a real
 * git repository (record → verify → mutate → verify-denied → checkpoint →
 * reset), the Loader real-load path, the CLI end to end, and the invariant's
 * malformed-state check. Deterministic time is injected everywhere the core
 * reads the clock; git calls run against throwaway repositories.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as selfRestartGuard from '../src/index.ts'
import { currentHead } from '../src/git.ts'
import { install as installInvariant } from '../src/invariant.ts'
import {
  acknowledgeRestartRecord, pendingRestartRecord, readInterruptedSnapshot, restartContextText,
  writeInterruptedSnapshot,
} from '../src/restart-context.ts'
import { preflightInternals, resolvePreflightBin, runCli, type CliIo } from '../src/cli.ts'
import {
  clearCredential, emptyState, lastGoodBootRevision, loadState, recordCredential, setCheckpoint,
  verifyCredential, type GuardState,
} from '../src/state.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

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

describe('CLI', () => {
  const io = cliIo

  it('records and verifies, then denies after a new commit', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const flags = ['--state-dir', stateDir, '--repo', repo]

    const rec = io()
    expect(await runCli(['record', 'build+test', '--command', 'pnpm run build', ...flags], rec.io)).toBe(0)
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

  it('checkpoint warns (but still commits) when bare-tsc artifacts under src/ are swept in', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const flags = ['--state-dir', stateDir, '--repo', repo]
    mkdirSync(join(repo, 'packages', 'x', 'y', 'src'), { recursive: true })
    writeFileSync(join(repo, 'packages', 'x', 'y', 'src', 'index.js'), '// stray emit\n')
    writeFileSync(join(repo, 'packages', 'x', 'y', 'src', 'index.ts'), 'export {}\n')
    const cp = io()
    expect(await runCli(['checkpoint', '--message', 'batch', ...flags], cp.io)).toBe(0)
    expect(cp.out.join('')).toContain('1 build-artifact-looking')
    expect(cp.out.join('')).toContain('packages/x/y/src/index.js')
    // The commit still happened, artifact included — a checkpoint never refuses work.
    expect(execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' })).toContain('packages/x/y/src/index.js')
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
    await runCli(['record', 'build', ...flags], io().io)
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
    const port = 20000 + Math.floor(Math.random() * 15000)
    const server = spawnServer(port, 'old')
    try {
      await waitForPort(port)
      const io2 = io()
      expect(await runCli(
        ['restart', '--port', String(port), '--start', 'true', '--state-dir', stateDir, '--repo', repo],
        io2.io,
      )).toBe(1)
      expect(io2.err.join('')).toContain('restart refused')
      expect(await portListening(port)).toBe(true)
    } finally {
      await killListener(port)
      server.kill('SIGKILL')
    }
  })

  it('restart stops the old instance, starts the new one detached, and canaries it', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = 20000 + Math.floor(Math.random() * 15000)
    const oldServer = spawnServer(port, 'old')
    try {
      await waitForPort(port)
      await runCli(['record', 'build', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      const restarted = io()
      expect(await runCli(
        ['restart', '--port', String(port), '--start', startCmd, '--state-dir', stateDir, '--repo', repo],
        restarted.io,
      )).toBe(0)
      expect(restarted.out.join('')).toContain('restart + canary PASS')
      await waitForPort(port)
      expect(await fetchBody(port)).toBe('new')
    } finally {
      await killListener(port)
      oldServer.kill('SIGKILL')
    }
  })

  it('restart --delay-ms waits before stopping (graceful self-restart)', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = 20000 + Math.floor(Math.random() * 15000)
    const server = spawnServer(port, 'old')
    try {
      await waitForPort(port)
      await runCli(['record', 'build', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      const startCmd = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('new')).listen(${port},'127.0.0.1')"`
      const started = Date.now()
      const out = io()
      expect(await runCli(
        ['restart', '--port', String(port), '--start', startCmd, '--delay-ms', '500',
          '--state-dir', stateDir, '--repo', repo],
        out.io,
      )).toBe(0)
      expect(Date.now() - started).toBeGreaterThanOrEqual(450)
      expect(out.out.join('')).toContain('scheduled restart in 500 ms')
      expect(await fetchBody(port)).toBe('new')
    } finally {
      await killListener(port)
      server.kill('SIGKILL')
    }
  })

  it('restart --rollback resets to the checkpoint when the new instance never comes up', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = 20000 + Math.floor(Math.random() * 15000)
    const server = spawnServer(port, 'old')
    try {
      await waitForPort(port)
      const cp = io()
      expect(await runCli(['checkpoint', '--message', 'pre', '--state-dir', stateDir, '--repo', repo], cp.io)).toBe(0)
      const sha = cp.out.join('').trim().split(' ').pop()
      commitChange(repo)
      await runCli(['record', 'build', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      const broken = `"${process.execPath}" -e "process.exit(3)"`
      const failed = io()
      expect(await runCli(
        ['restart', '--port', String(port), '--start', broken, '--rollback', '--timeout-ms', '2000',
          '--state-dir', stateDir, '--repo', repo],
        failed.io,
      )).toBe(1)
      expect(failed.out.join('')).toContain('rolled back to last known-good')
      // No boot stamp: the pre-batch checkpoint outranks the credential.
      expect(currentHead(repo)).toBe(sha)
    } finally {
      await killListener(port)
      server.kill('SIGKILL')
    }
  })

  it('restart --rollback skips the reset when the target already is HEAD', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = 20000 + Math.floor(Math.random() * 15000)
    const server = spawnServer(port, 'old')
    try {
      await waitForPort(port)
      // Checkpoint and credential both bind the CURRENT HEAD: there is
      // nothing to roll back, and the dirty tree must survive.
      const cp = io()
      expect(await runCli(['checkpoint', '--message', 'pre', '--state-dir', stateDir, '--repo', repo], cp.io)).toBe(0)
      await runCli(['record', 'build', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('true')
      writeFileSync(join(repo, 'a.txt'), 'dirty')
      const broken = `"${process.execPath}" -e "process.exit(3)"`
      const failed = io()
      expect(await runCli(
        ['restart', '--port', String(port), '--start', broken, '--rollback', '--timeout-ms', '2000',
          '--state-dir', stateDir, '--repo', repo],
        failed.io,
      )).toBe(1)
      expect(failed.out.join('')).toContain('skipping reset')
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('dirty')
    } finally {
      await killListener(port)
      server.kill('SIGKILL')
    }
  })
})

describe('composition preflight gate', () => {
  const io = cliIo

  it('resolvePreflightBin finds the sibling app in this checkout and maps foreign layouts', () => {
    // The monorepo checkout resolves the source form (tsx) or the built one.
    const here = resolvePreflightBin()
    expect(here).toBeDefined()
    expect(here).toContain('apps')
    // The production seam resolves the same bin.
    expect(preflightInternals.resolveBin()).toBe(here)
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
    const out = io()
    expect(await runCli(['preflight', '--profile', "it's"], out.io)).toBe(0)
  })

  it('preflight exits 3 with a clear message when no sibling dsh app exists', async () => {
    stubPreflight(undefined)
    stubPreflightBin(() => undefined)
    const out = io()
    expect(await runCli(['preflight'], out.io)).toBe(3)
    expect(out.err.join('')).toContain('preflight unavailable outside the dsh app layout')
  })

  it('schedule-exit refuses when the composition preflight fails, quoting the diagnostics', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    await runCli(['record', 'build', '--state-dir', stateDir, '--repo', repo], io().io)
    const lines = Array.from({ length: 50 }, (_, i) => `console.error('layer ${i} failed')`).join(';')
    stubPreflight(`"${process.execPath}" -e "${lines}; process.exit(1)"`)
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', '3099', '--delay-ms', '100', '--state-dir', stateDir, '--repo', repo],
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
    await runCli(['record', 'build', '--state-dir', stateDir, '--repo', repo], io().io)
    stubPreflight(`"${process.execPath}" -e "process.exit(3)"`)
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', '3099', '--delay-ms', '100', '--state-dir', stateDir, '--repo', repo],
      out.io,
    )).toBe(1)
    expect(out.err.join('')).toContain('schedule-exit refused: the composition preflight itself failed')
    expect(out.err.join('')).toContain('NOT a verdict on the composition')
    expect(out.err.join('')).toContain('manual override')
  })

  it('schedule-exit refuses when the preflight times out', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    await runCli(['record', 'build', '--state-dir', stateDir, '--repo', repo], io().io)
    // exec replaces the shell, so the timeout's SIGKILL kills the sleeper itself.
    stubPreflight('exec sleep 10')
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', '3099', '--delay-ms', '100', '--preflight-timeout-ms', '300',
        '--state-dir', stateDir, '--repo', repo],
      out.io,
    )).toBe(1)
    expect(out.err.join('')).toContain('preflight timed out after 300 ms')
  }, 15_000)

  it('schedule-exit warns and proceeds when no sibling dsh app exists (standalone layout)', async () => {
    const repo = makeRepo()
    const home = tmpDir('guard-home-')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    })
    await runCli(['record', 'build', '--state-dir', join(home, 'state'), '--repo', repo], io().io)
    stubPreflight(undefined)
    stubPreflightBin(() => undefined)
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', '3099', '--delay-ms', '60000', '--state-dir', join(home, 'state'), '--repo', repo],
      out.io,
    )).toBe(0)
    expect(out.out.join('')).toContain('preflight unavailable outside the dsh app layout — proceeding without it')
    expect(out.out.join('')).toContain('exit scheduled')
  })

  it('restart refuses on a composition preflight failure without stopping the instance', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    const port = 20000 + Math.floor(Math.random() * 15000)
    const server = spawnServer(port, 'old')
    try {
      await waitForPort(port)
      await runCli(['record', 'build', '--state-dir', stateDir, '--repo', repo], io().io)
      stubPreflight('false')
      const out = io()
      expect(await runCli(
        ['restart', '--port', String(port), '--start', 'true', '--state-dir', stateDir, '--repo', repo],
        out.io,
      )).toBe(1)
      expect(out.err.join('')).toContain('restart refused: composition preflight failed')
      expect(await portListening(port)).toBe(true)
    } finally {
      await killListener(port)
      server.kill('SIGKILL')
    }
  })

  it('caps captured preflight output instead of growing without bound', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-cli-')
    await runCli(['record', 'build', '--state-dir', stateDir, '--repo', repo], io().io)
    stubPreflight(`"${process.execPath}" -e "process.stderr.write('x'.repeat(300000)); process.exit(1)"`)
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', '3099', '--delay-ms', '100', '--state-dir', stateDir, '--repo', repo],
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
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
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

/** Kill whatever listens on a port (lsof), best-effort. */
async function killListener(port: number): Promise<void> {
  try {
    const out = execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN', '-P'], { encoding: 'utf8' }).trim()
    for (const pid of out.split('\n')) {
      if (pid !== '') {
        try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ }
      }
    }
  } catch {
    // nothing listening — fine
  }
}

describe('supervise', () => {
  const io = cliIo

  /** Throwaway DSH_HOME isolation + watchdog cleanup for the spawned supervisor. */
  function supervisedEnv(): { home: string; restore: () => void; stop: () => void } {
    const home = tmpDir('guard-home-')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const stop = (): void => {
      try {
        mkdirSync(join(home, 'state'), { recursive: true })
        writeFileSync(join(home, 'state', 'watchdog-stop'), '')
        const pidfile = join(home, 'state', 'watchdog.pid')
        if (existsSync(pidfile)) {
          const pid = Number(readFileSync(pidfile, 'utf8').trim())
          if (Number.isInteger(pid)) {
            // The watchdog is setsid'd, so its process group == its pid; kill
            // the group so respawned children cannot leak past the test.
            try { process.kill(-pid, 'SIGKILL') } catch { /* not a group leader */ }
            try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
          }
        }
      } catch { /* best-effort */ }
    }
    const restore = (): void => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
    return { home, restore, stop }
  }

  it('spawns a watchdog that idles, then takes over when the current owner exits', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = 20000 + Math.floor(Math.random() * 15000)
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
      host.kill('SIGTERM')
      const deadline = Date.now() + 20_000
      let portDown = false
      while (Date.now() < deadline) {
        if (!portDown && !(await portListening(port))) portDown = true
        if (portDown && (await portListening(port))) break
        await new Promise((resolve) => { setTimeout(resolve, 300) })
      }
      expect(await fetchBody(port)).toBe('new')
    } finally {
      env.stop()
      host.kill('SIGKILL')
      await killListener(port)
      env.restore()
    }
  }, 30_000)

  it('reports an existing live watchdog instead of spawning a second', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = 20000 + Math.floor(Math.random() * 15000)
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

  it('schedule-exit refuses without a credential (the gate)', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const out = io()
    expect(await runCli(
      ['schedule-exit', '--port', '3099', '--delay-ms', '1000', '--state-dir', join(env.home, 'state'), '--repo', repo],
      out.io,
    )).toBe(1)
    expect(out.err.join('')).toContain('refused')
    env.restore()
  })

  it('schedule-exit fires a detached exit agent that kills the host; the watchdog takes over', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = 20000 + Math.floor(Math.random() * 15000)
    // Green credential in the throwaway state (bound to the throwaway HEAD).
    const rec = io()
    expect(await runCli(['record', 'build', '--repo', repo, '--state-dir', join(env.home, 'state')], rec.io)).toBe(0)
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
      host.kill('SIGKILL')
      await killListener(port)
      env.restore()
    }
  }, 30_000)

  it('rolls back to the deployment-proven boot stamp, leaving HEAD and WIP anchors', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = 20000 + Math.floor(Math.random() * 15000)
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
    const port = 20000 + Math.floor(Math.random() * 15000)
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
    const port = 20000 + Math.floor(Math.random() * 15000)
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
    const port = 20000 + Math.floor(Math.random() * 15000)
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
  }, 30_000)

  it('skips the reset when the rollback target already is HEAD — uncommitted work survives', async () => {
    const env = supervisedEnv()
    const repo = makeRepo()
    const port = 20000 + Math.floor(Math.random() * 15000)
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
    const entries = ['index.js', 'invariant.js', 'cli.js']
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
  })
})
