import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  findPidsOnPort, processIdentity, processIdentityMatches, signalProcessIdentity,
  type ProcessIdentity,
} from '../src/processes.ts'
import { TEMP_ARTIFACT_OWNER_FILE } from '../src/temp-artifact.ts'
import {
  TEST_RUN_DIR_ENV, TEST_RUN_TOKEN_ENV, type TestProcessLeaseRecord,
} from '../src/test-seam.ts'
import {
  formatMachineLeaseReport, inspectMachineTestLeases, reclaimMachineTestLeases,
  TestProcessLifecycle,
} from './helpers/process-lifecycle.ts'

const registerBin = fileURLToPath(new URL('../lib/test-seam-cli.js', import.meta.url))
const reclaimLockHolder = fileURLToPath(new URL('./fixtures/reclaim-lock-holder.ts', import.meta.url))
const tsxImport = createRequire(import.meta.url).resolve('tsx/esm')

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

async function captureGoneIdentity(): Promise<ProcessIdentity> {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  if (child.pid === undefined) throw new Error('identity fixture spawn returned no pid')
  let identity: ProcessIdentity | null = null
  try {
    expect(await waitUntil(() => {
      identity = processIdentity(child.pid!)
      return identity !== null
    })).toBe(true)
  } finally {
    try { process.kill(child.pid, 'SIGTERM') } catch { /* already gone */ }
    await new Promise<void>(resolve => child.once('close', () => { resolve() }))
  }
  return identity!
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
}

function unusedFixturePort(root: string, excluded: ReadonlySet<number> = new Set()): number {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const port = 50_000 + Math.floor(Math.random() * 15_000)
    if (!excluded.has(port) && !existsSync(join(root, 'ports', `${port}.json`))) return port
  }
  throw new Error('could not select an unused fixture port record')
}

describe('watchdog test process lifecycle', () => {
  it('owns a detached process group by immutable identity and leaves its leased port empty', async () => {
    const lifecycle = new TestProcessLifecycle(registerBin)
    const port = await lifecycle.acquirePort()
    const child = spawn(process.execPath, ['-e', `require('net').createServer(()=>{}).listen(${port},'127.0.0.1')`], {
      detached: true,
      stdio: 'ignore',
      env: lifecycle.childEnv('lifecycle-listener', process.env, { port }),
    })
    const record = lifecycle.track(child, 'lifecycle-listener', { port })
    expect(record).not.toBeNull()
    try {
      expect(await waitUntil(() => findPidsOnPort(port).length === 1)).toBe(true)
    } finally {
      await lifecycle.teardown()
    }
    expect(processIdentityMatches(record!)).toBe(false)
    expect(findPidsOnPort(port)).toEqual([])
  })

  it('escalates from TERM to KILL when a registered child ignores graceful shutdown', async () => {
    const lifecycle = new TestProcessLifecycle(registerBin)
    const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], {
      detached: true,
      stdio: 'ignore',
      env: lifecycle.childEnv('term-resistant-child'),
    })
    const record = lifecycle.track(child, 'term-resistant-child')
    expect(record).not.toBeNull()
    await new Promise(resolve => setTimeout(resolve, 100))
    const started = performance.now()
    await lifecycle.teardown()
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_900)
    expect(processIdentityMatches(record!)).toBe(false)
  }, 10_000)

  it('records the real macOS Bash background-function pid instead of the outer $$ value', async () => {
    const lifecycle = new TestProcessLifecycle(registerBin)
    const port = await lifecycle.acquirePort()
    const child = spawn('bash', ['-c', `worker() {
  node "$ANKH_GUARD_TEST_REGISTER_BIN" register-parent instance-wrapper
  node "$ANKH_GUARD_TEST_REGISTER_BIN" event-parent instance-wrapper ready
  node -e "require('net').createServer(()=>{}).listen(${port},'127.0.0.1')"
}
worker & wait`], {
      detached: true,
      stdio: 'ignore',
      env: lifecycle.childEnv('shell-launcher', process.env, { port }),
    })
    lifecycle.track(child, 'shell-launcher', { port })
    try {
      expect(await waitUntil(() => findPidsOnPort(port).length === 1)).toBe(true)
      expect(await waitUntil(() => lifecycle.events().some(event =>
        event.role === 'instance-wrapper' && event.event === 'ready' && event.pid !== child.pid,
      ))).toBe(true)
    } finally {
      await lifecycle.teardown()
    }
    expect(findPidsOnPort(port)).toEqual([])
  })

  it('does not honor the short-sleep knob without explicit test-run coordinates', async () => {
    const lifecycle = new TestProcessLifecycle(registerBin)
    const port = await lifecycle.acquirePort()
    const home = join(lifecycle.runDir, 'unscaled-home')
    const stateDir = join(home, 'state')
    mkdirSync(join(home, 'home'), { recursive: true })
    const env = lifecycle.childEnv('unscaled-watchdog', process.env, { port, tempRoot: stateDir })
    delete env[TEST_RUN_DIR_ENV]
    delete env[TEST_RUN_TOKEN_ENV]
    const script = fileURLToPath(new URL('../scripts/dsh-watchdog.sh', import.meta.url))
    const started = performance.now()
    let output = ''
    const child = spawn('bash', [script, '--supervise'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, WD_HOME: home, WD_PORT: String(port), WD_TEST_BREAK: '1' },
    })
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    lifecycle.track(child, 'unscaled-watchdog', { port, tempRoot: stateDir })
    try {
      const failedOnce = await waitUntil(() => output.includes('failure #1'), 15_000)
      expect(failedOnce, `${output}\n${lifecycle.diagnostics()}`).toBe(true)
      expect(performance.now() - started).toBeGreaterThanOrEqual(900)
    } finally {
      await lifecycle.teardown()
    }
  }, 25_000)

  it('reports dead records separately from over-age live identities without cleaning either by port', async () => {
    const lifecycle = new TestProcessLifecycle(registerBin)
    const live = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore', env: lifecycle.childEnv('report-live-child'),
    })
    const liveRecord = lifecycle.track(live, 'report-live-child')
    expect(liveRecord).not.toBeNull()
    const gone = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),100)'], {
      stdio: 'ignore', env: lifecycle.childEnv('report-gone-child'),
    })
    expect(lifecycle.track(gone, 'report-gone-child')).not.toBeNull()
    await new Promise<void>(resolve => gone.once('close', () => { resolve() }))
    try {
      const report = inspectMachineTestLeases(Date.now() + 2 * 60 * 60_000, 60 * 60_000)
      expect(report.reclaimable.some(item => 'runToken' in item.record && item.record.runToken === lifecycle.runToken)).toBe(true)
      expect(report.overAgeLive.some(item => item.record.runToken === lifecycle.runToken && 'role' in item.record && item.record.role === 'report-live-child')).toBe(true)
      expect(formatMachineLeaseReport(report)).toContain('over-age-live-human-review')
      expect(processIdentityMatches(liveRecord!)).toBe(true)
    } finally {
      await lifecycle.teardown()
    }
  })

  it('uses one machine-wide namespace so independent run leases never return the same port', async () => {
    const first = new TestProcessLifecycle(registerBin)
    const second = new TestProcessLifecycle(registerBin)
    try {
      const [firstPort, secondPort] = await Promise.all([first.acquirePort(), second.acquirePort()])
      expect(secondPort).not.toBe(firstPort)
    } finally {
      await second.teardown()
      await first.teardown()
    }
  })

  it('serializes reclaim across processes and releases the lock for the next owner', async () => {
    const scopeRoot = mkdtempSync(join(tmpdir(), 'guard-reclaim-lock-spec-'))
    const root = join(scopeRoot, 'leases')
    const scope = { root, tempBase: scopeRoot }
    const expectedMachineRoot = join(
      tmpdir(),
      `dsh-ankh-guard-test-leases-${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}`,
    )
    expect(inspectMachineTestLeases().root).toBe(expectedMachineRoot)

    const holder = spawn(process.execPath, ['--import', tsxImport, reclaimLockHolder, root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines = createInterface({ input: holder.stdout! })
    const closed = once(holder, 'close')
    let stderr = ''
    let holderIdentity: ProcessIdentity | null = null
    holder.stderr?.on('data', chunk => { stderr += chunk.toString() })
    try {
      const acquired = once(lines, 'line', { signal: AbortSignal.timeout(15_000) })
      expect((await acquired)[0], stderr).toBe('acquired')
      expect(holder.pid).toBeDefined()
      holderIdentity = processIdentity(holder.pid!)
      expect(holderIdentity).not.toBeNull()

      const busy = reclaimMachineTestLeases(Date.now(), 0, scope)
      expect(busy.lock).toBe('busy')

      const released = once(lines, 'line', { signal: AbortSignal.timeout(5_000) })
      holder.stdin?.end('release\n')
      expect((await released)[0], stderr).toBe('released')
      const [code, signal] = await closed
      expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: '' })

      const next = reclaimMachineTestLeases(Date.now(), 0, scope)
      expect(next.lock).toBe('acquired')
    } finally {
      lines.close()
      const cleanupIdentity = holderIdentity ?? (holder.pid === undefined ? null : processIdentity(holder.pid))
      if (cleanupIdentity !== null && processIdentityMatches(cleanupIdentity)) {
        signalProcessIdentity(cleanupIdentity, 'SIGKILL')
        await closed
      }
      rmSync(scopeRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('reclaims only old identity-proven runs and marked snapshots without following unsafe paths', async () => {
    const scopeRoot = mkdtempSync(join(tmpdir(), 'guard-reclaim-scope-'))
    const root = join(scopeRoot, 'leases')
    const scope = { root, tempBase: scopeRoot }
    const dead = await captureGoneIdentity()
    const old = Date.now() - 2 * 24 * 60 * 60_000
    const runToken = randomUUID()
    const runDir = join(root, 'runs', runToken)
    const processDir = join(runDir, 'processes')
    const tempRoot = mkdtempSync(join(scopeRoot, 'guard-reclaim-test-'))
    const nestedTempRoot = join(tempRoot, 'state')
    const port = unusedFixturePort(root)
    const portFile = join(root, 'ports', `${port}.json`)
    const livePort = unusedFixturePort(root, new Set([port]))
    const livePortFile = join(root, 'ports', `${livePort}.json`)
    const outsideRoot = mkdtempSync(join(tmpdir(), 'guard-reclaim-outside-'))
    const outsideSentinel = join(outsideRoot, 'sentinel.txt')
    const unsafeToken = randomUUID()
    const unsafeRunDir = join(root, 'runs', unsafeToken)
    const liveToken = randomUUID()
    const liveRunDir = join(root, 'runs', liveToken)
    const snapshotRoot = mkdtempSync(join(scopeRoot, 'ankh-transition-preflight-'))
    const legacySnapshotRoot = mkdtempSync(join(scopeRoot, 'ankh-transition-preflight-'))
    const canonicalTempRoot = realpathSync(tempRoot)
    const canonicalSnapshotRoot = realpathSync(snapshotRoot)
    mkdirSync(nestedTempRoot, { recursive: true })
    writeFileSync(join(nestedTempRoot, 'payload.txt'), 'dead-run')
    writeFileSync(outsideSentinel, 'must-survive')
    mkdirSync(processDir, { recursive: true })
    mkdirSync(join(root, 'ports'), { recursive: true })
    mkdirSync(join(unsafeRunDir, 'processes'), { recursive: true })
    const runRecord = { version: 1, runToken, createdAt: old, owner: dead, cwd: process.cwd() }
    const processRecord: TestProcessLeaseRecord = {
      version: 1, runToken, role: 'reclaim-dead-child', ...dead,
      pgid: dead.pid, groupRoot: true, registeredAt: old,
      source: 'parent-observer', tempRoot: nestedTempRoot, port,
    }
    const unsafeProcessRecord: TestProcessLeaseRecord = {
      ...processRecord, runToken: unsafeToken, role: 'reclaim-unsafe-child', tempRoot: outsideRoot,
    }
    writeJson(join(runDir, 'run.json'), runRecord)
    writeJson(join(processDir, `${dead.pid}-dead.json`), processRecord)
    writeJson(portFile, { version: 1, runToken, port, createdAt: old, owner: dead, runDir })
    writeJson(join(unsafeRunDir, 'run.json'), { ...runRecord, runToken: unsafeToken })
    writeJson(join(unsafeRunDir, 'processes', `${dead.pid}-unsafe.json`), unsafeProcessRecord)
    writeJson(join(snapshotRoot, TEMP_ARTIFACT_OWNER_FILE), {
      version: 1, kind: 'preflight-snapshot', createdAt: old, owner: dead,
    })
    writeFileSync(join(snapshotRoot, 'payload.txt'), 'marked-snapshot')
    writeFileSync(join(legacySnapshotRoot, 'payload.txt'), 'legacy-snapshot')

    try {
      const result = reclaimMachineTestLeases(Date.now(), 24 * 60 * 60_000, scope)
      expect(result.lock).toBe('acquired')
      expect(result.errors.filter(item => [runDir, portFile, tempRoot, snapshotRoot].some(path => item.path.startsWith(path)))).toEqual([])
      expect(result.removedRuns).toContain(runDir)
      expect(result.removedPortLeases).toContain(portFile)
      expect(result.removedTempRoots).toEqual(expect.arrayContaining([canonicalTempRoot, canonicalSnapshotRoot]))
      expect(existsSync(runDir)).toBe(false)
      expect(existsSync(portFile)).toBe(false)
      expect(existsSync(tempRoot)).toBe(false)
      expect(existsSync(snapshotRoot)).toBe(false)
      expect(existsSync(unsafeRunDir)).toBe(true)
      expect(readFileSync(outsideSentinel, 'utf8')).toBe('must-survive')
      expect(existsSync(legacySnapshotRoot)).toBe(true)

      const mine = processIdentity(process.pid)
      expect(mine).not.toBeNull()
      mkdirSync(liveRunDir, { recursive: true })
      writeJson(join(liveRunDir, 'run.json'), {
        version: 1, runToken: liveToken, createdAt: old, owner: mine, cwd: process.cwd(),
      })
      writeJson(livePortFile, {
        version: 1, runToken: liveToken, port: livePort, createdAt: old, owner: mine, runDir: liveRunDir,
      })
      const second = reclaimMachineTestLeases(Date.now(), 24 * 60 * 60_000, scope)
      expect(second.lock).toBe('acquired')
      expect(second.errors.filter(item => item.path.startsWith(liveRunDir))).toEqual([])
      expect(existsSync(liveRunDir)).toBe(true)
      expect(existsSync(livePortFile)).toBe(true)
      rmSync(liveRunDir, { recursive: true, force: true })
    } finally {
      rmSync(runDir, { recursive: true, force: true })
      rmSync(unsafeRunDir, { recursive: true, force: true })
      rmSync(liveRunDir, { recursive: true, force: true })
      rmSync(tempRoot, { recursive: true, force: true })
      rmSync(snapshotRoot, { recursive: true, force: true })
      rmSync(legacySnapshotRoot, { recursive: true, force: true })
      rmSync(outsideRoot, { recursive: true, force: true })
      rmSync(portFile, { force: true })
      rmSync(livePortFile, { force: true })
      rmSync(scopeRoot, { recursive: true, force: true })
    }
  })
})
