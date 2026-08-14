/**
 * Coverage for the self-restart guard: the pure state core (freshness,
 * HEAD binding, clear, checkpoint), the mounted cordis service over a real
 * git repository (record → verify → mutate → verify-denied → checkpoint →
 * reset), the Loader real-load path, the CLI end to end, and the invariant's
 * malformed-state check. Deterministic time is injected everywhere the core
 * reads the clock; git calls run against throwaway repositories.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as selfRestartGuard from '../src/index.ts'
import { currentHead } from '../src/git.ts'
import { install as installInvariant } from '../src/invariant.ts'
import {
  acknowledgeRestartRecord, pendingRestartRecord, restartContextText,
} from '../src/restart-context.ts'
import { appendFeedback, readFeedback, MAX_FEEDBACK_ENTRIES } from '../src/feedback.ts'
import { runCli, type CliIo } from '../src/cli.ts'
import {
  clearCredential, emptyState, loadState, recordCredential, setCheckpoint,
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
      const broken = `"${process.execPath}" -e "process.exit(3)"`
      const failed = io()
      expect(await runCli(
        ['restart', '--port', String(port), '--start', broken, '--rollback', '--timeout-ms', '2000',
          '--state-dir', stateDir, '--repo', repo],
        failed.io,
      )).toBe(1)
      expect(failed.out.join('')).toContain('rolled back to checkpoint')
      expect(currentHead(repo)).toBe(sha)
    } finally {
      await killListener(port)
      server.kill('SIGKILL')
    }
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

  it('falls back to any root agent when the initiator session is gone', async () => {
    const repo = makeRepo()
    const stateDir = tmpDir('guard-ctx-')
    writeFileSync(join(stateDir, 'last-restart.json'),
      JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: 'session-gone' }))
    const followup = vi.fn()
    const agent = { id: 'session-live', followup } as never
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.provide('agents', {
      roots: () => [agent],
      list: () => [agent],
    } as never)
    // The initiator is absent from persistence: fall back immediately, no grace wait.
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5 })
    await fiber.await()
    ctx.emit('agent/created', { agent })
    await Promise.resolve() // let the async persistence check settle
    expect(followup).toHaveBeenCalledTimes(1)
    expect(pendingRestartRecord(stateDir)).toBeNull()
    await fiber.dispose()
  })

  it('does not double-claim when the initiator claims while the persistence list is in flight', async () => {
    vi.useFakeTimers()
    try {
      const repo = makeRepo()
      const stateDir = tmpDir('guard-ctx-')
      const initiatorId = 'session-init'
      const otherId = 'session-other'
      writeFileSync(join(stateDir, 'last-restart.json'),
        JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: initiatorId }))
      const otherFollowup = vi.fn()
      const initiatorFollowup = vi.fn()
      const otherAgent = { id: otherId, followup: otherFollowup } as never
      const initiatorAgent = { id: initiatorId, followup: initiatorFollowup } as never
      const ctx = new Context()
      await ctx.plugin(Loader)
      let liveAgents: unknown[] = [otherAgent]
      ctx.provide('agents', {
        roots: () => liveAgents,
        list: () => liveAgents,
      } as never)
      // A deferred list: the resolution arrives only after the initiator has
      // claimed, so the stale `.then` must re-check the record identity.
      let resolveList!: (sessions: Array<{ id: string }>) => void
      ctx.provide('sessionPersistence', { list: () => new Promise((resolve) => { resolveList = resolve }) } as never)
      const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, fallbackGraceMs: 10_000 })
      await fiber.await()
      // Non-initiator resumes first; the persistence check is now in flight.
      ctx.emit('agent/created', { agent: otherAgent })
      await Promise.resolve()
      // The initiator resumes and claims while list() is unresolved.
      liveAgents = [otherAgent, initiatorAgent]
      ctx.emit('agent/created', { agent: initiatorAgent })
      await Promise.resolve()
      expect(initiatorFollowup).toHaveBeenCalledTimes(1)
      expect(otherFollowup).not.toHaveBeenCalled()
      expect(pendingRestartRecord(stateDir)).toBeNull()
      // Now the stale list resolution lands: it must NOT claim again.
      resolveList([])
      await Promise.resolve()
      expect(initiatorFollowup).toHaveBeenCalledTimes(1)
      expect(otherFollowup).not.toHaveBeenCalled()
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms the grace timer for a record replaced during a pending window', async () => {
    vi.useFakeTimers()
    try {
      const repo = makeRepo()
      const stateDir = tmpDir('guard-ctx-')
      const initiatorId = 'session-init'
      const otherId = 'session-other'
      const otherFollowup = vi.fn()
      const otherAgent = { id: otherId, followup: otherFollowup } as never
      const ctx = new Context()
      await ctx.plugin(Loader)
      const liveAgents: unknown[] = [otherAgent]
      ctx.provide('agents', {
        roots: () => liveAgents,
        list: () => liveAgents,
      } as never)
      ctx.provide('sessionPersistence', { list: async () => [{ id: initiatorId }] } as never)
      const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, fallbackGraceMs: 10_000 })
      await fiber.await()
      // Restart 1 arms the timer for the first record.
      writeFileSync(join(stateDir, 'last-restart.json'),
        JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: initiatorId }))
      ctx.emit('agent/created', { agent: otherAgent })
      await Promise.resolve()
      expect(otherFollowup).not.toHaveBeenCalled()
      // Halfway through the window, restart 2 replaces the record. Its own
      // created event cannot arm a second timer (the singleton guard), so the
      // first timer must re-arm the new record when it fires and finds the
      // identity changed.
      writeFileSync(join(stateDir, 'last-restart.json'),
        JSON.stringify({ exitAt: 1_700_000_000_001, pid: 9, initiator: initiatorId }))
      ctx.emit('agent/created', { agent: otherAgent })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10_000) // old timer fires, identity mismatch → re-arms new record
      expect(otherFollowup).not.toHaveBeenCalled() // new record still inside its fresh window
      await vi.advanceTimersByTimeAsync(10_000) // re-armed timer expires → fallback
      expect(otherFollowup).toHaveBeenCalledTimes(1)
      expect(pendingRestartRecord(stateDir)).toBeNull()
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits out the grace window when the initiator is persisted but slow to resume', async () => {
    vi.useFakeTimers()
    try {
      const repo = makeRepo()
      const stateDir = tmpDir('guard-ctx-')
      const initiatorId = 'session-init'
      const otherId = 'session-other'
      writeFileSync(join(stateDir, 'last-restart.json'),
        JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: initiatorId }))
      const otherFollowup = vi.fn()
      const initiatorFollowup = vi.fn()
      const otherAgent = { id: otherId, followup: otherFollowup } as never
      const initiatorAgent = { id: initiatorId, followup: initiatorFollowup } as never
      const ctx = new Context()
      await ctx.plugin(Loader)
      let liveAgents: unknown[] = [otherAgent]
      ctx.provide('agents', {
        roots: () => liveAgents,
        list: () => liveAgents,
      } as never)
      ctx.provide('sessionPersistence', { list: async () => [{ id: initiatorId }] } as never)
      const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, fallbackGraceMs: 10_000 })
      await fiber.await()
      // Non-initiator resumes first: within the grace window it must NOT claim.
      ctx.emit('agent/created', { agent: otherAgent })
      await Promise.resolve()
      expect(otherFollowup).not.toHaveBeenCalled()
      expect(initiatorFollowup).not.toHaveBeenCalled()
      // The initiator resumes inside the window: its own creation claims it.
      liveAgents = [otherAgent, initiatorAgent]
      ctx.emit('agent/created', { agent: initiatorAgent })
      await Promise.resolve()
      expect(initiatorFollowup).toHaveBeenCalledTimes(1)
      expect(otherFollowup).not.toHaveBeenCalled()
      expect(pendingRestartRecord(stateDir)).toBeNull()
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the first live root agent once the grace window elapses', async () => {
    vi.useFakeTimers()
    try {
      const repo = makeRepo()
      const stateDir = tmpDir('guard-ctx-')
      const initiatorId = 'session-init'
      writeFileSync(join(stateDir, 'last-restart.json'),
        JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: initiatorId }))
      const followup = vi.fn()
      const agent = { id: 'session-live', followup } as never
      const ctx = new Context()
      await ctx.plugin(Loader)
      ctx.provide('agents', {
        roots: () => [agent],
        list: () => [agent],
      } as never)
      ctx.provide('sessionPersistence', { list: async () => [{ id: initiatorId }] } as never)
      const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, fallbackGraceMs: 10_000 })
      await fiber.await()
      ctx.emit('agent/created', { agent })
      await Promise.resolve()
      expect(followup).not.toHaveBeenCalled()
      // Elapse the grace window: the initiator never resumed, so fall back.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(followup).toHaveBeenCalledTimes(1)
      expect(pendingRestartRecord(stateDir)).toBeNull()
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a stale grace timer ack a newer restart record', async () => {
    vi.useFakeTimers()
    try {
      const repo = makeRepo()
      const stateDir = tmpDir('guard-ctx-')
      const initiatorId = 'session-init'
      writeFileSync(join(stateDir, 'last-restart.json'),
        JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: initiatorId }))
      const followup = vi.fn()
      const agent = { id: 'session-live', followup } as never
      const ctx = new Context()
      await ctx.plugin(Loader)
      ctx.provide('agents', {
        roots: () => [agent],
        list: () => [agent],
      } as never)
      ctx.provide('sessionPersistence', { list: async () => [{ id: initiatorId }] } as never)
      const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, fallbackGraceMs: 10_000 })
      await fiber.await()
      ctx.emit('agent/created', { agent })
      await Promise.resolve()
      expect(followup).not.toHaveBeenCalled()
      // A second restart replaces the record with a new exitAt while the
      // first timer is pending: the stale timer must not ack the new record.
      writeFileSync(join(stateDir, 'last-restart.json'),
        JSON.stringify({ exitAt: 1_700_000_000_001, pid: 9, initiator: initiatorId }))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(followup).not.toHaveBeenCalled()
      expect(pendingRestartRecord(stateDir)).not.toBeNull()
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the record for the next creation when no root agent is live at grace expiry', async () => {
    vi.useFakeTimers()
    try {
      const repo = makeRepo()
      const stateDir = tmpDir('guard-ctx-')
      const initiatorId = 'session-init'
      writeFileSync(join(stateDir, 'last-restart.json'),
        JSON.stringify({ exitAt: 1_700_000_000_000, pid: 9, initiator: initiatorId }))
      const followup = vi.fn()
      const agent = { id: 'session-live', followup } as never
      const ctx = new Context()
      await ctx.plugin(Loader)
      let liveAgents: unknown[] = []
      ctx.provide('agents', {
        roots: () => liveAgents,
        list: () => liveAgents,
      } as never)
      ctx.provide('sessionPersistence', { list: async () => [{ id: initiatorId }] } as never)
      const fiber = ctx.plugin(selfRestartGuard, { stateDir, repoDir: repo, maxAgeMinutes: 5, fallbackGraceMs: 10_000 })
      await fiber.await()
      // Resume the only root agent, then drop it before the grace elapses.
      liveAgents = [agent]
      ctx.emit('agent/created', { agent })
      await Promise.resolve()
      liveAgents = []
      await vi.advanceTimersByTimeAsync(10_000)
      expect(followup).not.toHaveBeenCalled()
      expect(pendingRestartRecord(stateDir)).not.toBeNull()
      // A later creation arms the window again and claims on expiry.
      liveAgents = [agent]
      ctx.emit('agent/created', { agent })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(followup).toHaveBeenCalledTimes(1)
      expect(pendingRestartRecord(stateDir)).toBeNull()
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
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
})

describe('feedback board', () => {
  it('appends structured entries and reads them back newest-last', () => {
    const dir = join(tmpDir('guard-fb-'), 'state')
    appendFeedback(dir, { ts: 1, command: 'dsh-ankh-guard feedback "x"', description: 'first' })
    appendFeedback(dir, { ts: 2, command: 'verify', description: 'second', revision: 'abc' })
    const entries = readFeedback(dir)
    expect(entries).toHaveLength(2)
    expect(entries[1]?.description).toBe('second')
    expect(entries[1]?.revision).toBe('abc')
    // The file lives in the runtime area (home/feedback), never the repo.
    expect(existsSync(join(dirname(dir), 'feedback', 'dsh-self-restart-guard.jsonl'))).toBe(true)
  })

  it('rolls older entries off the cap, keeping the newest', () => {
    const dir = join(tmpDir('guard-fb-'), 'state')
    for (let i = 0; i < MAX_FEEDBACK_ENTRIES + 10; i++) {
      appendFeedback(dir, { ts: i, command: 'c', description: `entry ${i}` })
    }
    const entries = readFeedback(dir, 500)
    expect(entries).toHaveLength(MAX_FEEDBACK_ENTRIES)
    expect(entries[0]?.description).toBe('entry 10')
    expect(entries[MAX_FEEDBACK_ENTRIES - 1]?.description).toBe(`entry ${MAX_FEEDBACK_ENTRIES + 9}`)
  })

  it('CLI feedback appends and lists', async () => {
    const dir = join(tmpDir('guard-fb-'), 'state')
    const out = cliIo()
    expect(await runCli(['feedback', 'canary 误判', '--state-dir', dir], out.io)).toBe(0)
    expect(out.out.join('')).toContain('feedback recorded')
    const list = cliIo()
    expect(await runCli(['feedback', 'list', '--state-dir', dir], list.io)).toBe(0)
    expect(list.out.join('')).toContain('canary 误判')
    const usage = cliIo()
    expect(await runCli(['feedback', '--state-dir', dir], usage.io)).toBe(2)
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
