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
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveRepoDir, resolveStateDir, SRC_ARTIFACT_PATTERN } from './defaults.ts'
import { commitCheckpoint, currentHead, resetToCheckpoint } from './git.ts'
import {
  clearCredential, loadState, recordCredential, setCheckpoint, verifyCredential,
} from './state.ts'
import { lastGoodBootRevision, stateFile } from './state-files.ts'
import { findPidOnPort, killPidTree } from './processes.ts'
import { writeUnexpectedExitRecord } from './restart-context.ts'

/** Parsed CLI options; empty stateDir/repoDir mean "use defaults". */
interface CliOptions {
  stateDir: string
  repoDir: string
  home: string
  maxAgeMinutes: number
  port: number | undefined
  command: string | undefined
  message: string | undefined
  start: string | undefined
  pid: string | undefined
  timeoutMs: number | undefined
  delayMs: number | undefined
  stopTimeoutMs: number | undefined
  log: string | undefined
  foreground: boolean
  rollback: boolean
  initiator: string | undefined
  profile: string | undefined
  preflightTimeoutMs: number | undefined
}

/** stdout/stderr sink (injected so tests capture output). */
export interface CliIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
}

/**
 * Printed by the commands every agent-driven restart flow calls before
 * restarting: the loop spawns detached processes and signals them, which a
 * sandboxed tool runner denies (EPERM). Runtime hint, because the README
 * prerequisite section is not reliably read.
 */
const FULL_ACCESS_HINT = 'hint: the restart loop spawns detached processes and signals them — a sandboxed session (not full-access) will fail with EPERM. Before restarting, ask the user to switch THIS session to full access: /permission danger-full-access (the settings page only affects NEW sessions; close any persistent terminals first — an open PTY fences the switch)\n'

/**
 * Printed (by verify/record, and as a refusal-grade warning in schedule-exit)
 * while no watchdog supervises the instance: a bare exit now leaves the
 * service DOWN — the first-install bootstrap gap.
 */
const NO_WATCHDOG_HINT = 'warning: no live watchdog supervises the instance — a bare exit now leaves the service DOWN. Before the first restart, run `supervise --port N --start "CMD"` (it adopts the running instance and respawns ANY exit), or drive the restart with `restart` yourself\n'

/** The live supervising watchdog's pid, or null when none is (pidfile + kill 0). */
function liveWatchdogPid(stateDir: string): number | null {
  try {
    const raw = readFileSync(stateFile(stateDir, 'watchdogPid'), 'utf8').trim()
    const pid = Number(raw)
    // raw '' → 0, and kill(0, 0) always succeeds (it probes our own process
    // group): an empty pidfile must read as NO watchdog, never as alive.
    if (raw !== '' && Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); return pid }
  } catch { /* no pidfile or a dead owner */ }
  return null
}

/**
 * Cross-session restart mutual exclusion: two concurrent restarts would both
 * stop the listener and double-start the instance — a port race whose loser
 * dies silently (stdio ignored). Atomic create, the watchdog pidfile's own
 * discipline; a stale lock (dead holder, or an empty file left by a writer
 * SIGKILLed mid-create) is reclaimed.
 */
function acquireRestartLock(stateDir: string): { ok: true; release(): void } | { ok: false; holder: string } {
  const file = stateFile(stateDir, 'restartLock')
  mkdirSync(stateDir, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' })
      return {
        ok: true,
        release: () => { try { unlinkSync(file) } catch { /* idempotent: the file is already gone */ } },
      }
    } catch {
      // The lock exists. Reclaim only when the holder is provably dead.
      let holder: string
      try {
        holder = readFileSync(file, 'utf8').trim()
      } catch (error) {
        return { ok: false, holder: `unreadable (${String(error)})` }
      }
      const pid = Number(holder)
      if (holder !== '' && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          return { ok: false, holder }
        } catch { /* dead holder — reclaim below */ }
      }
      try {
        unlinkSync(file)
      } catch (error) {
        return { ok: false, holder: `unreclaimable (${String(error)})` }
      }
    }
  }
  return { ok: false, holder: 'unknown' }
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
  preflight [--profile NAME] [--timeout-ms MS]
  record-unexpected-exit [--state-dir DIR]   # watchdog-facing: record an unplanned-exit recovery
  restart --port N --start "CMD" [--pid PID] [--timeout-ms MS] [--delay-ms MS] [--stop-timeout-ms MS] [--rollback]
          [--profile NAME] [--preflight-timeout-ms MS] [--state-dir DIR] [--repo DIR] [--max-age MIN]
  schedule-exit --port N --delay-ms MS [--initiator ID] [--log FILE] [--profile NAME]
          [--preflight-timeout-ms MS] [--state-dir DIR] [--repo DIR]
  supervise --port N --start "CMD" [--foreground] [--log FILE] [--state-dir DIR] [--repo DIR] [--home DIR]
flags:
  --state-dir DIR  state directory (default: $DSH_HOME/state, else <cwd>/.dsh-guard-state)
  --repo DIR       repository the credential binds to (default: cwd)
  --max-age MIN    credential freshness window in minutes (default: 10)
  --port N         canary/restart/supervise: TCP port that must be listening
  --command CMD    record: the command that produced the green state
  --message MSG    checkpoint: batch description
  --start "CMD"    restart/supervise: the shell command that starts the instance
  --pid PID        restart: process to stop (default: the listener on --port)
  --timeout-ms MS  restart: how long to wait for the new instance to listen (default 60000);
                   preflight: how long the dry-run boot may take (default 120000)
  --stop-timeout-ms MS  restart: how long to wait for the old instance to exit after SIGTERM
                   before escalating to SIGKILL (default 30000; large sessions writing out
                   logs can take tens of seconds to flush)
  --delay-ms MS    restart: sleep before stopping, so the current turn can finish first
                   (agent-driven graceful self-restart: schedule, complete, then restart);
                   schedule-exit: delay before the detached exit agent kills the host
  --log FILE       supervise (detached only — with --foreground the external supervisor's
                   redirection owns the log) / schedule-exit: log file (default: <state-dir>/*.log)
  --home DIR       supervise: the dsh home the supervised instance boots with (profiles,
                   credentials — default: $DSH_HOME; required when that is unset)
  --initiator ID   schedule-exit: session id that requested the exit (default: $DSH_SESSION_ID);
                   recorded in last-restart.json so the restart report returns to that session
  --profile NAME   preflight/schedule-exit/restart: the dsh profile to dry-run (default:
                   $DSH_PROFILE, else "web")
  --preflight-timeout-ms MS  schedule-exit/restart: bound on the composition preflight (default 120000)
  --rollback       restart: on failure, git reset --hard to the recorded checkpoint
`

/**
 * Parse argv into a command, positionals, and options.
 * @param argv - the raw argument vector (without node/script entries).
 * @returns the parsed command with positionals and options, or a parse error.
 */
export function parse(
  argv: readonly string[],
): { error: string } | { command: string; positionals: readonly string[]; options: CliOptions } {
  const options: CliOptions = {
    stateDir: '', repoDir: '', home: '', maxAgeMinutes: 10, port: undefined, command: undefined, message: undefined,
    start: undefined, pid: undefined, timeoutMs: undefined, delayMs: undefined, stopTimeoutMs: undefined,
    log: undefined,
    foreground: false, rollback: false, initiator: undefined, profile: undefined, preflightTimeoutMs: undefined,
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
        case '--home': options.home = flagValue(arg, true) ?? ''; i++; break
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
        case '--stop-timeout-ms': {
          const raw = flagValue(arg, true)
          const n = Number(raw)
          if (raw === undefined || !Number.isInteger(n) || n < 100) throw new Error('--stop-timeout-ms must be an integer >= 100')
          options.stopTimeoutMs = n
          i++
          break
        }
        case '--foreground': options.foreground = true; break
        case '--initiator': options.initiator = flagValue(arg, true) ?? ''; i++; break
        case '--profile': options.profile = flagValue(arg, true) ?? ''; i++; break
        case '--preflight-timeout-ms': {
          const raw = flagValue(arg, true)
          const n = Number(raw)
          if (raw === undefined || !Number.isInteger(n) || n < 100) throw new Error('--preflight-timeout-ms must be an integer >= 100')
          options.preflightTimeoutMs = n
          i++
          break
        }
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

/**
 * argv (after process.execPath) that runs the exit agent, with the same
 * source/built split as {@link guardInvocation}: `exit-agent.ts` via the tsx
 * loader when this CLI runs from source, `exit-agent.js` when built.
 */
function exitAgentInvocation(): string[] {
  const cliPath = fileURLToPath(import.meta.url)
  if (cliPath.includes(`${sep}src${sep}`)) {
    const agent = join(dirname(cliPath), 'exit-agent.ts')
    const nodeModules = resolve(dirname(cliPath), '../../../node_modules')
    const tsx = join(nodeModules, 'tsx', 'dist', 'esm', 'index.mjs')
    if (existsSync(tsx)) return ['--import', tsx, agent]
    return [agent]
  }
  return [join(dirname(cliPath), 'exit-agent.js')]
}

/** Default bound on one preflight subprocess run (a real web-profile boot takes tens of seconds). */
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 120_000

/** A pending restart marker older than this is stale — its watchdog died mid-flow. */
const RESTART_MARKER_TTL_MS = 15 * 60_000

/** Captured preflight output is diagnostics, not a log — cap it before it can grow without bound. */
const PREFLIGHT_OUTPUT_CAP = 64 * 1024

/**
 * How the guard invokes the dsh app's `preflight` mode: the source form runs
 * `node --import <repo>/node_modules/tsx/dist/esm/index.mjs <repo>/apps/cli/src/bin.ts`,
 * the built form `node <repo>/apps/cli/lib/bin.js` (same source/built split as
 * {@link guardInvocation}). This CLI sits at packages/guard/ankh-guard/src
 * (source) or packages/guard/ankh-guard/lib (built); the repository root is
 * four levels up from either.
 * @param cliFile - this CLI's own file (injectable so tests can point it at a
 * layout without the sibling app).
 * @returns the command prefix (`preflight --profile <name>` is appended), or
 * `undefined` outside the dsh app layout (a standalone published package).
 */
export function resolvePreflightBin(cliFile: string = fileURLToPath(import.meta.url)): string | undefined {
  const root = resolve(dirname(cliFile), '../../../..')
  const sourceBin = join(root, 'apps', 'cli', 'src', 'bin.ts')
  if (existsSync(sourceBin)) {
    const tsx = join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
    if (existsSync(tsx)) return `node --import ${tsx} ${sourceBin}`
  }
  const builtBin = join(root, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(builtBin)) return `node ${builtBin}`
  return undefined
}

/** Replaceable seams for tests; production keeps the defaults. */
export const preflightInternals: {
  resolveBin: () => string | undefined
  resolveRunner: (harnessRoot: string) => string | undefined
} = {
  resolveBin: () => resolvePreflightBin(),
  resolveRunner: (harnessRoot: string) => resolveRunnerCommand(harnessRoot),
}

/**
 * The harness checkout the live instance boots from (and the preflight
 * runner resolves the official published packages from): the `--repo` target
 * when given, else `DSH_HARNESS`, else the conventional default.
 */
export function resolveHarnessRoot(optionRepoDir: string | undefined, env: Record<string, string | undefined> = process.env): string {
  if (optionRepoDir !== undefined && optionRepoDir !== '') return optionRepoDir
  const fromEnv = env.DSH_HARNESS
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), 'code/deepseek-harness')
}

/**
 * The standalone preflight runner command (see preflight-runner.ts): executed
 * with the harness's own tsx so its dynamic imports resolve against the live
 * checkout — no fork patch, no pinned dependency, follows host updates.
 * Undefined when the harness tsx or the runner script is missing.
 */
export function resolveRunnerCommand(harnessRoot: string): string | undefined {
  const tsx = join(harnessRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
  if (!existsSync(tsx)) return undefined
  const here = dirname(fileURLToPath(import.meta.url))
  const runner = existsSync(join(here, 'preflight-runner.ts'))
    ? join(here, 'preflight-runner.ts')
    : existsSync(join(here, 'preflight-runner.js'))
      ? join(here, 'preflight-runner.js')
      : undefined
  if (runner === undefined) return undefined
  return `node --import ${shellQuote(tsx)} ${shellQuote(runner)}`
}

/**
 * One preflight run's verdict class plus its captured output. `pass` and
 * `composition-failed` are verdicts ON the composition; `infra-failed` means
 * preflight itself could not execute (timeout, spawn failure, the app's own
 * exit 3) and says nothing about the composition; `unavailable` means there
 * is no sibling dsh app to dry-run at all (standalone deployment).
 */
export interface PreflightOutcome {
  kind: 'pass' | 'composition-failed' | 'infra-failed' | 'unavailable'
  /** Combined stdout+stderr, capped at {@link PREFLIGHT_OUTPUT_CAP}. */
  output: string
  /** Why no verdict was produced (timeout, spawn error, unexpected exit code). */
  detail?: string
}

/** POSIX single-quote one word for the shell command line. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`
}

/**
 * Run the composition preflight as a subprocess and classify its exit.
 * Resolution order: `DSH_PREFLIGHT_COMMAND` override (test hook / exotic
 * layouts) → the standalone runner (`preflight-runner.ts`, resolved from the
 * live harness — no fork patch needed) → the fork's `dsh preflight` command
 * when the sibling app layout is present.
 * @param profile - the dsh profile to dry-run.
 * @param timeoutMs - bound on the whole subprocess run; a timeout kills it.
 * @param harnessRoot - harness checkout for the runner (default: DSH_HARNESS / ~/code/deepseek-harness).
 * @returns the classified outcome.
 */
export async function runPreflightCheck(profile: string, timeoutMs: number, harnessRoot?: string): Promise<PreflightOutcome> {
  const override = process.env.DSH_PREFLIGHT_COMMAND
  let command: string
  let usingRunner = false
  if (override !== undefined && override !== '') {
    command = override
  } else {
    const root = harnessRoot ?? resolveHarnessRoot(undefined)
    const runner = preflightInternals.resolveRunner(root)
    if (runner !== undefined) {
      command = `${runner} --profile ${shellQuote(profile)}`
      usingRunner = true
    } else {
      const bin = preflightInternals.resolveBin()
      if (bin === undefined) return { kind: 'unavailable', output: '' }
      command = `${bin} preflight --profile ${shellQuote(profile)}`
    }
  }
  const harnessForRunner = harnessRoot ?? resolveHarnessRoot(undefined)
  return await new Promise((resolvePromise) => {
    let output = ''
    let timedOut = false
    // The runner resolves the live harness from DSH_HARNESS; pin it so the
    // subprocess agrees with the gate even when the caller's env differs.
    const child = usingRunner
      ? spawn(command, { shell: true, env: { ...process.env, DSH_HARNESS: harnessForRunner } })
      : spawn(command, { shell: true })
    const append = (chunk: Buffer): void => {
      if (output.length < PREFLIGHT_OUTPUT_CAP) output += chunk.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    // 'close' follows both a normal exit and a spawn failure, so one handler
    // settles the promise exactly once.
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        resolvePromise({ kind: 'infra-failed', output, detail: `preflight timed out after ${timeoutMs} ms` })
      } else if (code === 0) {
        resolvePromise({ kind: 'pass', output })
      } else if (code === 1) {
        // The runner's exit 1 is always a real composition verdict. Only a
        // host CLI that predates the preflight subcommand exits 1 with
        // commander's unknown-command error — that host has no gate contract,
        // degrade to unavailable instead of refusing every restart.
        if (!usingRunner && /unknown command/.test(output)) {
          resolvePromise({ kind: 'unavailable', output })
        } else {
          resolvePromise({ kind: 'composition-failed', output })
        }
      } else if (code === 3) {
        resolvePromise({ kind: 'infra-failed', output })
      } else {
        resolvePromise({ kind: 'infra-failed', output, detail: `preflight exited with unexpected code ${String(code)}` })
      }
    })
  })
}

/** The profile a gated verb dry-runs: the flag, then $DSH_PROFILE, then the deployment default. */
function resolveProfileName(options: CliOptions): string {
  const flag = options.profile ?? ''
  if (flag !== '') return flag
  const env = process.env.DSH_PROFILE ?? ''
  return env !== '' ? env : 'web'
}

/**
 * The home the supervised instance boots with (the watchdog exports it as
 * DSH_HOME): the explicit flag first, then the environment — the same
 * flag-over-env order as every other resolver in this CLI (and as the
 * installers' own --home). Undefined when neither names one: supervise fails
 * loud rather than boot the instance on a home guessed from the state dir.
 */
export function resolveWdHome(optionHome: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (optionHome !== '') return optionHome
  const fromEnv = env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined
}

/** The first ~40 lines of captured preflight output, newline-terminated, or empty. */
function summarizeOutput(output: string): string {
  if (output.trim() === '') return ''
  const lines = output.split('\n')
  const kept = lines.length > 41 ? [...lines.slice(0, 40), `… (${lines.length - 40} more lines)`] : lines
  return `${kept.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * The composition gate shared by `schedule-exit` and `restart`, run AFTER the
 * credential check: a green build does not prove the profile composition
 * boots, and a broken composition must never stop the running instance.
 * @param verb - the refusing verb, for the diagnostic prefix.
 * @param profile - the profile to dry-run.
 * @param timeoutMs - bound on the preflight subprocess.
 * @param io - output sinks.
 * @param harnessRoot - harness checkout for the standalone runner.
 * @returns whether the verb may proceed.
 */
async function preflightGate(verb: string, profile: string, timeoutMs: number, io: CliIo, harnessRoot?: string): Promise<boolean> {
  const outcome = await runPreflightCheck(profile, timeoutMs, harnessRoot)
  switch (outcome.kind) {
    case 'pass':
      io.stdout(`composition preflight PASS (profile ${JSON.stringify(profile)})\n`)
      return true
    case 'unavailable':
      // A standalone published deployment has no sibling dsh app to dry-run —
      // and no profile composition to check either — so there is nothing to gate on.
      io.stdout('composition preflight unavailable outside the dsh app layout — proceeding without it\n')
      return true
    case 'composition-failed':
      io.stderr(`${verb} refused: composition preflight failed:\n${summarizeOutput(outcome.output)}`)
      return false
    case 'infra-failed':
      io.stderr(`${verb} refused: the composition preflight itself failed${
        outcome.detail !== undefined ? ` — ${outcome.detail}` : ''
      }. This is NOT a verdict on the composition, but the guard will not stop a healthy instance it cannot prove will come back.\n${
        summarizeOutput(outcome.output)
      }manual override: stop the instance by hand (\`kill $(lsof -tiTCP:<port> -sTCP:LISTEN)\`) and let the watchdog respawn it, or fix the preflight failure and retry.\n`)
      return false
  }
}

/**
 * Wait for a pid to exit; SIGKILL (the whole descendant tree) after the
 * deadline. @param onEscalate - invoked right before the SIGKILL, so the
 * caller can write a log line that correlates with the watchdog log's
 * `Killed: 9` (the two live in different logs — the CLI's stdout vs the
 * watchdog's). @returns whether it exited.
 */
async function waitForExit(pid: number, timeoutMs: number, onEscalate?: () => void): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await sleep(250)
  }
  // The pid may have exited inside the final polling window: probe once more
  // so the escalation report is not a false positive (the watchdog log would
  // show no matching `Killed: 9` for a process that already exited).
  // killPidTree never throws (it swallows "already gone" internally), so a
  // try/catch around it could no longer distinguish "exited on its own" from
  // "killed by us" — the pre-`killPidTree` probe restores that distinction.
  try {
    process.kill(pid, 0)
  } catch {
    return true
  }
  onEscalate?.()
  killPidTree(pid, 'SIGKILL')
  return false
}

/**
 * Restart failure path: optional hard reset to the last known-good revision —
 * the healthy-boot stamp (deployment-proven), else the recorded checkpoint,
 * else the credential's HEAD.
 */
function rollbackToKnownGood(stateDir: string, repoDir: string, io: CliIo): void {
  const state = loadState(stateDir)
  const target = lastGoodBootRevision(stateDir) ?? state.checkpoint?.revision ?? state.credential?.revision
  if (target === undefined) {
    io.stderr('no boot stamp, checkpoint, or credential recorded — manual rollback required\n')
    return
  }
  if (target === currentHead(repoDir)) {
    io.stdout(`rollback target ${target} is the current HEAD — skipping reset (nothing to roll back; a reset would only wipe uncommitted work)\n`)
    return
  }
  const result = resetToCheckpoint(repoDir, target)
  io.stdout(result.ok
    ? `rolled back to last known-good ${target}\n`
    : `rollback failed: ${result.error ?? 'git reset failed'}\n`)
  for (const anchor of result.anchors) io.stdout(`recovery anchor: branch ${anchor}\n`)
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
      if (result.ok) {
        io.stdout(FULL_ACCESS_HINT)
        if (liveWatchdogPid(stateDir) === null) io.stderr(NO_WATCHDOG_HINT)
      }
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
      io.stdout(FULL_ACCESS_HINT)
      if (liveWatchdogPid(stateDir) === null) io.stderr(NO_WATCHDOG_HINT)
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
      const result = commitCheckpoint(repoDir, `dsh-ankh-guard checkpoint: ${message}`, SRC_ARTIFACT_PATTERN)
      if (!result.ok) {
        io.stderr(`${result.error}\n`)
        return 1
      }
      setCheckpoint(stateDir, { revision: result.sha, message }, Date.now())
      io.stdout(`checkpoint committed: ${result.sha}\n`)
      if (result.artifacts.length > 0) {
        io.stdout(`warning: ${result.artifacts.length} build-artifact-looking file(s) swept in (bare tsc emission? real build output belongs in lib/):\n`)
        for (const file of result.artifacts.slice(0, 5)) io.stdout(`  ${file}\n`)
      }
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
      for (const anchor of result.anchors) io.stdout(`recovery anchor: branch ${anchor}\n`)
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
    case 'preflight': {
      const outcome = await runPreflightCheck(resolveProfileName(options), options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS, resolveHarnessRoot(options.repoDir))
      if (outcome.kind === 'unavailable') {
        io.stderr('preflight unavailable outside the dsh app layout\n')
        return 3
      }
      const sink = outcome.kind === 'pass' ? io.stdout : io.stderr
      if (outcome.detail !== undefined) sink(`${outcome.detail}\n`)
      sink(summarizeOutput(outcome.output))
      return outcome.kind === 'pass' ? 0 : outcome.kind === 'composition-failed' ? 1 : 3
    }
    case 'record-unexpected-exit': {
      // Invoked by the watchdog when it recovers an unplanned exit (no restart
      // marker). Never overwrites a record that still awaits its report; the
      // two messages keep the watchdog log truthful about which happened.
      const written = writeUnexpectedExitRecord(stateDir, Date.now())
      io.stdout(written
        ? '[watchdog] unplanned exit recovered — left a report record for the next session\n'
        : '[watchdog] unplanned exit recovered — a report record is still pending, left it untouched\n')
      return 0
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
      // THE COMPOSITION GATE: a green build does not prove the profile boots.
      if (!(await preflightGate('restart', resolveProfileName(options), options.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS, io, resolveHarnessRoot(options.repoDir)))) {
        return 1
      }
      // ONE restart at a time across sessions: two concurrent restarts would
      // both stop the listener and double-start the instance — a port race
      // whose loser dies silently. The lock is held only until the stop
      // ONE restart at a time across sessions: two concurrent restarts would
      // both stop the listener and double-start the instance — a port race
      // whose loser dies silently. Held to the END of the verb (boot watch
      // and canary included): a second restart must not find and kill the
      // instance this one just started. Crash safety comes from the stale
      // reclaim in acquireRestartLock, not from an early release.
      const restartLock = acquireRestartLock(stateDir)
      if (!restartLock.ok) {
        io.stderr(/^\d+$/.test(restartLock.holder)
          ? `restart refused: another restart is already in flight (pid ${restartLock.holder})\n`
          : `restart refused: cannot claim the restart lock (${restartLock.holder}) — remove ${stateFile(stateDir, 'restartLock')} if it is stale\n`)
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
        restartLock.release()
        io.stderr(`nothing listening on 127.0.0.1:${port} — nothing to restart\n`)
        return 1
      }
      const pidNumber = Number(pid)
      try {
        process.kill(pidNumber, 'SIGTERM')
      } catch (error) {
        restartLock.release()
        io.stderr(`stop ${pid} failed: ${String(error)}\n`)
        return 1
      }
      // Graceful-exit deadline before the SIGKILL escalation: large sessions
      // flushing out tens of thousands of log tokens can take longer than the
      // old hardcoded 10 s. Configurable via --stop-timeout-ms.
      const stopTimeoutMs = options.stopTimeoutMs ?? 30_000
      const exited = await waitForExit(pidNumber, stopTimeoutMs, () => {
        // This line lives in the CLI's stdout; the watchdog's own log carries
        // the matching `Killed: 9` for the same pid — the two align on pid.
        io.stdout(`pid ${pid} did not exit within ${stopTimeoutMs} ms of SIGTERM — sending SIGKILL (the watchdog log will show 'Killed: 9' for ${pid})\n`)
      })
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
        restartLock.release()
        io.stderr(`new instance not listening on 127.0.0.1:${port} within ${timeoutMs}ms\n`)
        if (options.rollback) rollbackToKnownGood(stateDir, repoDir, io)
        return 1
      }
      const post = verifyCredential(loadState(stateDir), currentHead(repoDir), Date.now(), options.maxAgeMinutes)
      io.stdout(`canary verify: ${post.ok ? 'PASS' : 'FAIL'} — ${post.reason}\n`)
      io.stdout(`canary port: PASS — listening on 127.0.0.1:${port}\n`)
      restartLock.release()
      if (!post.ok) {
        if (options.rollback) rollbackToKnownGood(stateDir, repoDir, io)
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
      // The supervised instance boots with THIS home (the watchdog exports it
      // as DSH_HOME): a home derived from the state dir would silently point
      // the instance at the wrong profiles/credentials, surfacing far from
      // the cause — so a missing home is a loud misconfiguration, not a guess.
      const wdHome = resolveWdHome(options.home)
      if (wdHome === undefined) {
        io.stderr('supervise needs the dsh home: pass --home DIR or set DSH_HOME — the supervised instance reads its profiles/credentials from there, and deriving one from --state-dir would guess wrong\n')
        return 2
      }
      // One state directory owns every marker and the pidfile; the plugin,
      // this CLI, and the watchdog must agree on it. Deriving a home from
      // stateDir and re-appending 'state' breaks whenever stateDir is not
      // literally '$DSH_HOME/state' (an explicit --state-dir, or the
      // '<cwd>/.dsh-guard-state' fallback): the CLI would write '<cwd>/state'
      // while the plugin reads '<cwd>/.dsh-guard-state'.
      const pidfile = stateFile(stateDir, 'watchdogPid')
      if (existsSync(pidfile)) {
        const existing = readFileSync(pidfile, 'utf8').trim()
        const existingPid = Number(existing)
        if (existing !== '' && Number.isInteger(existingPid)) {
          let existingAlive = true
          try {
            process.kill(existingPid, 0)
          } catch {
            existingAlive = false // stale pidfile — fall through and spawn
          }
          if (existingAlive) {
            if (options.foreground) {
              // Foreground = an external supervisor (launchd KeepAlive) runs
              // THIS process. Exiting 0 here would read as an intentional stop
              // under `KeepAlive SuccessfulExit: false`, so the job would go
              // idle and never restart the CLI — silently leaving the OTHER
              // watchdog unsupervised, i.e. a quiet regression to the
              // single-point-of-failure shape. Instead, wait for it to exit
              // and then take over: the chain (supervisor → this CLI →
              // watchdog) stays intact the whole time.
              io.stdout(`watchdog ${existing} already supervises the port — waiting for it to exit, then taking over (foreground)\n`)
              while (true) {
                try {
                  process.kill(existingPid, 0)
                } catch {
                  break
                }
                await sleep(1000)
              }
              io.stdout(`watchdog ${existing} exited — taking over\n`)
            } else {
              io.stdout(`already supervised by pid ${existing}\n`)
              return 0
            }
          }
        }
      }
      const watchdog = fileURLToPath(new URL('../scripts/dsh-watchdog.sh', import.meta.url))
      if (!existsSync(watchdog)) {
        io.stderr(`watchdog script not found at ${watchdog}\n`)
        return 1
      }
      // --log only has a consumer in the detached branch (the log file the
      // watchdog is spawned into). Foreground output follows the EXTERNAL
      // supervisor's redirection (launchd StandardOutPath / systemd
      // StandardOutput=) — accepting --log here would silently write nothing.
      if (options.foreground && options.log !== undefined) {
        io.stderr('supervise: --log has no effect with --foreground — output follows the external supervisor\'s redirection (launchd StandardOutPath / systemd StandardOutput=); drop --log\n')
        return 2
      }
      const env = {
        ...process.env,
        WD_PORT: String(port),
        WD_HOME: wdHome,
        WD_STATE_DIR: stateDir,
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
      const logPath = options.log ?? stateFile(stateDir, 'watchdogLog')
      mkdirSync(dirname(logPath), { recursive: true })
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
      // THE COMPOSITION GATE: a green build does not prove the profile boots.
      if (!(await preflightGate('schedule-exit', resolveProfileName(options), options.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS, io, resolveHarnessRoot(options.repoDir)))) {
        return 1
      }
      // Bootstrap guard: with no live watchdog the scheduled exit leaves the
      // service DOWN — the classic first-install gap (the running instance
      // has not loaded the plugin yet, and no supervisor exists yet).
      if (liveWatchdogPid(stateDir) === null) {
        io.stderr(NO_WATCHDOG_HINT)
      }
      // One scheduled restart at a time: the marker carries a single
      // initiator, so overwriting a FRESH one would silently reassign the
      // pending report. A marker past the TTL is stale (the watchdog died
      // mid-flow without clearing it) — overwrite with a warning instead of
      // refusing forever.
      const markerFile = stateFile(stateDir, 'restartRequested')
      if (existsSync(markerFile)) {
        let stale = false
        try {
          const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as { requestedAt?: number }
          stale = typeof marker.requestedAt !== 'number' || Date.now() - marker.requestedAt > RESTART_MARKER_TTL_MS
        } catch { stale = true }
        if (!stale) {
          io.stderr('schedule-exit refused: a restart is already scheduled (restart-requested.json still pending); a stale marker expires on its own after 15 minutes\n')
          return 1
        }
        io.stderr('warning: overwriting a stale restart marker (a previous schedule never completed)\n')
      }
      // Intentional-restart marker: the supervising watchdog runs the canary
      // after the respawn and clears this on pass. The initiator (the session
      // that requested the exit) rides along so the restart report can return
      // to that session instead of racing to whichever root agent resumes
      // first. Everything lands in stateDir directly — the same directory the
      // plugin reads (see the supervise case for why no home is derived).
      const initiator = options.initiator ?? process.env.DSH_SESSION_ID
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(stateFile(stateDir, 'restartRequested'),
        `${JSON.stringify({
          reason: 'scheduled self-restart',
          requestedAt: Date.now(),
          ...(initiator !== undefined ? { initiator } : {}),
        })}\n`)
      // A DETACHED exit agent (setsid via node spawn): it cannot be reaped by
      // the sandbox/harness process group, so the scheduled kill actually
      // lands even after the scheduling turn ends — the fix for "the kill
      // never happened" seen with `(sleep N; kill) &` from a managed shell.
      // The agent is a real shipped file (typechecked, linted, unit-tested),
      // spawned with the same source/built split as guardInvocation().
      const resultFile = stateFile(stateDir, 'lastRestart')
      const logPath = options.log ?? stateFile(stateDir, 'scheduleExitLog')
      mkdirSync(dirname(logPath), { recursive: true })
      const child = spawn(process.execPath, exitAgentInvocation(), {
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
