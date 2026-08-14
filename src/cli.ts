#!/usr/bin/env node
/**
 * CLI for the self-restart guard — the interface the agent and the launcher
 * use without booting the app, so the gate works even while the instance is
 * down. Run from source: `node --import tsx/esm src/cli.ts <command>`; as a
 * published package: the `dsh-ankh-guard` bin or `node lib/cli.js <command>`.
 *
 * Commands:
 *   verify   — is a fresh, HEAD-bound green credential present? (exit 0/1)
 *   record   — record a green credential for the current HEAD
 *   status   — print the full state (credential, checkpoint, audit)
 *   clear    — drop the credential
 *   checkpoint — commit the whole tree as a pre-batch snapshot
 *   reset    — `git reset --hard` to a checkpoint commit (rollback)
 *   canary   — post-restart probe: verify (+ optional TCP port check)
 *   restart  — DETACHED restart: gate → stop → start → probe → canary.
 *              Owns the whole loop in a process that outlives the restarted
 *              instance, so the post-restart canary runs even though the
 *              instance restart killed the session that used to own it.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveRepoDir, resolveStateDir } from './defaults.ts'
import { commitCheckpoint, currentHead, resetToCheckpoint } from './git.ts'
import {
  clearCredential, loadState, recordCredential, setCheckpoint, verifyCredential,
} from './state.ts'

/** Parsed CLI options; empty stateDir/repoDir mean "use defaults". */
interface CliOptions {
  stateDir: string
  repoDir: string
  maxAgeMinutes: number
  port: number | undefined
  command: string | undefined
  message: string | undefined
  start: string | undefined
  pid: string | undefined
  timeoutMs: number | undefined
  delayMs: number | undefined
  log: string | undefined
  foreground: boolean
  rollback: boolean
  initiator: string | undefined
}

/** stdout/stderr sink (injected so tests capture output). */
export interface CliIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
}

const USAGE = `usage: dsh-ankh-guard <command> [args] [flags]
commands:
  verify [--state-dir DIR] [--repo DIR] [--max-age MIN]
  record <scope> [--command CMD] [--state-dir DIR] [--repo DIR]
  status [--state-dir DIR]
  clear [--state-dir DIR]
  checkpoint [--message MSG] [--repo DIR] [--state-dir DIR]
  reset <sha> [--repo DIR]
  canary [--port N] [--state-dir DIR] [--repo DIR] [--max-age MIN]
  restart --port N --start "CMD" [--pid PID] [--timeout-ms MS] [--delay-ms MS] [--rollback]
          [--state-dir DIR] [--repo DIR] [--max-age MIN]
  schedule-exit --port N --delay-ms MS [--initiator ID] [--log FILE] [--state-dir DIR] [--repo DIR]
  supervise --port N --start "CMD" [--foreground] [--log FILE] [--state-dir DIR] [--repo DIR]
flags:
  --state-dir DIR  state directory (default: $DSH_HOME/state, else <cwd>/.dsh-guard-state)
  --repo DIR       repository the credential binds to (default: cwd)
  --max-age MIN    credential freshness window in minutes (default: 10)
  --port N         canary/restart/supervise: TCP port that must be listening
  --command CMD    record: the command that produced the green state
  --message MSG    checkpoint: batch description
  --start "CMD"    restart/supervise: the shell command that starts the instance
  --pid PID        restart: process to stop (default: the listener on --port)
  --timeout-ms MS  restart: how long to wait for the new instance to listen (default 60000)
  --delay-ms MS    restart: sleep before stopping, so the current turn can finish first
                   (agent-driven graceful self-restart: schedule, complete, then restart);
                   schedule-exit: delay before the detached exit agent kills the host
  --log FILE       supervise/schedule-exit: watchdog/exit-agent log file (default: <home>/state/*.log)
  --initiator ID   schedule-exit: session id that requested the exit (default: $DSH_SESSION_ID);
                   recorded in last-restart.json so the restart report returns to that session
  --rollback       restart: on failure, git reset --hard to the recorded checkpoint
`

/** Parse argv into a command, positionals, and options. */
export function parse(
  argv: readonly string[],
): { error: string } | { command: string; positionals: readonly string[]; options: CliOptions } {
  const options: CliOptions = {
    stateDir: '', repoDir: '', maxAgeMinutes: 10, port: undefined, command: undefined, message: undefined,
    start: undefined, pid: undefined, timeoutMs: undefined, delayMs: undefined, log: undefined,
    foreground: false, rollback: false, initiator: undefined,
  }
  const positionals: string[] = []
  let i = 0
  const flagValue = (flag: string, required: boolean): string | undefined => {
    const value = argv[i + 1]
    if (required && (value === undefined || value.startsWith('--'))) {
      throw new Error(`${flag} requires a value`)
    }
    return value
  }
  try {
    for (; i < argv.length; i++) {
      const arg = argv[i] ?? ''
      switch (arg) {
        case '--state-dir': options.stateDir = flagValue(arg, true) ?? ''; i++; break
        case '--repo': options.repoDir = flagValue(arg, true) ?? ''; i++; break
        case '--max-age': {
          const raw = flagValue(arg, true)
          const n = Number(raw)
          if (raw === undefined || !Number.isInteger(n) || n < 1) throw new Error('--max-age must be a positive integer')
          options.maxAgeMinutes = n
          i++
          break
        }
        case '--port': {
          const raw = flagValue(arg, true)
          const n = Number(raw)
          if (raw === undefined || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be an integer in 1..65535')
          options.port = n
          i++
          break
        }
        case '--command': options.command = flagValue(arg, true) ?? ''; i++; break
        case '--message': options.message = flagValue(arg, true) ?? ''; i++; break
        case '--start': options.start = flagValue(arg, true) ?? ''; i++; break
        case '--log': options.log = flagValue(arg, true) ?? ''; i++; break
        case '--pid': options.pid = flagValue(arg, true) ?? ''; i++; break
        case '--timeout-ms': {
          const raw = flagValue(arg, true)
          const n = Number(raw)
          if (raw === undefined || !Number.isInteger(n) || n < 100) throw new Error('--timeout-ms must be an integer >= 100')
          options.timeoutMs = n
          i++
          break
        }
        case '--delay-ms': {
          const raw = flagValue(arg, true)
          const n = Number(raw)
          if (raw === undefined || !Number.isInteger(n) || n < 0) throw new Error('--delay-ms must be a non-negative integer')
          options.delayMs = n
          i++
          break
        }
        case '--foreground': options.foreground = true; break
        case '--initiator': options.initiator = flagValue(arg, true) ?? ''; i++; break
        case '--rollback': options.rollback = true; break
        case '--help':
        case '-h':
          return { error: USAGE }
        default:
          if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`)
          positionals.push(arg)
      }
    }
  } catch (error) {
    return { error: `${String(error)}\n\n${USAGE}` }
  }
  const command = positionals[0]
  if (command === undefined) return { error: USAGE }
  return { command, positionals: positionals.slice(1), options }
}

/** Probe whether a TCP port is listening (bounded, never hangs). */
async function checkPort(port: number): Promise<boolean> {
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

/** Sleep helper for bounded polling loops. */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * How the spawned watchdog should invoke the guard CLI: the built form runs
 * `node <cli>`; the source form needs tsx with an absolute path (the watchdog
 * runs with a deployment cwd that resolves no node_modules).
 * @returns the command prefix (verb args are appended by the watchdog).
 */
function guardInvocation(): string {
  const cliPath = fileURLToPath(import.meta.url)
  if (cliPath.includes(`${sep}src${sep}`)) {
    // Source form: locate the tsx loader relative to this file's own
    // node_modules (works in the monorepo checkout and in a standalone
    // package tree alike), falling back to plain node when absent.
    const nodeModules = resolve(dirname(cliPath), '../../../node_modules')
    const tsx = join(nodeModules, 'tsx', 'dist', 'esm', 'index.mjs')
    if (existsSync(tsx)) return `node --import ${tsx} ${cliPath}`
    return `node ${cliPath}`
  }
  return `node ${cliPath}`
}

/** The first process listening on a TCP port, or null when none is (via lsof). */
function findPidOnPort(port: number): string | null {
  try {
    const out = execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN', '-P'], { encoding: 'utf8' }).trim()
    const first = out.split('\n')[0]
    return first !== undefined && first !== '' ? first : null
  } catch {
    return null
  }
}

/** Wait for a pid to exit; SIGKILL after the deadline. @returns whether it exited. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await sleep(250)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return true
  }
  return false
}

/** Restart failure path: optional hard reset to the recorded checkpoint. */
function rollbackToCheckpoint(stateDir: string, repoDir: string, io: CliIo): void {
  const checkpoint = loadState(stateDir).checkpoint
  if (checkpoint === undefined) {
    io.stderr('no checkpoint recorded — manual rollback required\n')
    return
  }
  const result = resetToCheckpoint(repoDir, checkpoint.revision)
  io.stdout(result.ok
    ? `rolled back to checkpoint ${checkpoint.revision}\n`
    : `rollback failed: ${result.error ?? 'git reset failed'}\n`)
}

/**
 * Run one CLI invocation against the guard state.
 * @param argv - arguments after the subcommand name.
 * @param io - output sinks.
 * @returns the process exit code: 0 ok, 1 gate denied / failure, 2 usage error.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parse(argv)
  if ('error' in parsed) {
    io.stderr(parsed.error)
    return 2
  }
  const { command, positionals, options } = parsed
  const stateDir = resolveStateDir(options.stateDir)
  const repoDir = resolveRepoDir(options.repoDir)

  switch (command) {
    case 'verify': {
      const result = verifyCredential(loadState(stateDir), currentHead(repoDir), Date.now(), options.maxAgeMinutes)
      io.stdout(`${result.reason}\n`)
      return result.ok ? 0 : 1
    }
    case 'record': {
      const scope = positionals[0]
      if (scope === undefined) {
        io.stderr(`record requires a <scope>\n\n${USAGE}`)
        return 2
      }
      const head = currentHead(repoDir)
      if (head === null) {
        io.stderr('cannot record a credential outside a git repository\n')
        return 1
      }
      recordCredential(stateDir, { scope, revision: head, command: options.command ?? '' }, Date.now())
      io.stdout(`recorded green credential: ${scope} @ ${head}\n`)
      return 0
    }
    case 'status': {
      const state = loadState(stateDir)
      io.stdout(`${JSON.stringify(state, null, 2)}\n`)
      return 0
    }
    case 'clear': {
      clearCredential(stateDir, Date.now())
      io.stdout('credential cleared\n')
      return 0
    }
    case 'checkpoint': {
      const message = options.message ?? 'batch snapshot'
      const result = commitCheckpoint(repoDir, `dsh-ankh-guard checkpoint: ${message}`)
      if (!result.ok) {
        io.stderr(`${result.error}\n`)
        return 1
      }
      setCheckpoint(stateDir, { revision: result.sha, message }, Date.now())
      io.stdout(`checkpoint committed: ${result.sha}\n`)
      return 0
    }
    case 'reset': {
      const sha = positionals[0]
      if (sha === undefined) {
        io.stderr(`reset requires a <sha>\n\n${USAGE}`)
        return 2
      }
      const result = resetToCheckpoint(repoDir, sha)
      if (!result.ok) {
        io.stderr(`${result.error ?? 'reset failed'}\n`)
        return 1
      }
      io.stdout(`reset to ${sha}\n`)
      return 0
    }
    case 'canary': {
      const verdict = verifyCredential(loadState(stateDir), currentHead(repoDir), Date.now(), options.maxAgeMinutes)
      io.stdout(`verify: ${verdict.ok ? 'PASS' : 'FAIL'} — ${verdict.reason}\n`)
      let ok = verdict.ok
      if (options.port !== undefined) {
        const listening = await checkPort(options.port)
        ok = ok && listening
        io.stdout(`port ${options.port}: ${listening ? 'PASS' : 'FAIL'} — ${listening ? 'listening' : 'nothing listening'}\n`)
      }
      io.stdout(ok ? 'canary PASS\n' : 'canary FAIL\n')
      return ok ? 0 : 1
    }
    case 'restart': {
      const port = options.port
      if (port === undefined || options.start === undefined || options.start === '') {
        io.stderr(`restart requires --port N and --start "CMD"\n\n${USAGE}`)
        return 2
      }
      // THE GATE: never stop an instance on a denial.
      const gate = verifyCredential(loadState(stateDir), currentHead(repoDir), Date.now(), options.maxAgeMinutes)
      if (!gate.ok) {
        io.stderr(`restart refused: ${gate.reason}\n`)
        return 1
      }
      // Graceful self-restart: wait out the delay so the scheduling agent's
      // turn completes and its final message is delivered before the stop.
      if (options.delayMs !== undefined && options.delayMs > 0) {
        io.stdout(`scheduled restart in ${options.delayMs} ms — current turn may finish first\n`)
        await sleep(options.delayMs)
      }
      const pid = options.pid ?? findPidOnPort(port)
      if (pid === null || pid === '') {
        io.stderr(`nothing listening on 127.0.0.1:${port} — nothing to restart\n`)
        return 1
      }
      const pidNumber = Number(pid)
      try {
        process.kill(pidNumber, 'SIGTERM')
      } catch (error) {
        io.stderr(`stop ${pid} failed: ${String(error)}\n`)
        return 1
      }
      const exited = await waitForExit(pidNumber, 10_000)
      io.stdout(`stopped ${pid}${exited ? '' : ' (forced)'}\n`)
      const child = spawn(options.start, { shell: true, detached: true, stdio: 'ignore' })
      child.unref()
      io.stdout(`started: ${options.start}\n`)
      const timeoutMs = options.timeoutMs ?? 60_000
      const deadline = Date.now() + timeoutMs
      let listening = false
      while (Date.now() < deadline) {
        if (await checkPort(port)) {
          listening = true
          break
        }
        await sleep(500)
      }
      if (!listening) {
        io.stderr(`new instance not listening on 127.0.0.1:${port} within ${timeoutMs}ms\n`)
        if (options.rollback) rollbackToCheckpoint(stateDir, repoDir, io)
        return 1
      }
      const post = verifyCredential(loadState(stateDir), currentHead(repoDir), Date.now(), options.maxAgeMinutes)
      io.stdout(`canary verify: ${post.ok ? 'PASS' : 'FAIL'} — ${post.reason}\n`)
      io.stdout(`canary port: PASS — listening on 127.0.0.1:${port}\n`)
      if (!post.ok) {
        if (options.rollback) rollbackToCheckpoint(stateDir, repoDir, io)
        return 1
      }
      io.stdout('restart + canary PASS\n')
      return 0
    }
    case 'supervise': {
      const port = options.port
      if (port === undefined || options.start === undefined || options.start === '') {
        io.stderr(`supervise requires --port N and --start "CMD"\n\n${USAGE}`)
        return 2
      }
      // The watchdog writes its pidfile under <home>/state; reuse the running
      // one when it is still alive (one supervisor owns the port).
      const wdHome = process.env.DSH_HOME ?? dirname(stateDir)
      const pidfile = join(wdHome, 'state', 'watchdog.pid')
      if (existsSync(pidfile)) {
        const existing = readFileSync(pidfile, 'utf8').trim()
        const existingPid = Number(existing)
        if (existing !== '' && Number.isInteger(existingPid)) {
          try {
            process.kill(existingPid, 0)
            io.stdout(`already supervised by pid ${existing}\n`)
            return 0
          } catch {
            // stale pidfile — fall through and spawn
          }
        }
      }
      const watchdog = fileURLToPath(new URL('../scripts/dsh-watchdog.sh', import.meta.url))
      if (!existsSync(watchdog)) {
        io.stderr(`watchdog script not found at ${watchdog}\n`)
        return 1
      }
      const logPath = options.log ?? join(wdHome, 'state', 'watchdog.log')
      mkdirSync(dirname(logPath), { recursive: true })
      const env = {
        ...process.env,
        WD_PORT: String(port),
        WD_HOME: wdHome,
        WD_REPO: repoDir,
        WD_START: options.start,
        // Foreground (launchd-supervised) mode: the watchdog owns the port by
        // adoption; the detached form waits for the current owner to exit.
        WD_WAIT_OWNER: options.foreground ? '0' : '1',
        WD_GUARD: guardInvocation(),
      }
      if (options.foreground) {
        // Run the watchdog inline: the CLI process stays alive as the
        // watchdog's parent, so an external supervisor (launchd KeepAlive)
        // supervises the watchdog, which supervises the instance. The CLI
        // exits with the watchdog so a dead watchdog triggers a restart.
        const child = spawn('bash', [watchdog, '--supervise'], {
          stdio: 'inherit',
          env,
        })
        const code = await new Promise<number>((resolve) => {
          child.on('exit', (c) => { resolve(c ?? 1) })
        })
        return code
      }
      const child = spawn('bash', [watchdog, '--supervise'], {
        detached: true,
        stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
        env,
      })
      child.unref()
      io.stdout(`watchdog spawned (pid ${child.pid ?? 'unknown'}) — supervises :${port}, log ${logPath}\n`)
      return 0
    }
    case 'schedule-exit': {
      const port = options.port
      const delayMs = options.delayMs
      if (port === undefined || delayMs === undefined) {
        io.stderr(`schedule-exit requires --port N and --delay-ms MS\n\n${USAGE}`)
        return 2
      }
      // THE GATE: never schedule an exit on a denial.
      const gate = verifyCredential(loadState(stateDir), currentHead(repoDir), Date.now(), options.maxAgeMinutes)
      if (!gate.ok) {
        io.stderr(`schedule-exit refused: ${gate.reason}\n`)
        return 1
      }
      // Intentional-restart marker: the supervising watchdog runs the canary
      // after the respawn and clears this on pass. The initiator (the session
      // that requested the exit) rides along so the restart report can return
      // to that session instead of racing to whichever root agent resumes first.
      const wdHome = process.env.DSH_HOME ?? dirname(stateDir)
      const initiator = options.initiator ?? process.env.DSH_SESSION_ID
      mkdirSync(join(wdHome, 'state'), { recursive: true })
      writeFileSync(join(wdHome, 'state', 'restart-requested.json'),
        `${JSON.stringify({
          reason: 'scheduled self-restart',
          requestedAt: Date.now(),
          ...(initiator !== undefined ? { initiator } : {}),
        })}\n`)
      // A DETACHED exit agent (setsid via node spawn): it cannot be reaped by
      // the sandbox/harness process group, so the scheduled kill actually
      // lands even after the scheduling turn ends — the fix for "the kill
      // never happened" seen with `(sleep N; kill) &` from a managed shell.
      const resultFile = join(wdHome, 'state', 'last-restart.json')
      const logPath = options.log ?? join(wdHome, 'state', 'schedule-exit.log')
      mkdirSync(dirname(logPath), { recursive: true })
      const script = [
        "const { execFileSync } = require('node:child_process');",
        'const fs = require("node:fs");',
        'const port = Number(process.env.WD_PORT);',
        'const delay = Number(process.env.WD_DELAY_MS);',
        'const result = process.env.WD_RESULT_FILE;',
        'const initiator = process.env.WD_INITIATOR || undefined;',
        'const record = (fields) => JSON.stringify({ ...fields, ...(initiator !== undefined ? { initiator } : {}) });',
        'setTimeout(() => {',
        '  try {',
        "    const out = execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN', '-P'], { encoding: 'utf8' }).trim();",
        "    const pid = Number(out.split('\\n')[0]);",
        "    if (Number.isInteger(pid)) { process.kill(pid, 'SIGTERM'); fs.writeFileSync(result, record({ exitAt: Date.now(), pid })); }",
        "    else { fs.writeFileSync(result, record({ error: 'no listener on port ' + port })); }",
        '  } catch (e) {',
        '    fs.writeFileSync(result, record({ error: String(e) }));',
        '  }',
        '}, delay);',
      ].join('\n')
      const child = spawn(process.execPath, ['-e', script], {
        detached: true,
        stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
        env: {
          ...process.env,
          WD_PORT: String(port),
          WD_DELAY_MS: String(delayMs),
          WD_RESULT_FILE: resultFile,
          ...(initiator !== undefined ? { WD_INITIATOR: initiator } : {}),
        },
      })
      child.unref()
      io.stdout(`exit scheduled in ${delayMs} ms (agent pid ${child.pid ?? 'unknown'}) — watchdog will respawn and run the canary\n`)
      return 0
    }
    default:
      io.stderr(`unknown command ${command}\n\n${USAGE}`)
      return 2
  }
}

// Direct invocation (`tsx src/cli.ts ...`) vs import by tests.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runCli(process.argv.slice(2), {
    stdout: line => process.stdout.write(line),
    stderr: line => process.stderr.write(line),
  }).then((code) => { process.exitCode = code })
    .catch((error: unknown) => {
      process.stderr.write(`ankh-guard: ${String(error)}\n`)
      process.exitCode = 1
    })
}
