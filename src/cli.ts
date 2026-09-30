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
 *   checkpoint — record clean HEAD, or explicitly commit a reviewed dirty snapshot
 *   reset    — `git reset --hard` to a checkpoint commit (rollback)
 *   canary   — post-restart probe: verify (+ optional TCP port check)
 *   verify-restart — watchdog-facing validation of a scheduled authorization
 *   record-proven-deployment — watchdog-facing promotion after canary
 *   restart  — DETACHED restart: gate → stop → start → probe → canary.
 *              Owns the whole loop in a process that outlives the restarted
 *              instance, so the post-restart canary runs even though the
 *              instance restart killed the session that used to own it.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectInvocation, resolveRepoDir, resolveStateDir, SRC_ARTIFACT_PATTERN } from './defaults.ts'
import { commitCheckpoint, currentHead, isWorkingTreeClean, resetToCheckpoint, workingTreeChanges } from './git.ts'
import {
  clearCredential, loadState, recordCredential, setCheckpoint, verifyCredential,
} from './state.ts'
import {
  proveCurrentDeployment, verifyRestartAuthorization, verifyRestartEvidence,
  type RestartAuthorization, type RestartEvidenceResult,
} from './deployment-proof.ts'
import { lastGoodBootRevision, livePidIn, liveWatchdogPid, pidAlive, stateFile } from './state-files.ts'
import {
  discoverLaunchCommand, findOwnedListener, findPidOnPort, killPidTree,
  processIdentity, processIdentityMatches,
} from './processes.ts'
import { readInstanceLaunch, readSkillRegistration, writeAdoptionRecord, writeCompositionRecovery, writeInstanceLaunchAsSupervisor, writeRestartOutcome, writeUnexpectedExitRecord } from './restart-context.ts'
import {
  activeCutover, prepareLaunchCutover, readCutoverReceipt, readLaunchState, recordCutoverEvent,
  selectedLaunchSpec, summarizeLaunchState, writeCutoverControl, writeStableLaunchSpec,
  commandSha256,
  type BrowserHandoffPolicy, type CutoverRecoveryPolicy, type LaunchPreflightSpec, type LaunchSpec,
  type PreflightSurface,
} from './launch-spec.ts'
import {
  applyTransition, createPreflightSnapshot, createTransitionPreflightSnapshot, prepareTransition, rollbackTransition,
  validateTransitionPlan, type SnapshotProgress, type TransitionPlan,
} from './transition.ts'
import {
  appendTestLifecycleEvent, appendTestLifecycleEventForProcess, registerCurrentTestProcess, registerTestProcess,
  TEST_PROCESS_PORT_ENV, TEST_PROCESS_ROLE_ENV, TEST_PROCESS_TEMP_ROOT_ENV, TEST_RUN_DIR_ENV,
} from './test-seam.ts'

/** Parsed CLI options; empty stateDir/repoDir mean "use defaults". */
interface CliOptions {
  stateDir: string
  repoDir: string
  harnessRoot: string
  home: string
  maxAgeMinutes: number
  port: number | undefined
  command: string | undefined
  run: boolean
  runArgv: string[] | undefined
  message: string | undefined
  detail: string | undefined
  start: string | undefined
  pid: string | undefined
  timeoutMs: number | undefined
  delayMs: number | undefined
  stopTimeoutMs: number | undefined
  supervisorYieldTimeoutMs: number | undefined
  bootTimeoutMs: number | undefined
  log: string | undefined
  foreground: boolean
  rollback: boolean
  force: boolean
  sync: boolean
  initiator: string | undefined
  profile: string | undefined
  preflightTimeoutMs: number | undefined
  preflightSurface: PreflightSurface | undefined
  preflightRunner: string | undefined
  preflightInstallAnchor: string | undefined
  candidateProbeCommand: string | undefined
  onFailure: CutoverRecoveryPolicy | undefined
  browserHandoff: BrowserHandoffPolicy
  ifAbsent: boolean
  trustCommand: boolean
  includeDirty: boolean
  takeoverFrom: number | undefined
  cutoverId: string | undefined
  transitionFile: string | undefined
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
const FULL_ACCESS_HINT = 'hint: the restart loop spawns detached processes and signals them — a sandboxed session (not full-access) will fail with EPERM. You CANNOT switch the sandbox yourself (that is the point of it): ask the user to run /permission danger-full-access in THIS session (the settings page only affects NEW sessions; an open persistent terminal fences the switch)\n'

/**
 * Printed by verify/record while no watchdog supervises the instance. The
 * stop-capable schedule-exit verb has its own hard refusal for this state.
 */
const NO_WATCHDOG_HINT = 'warning: no live watchdog supervises the instance — a bare exit now leaves the service DOWN. Before the first restart, run `supervise --port N --start "CMD"` (it adopts the running instance and respawns ANY exit), or drive the restart with `restart` yourself\n'

/**
 * Best-effort sandbox detection: a workspace-write tool runner denies file
 * writes outside the workspace, so a probe file in the home directory EPERMs
 * exactly when the caller is sandboxed — the environment that reaps detached
 * restart/watchdog processes the moment the agent's turn ends (observed:
 * stale restart.lock with a dead holder, service left down).
 */
function sandboxedByProbe(): boolean {
  const probe = join(homedir(), `.ankh-guard-probe-${process.pid}`)
  try {
    writeFileSync(probe, '', { flag: 'wx' })
    unlinkSync(probe)
    return false
  } catch {
    return true
  }
}

/** Replaceable seams for tests; production keeps the defaults. */
export const envInternals = {
  sandboxedByProbe: (): boolean => sandboxedByProbe(),
}

/**
 * The environment gate for every verb whose detached child must outlive the
 * agent's turn (restart, schedule-exit, detached supervise): refuse when the
 * probe says sandboxed — a "yes, authorized" answer from the user does NOT
 * change the sandbox (only /permission in the session does), and a reaped
 * restart leaves the service down.
 */
function sandboxGate(verb: string, options: CliOptions, io: CliIo): boolean {
  if (options.force) return true
  if (!envInternals.sandboxedByProbe()) return true
  io.stderr(`${verb} refused: this environment is sandboxed (a probe write outside the workspace was denied), so a detached restart/watchdog process would be reaped when the turn ends. You cannot switch the sandbox yourself — ask the user to run /permission danger-full-access in THIS session (a yes/no "authorization" changes nothing), then verify with \`dsh-ankh-guard check-env\` and retry. Certain the probe is wrong? Re-run with --force\n`)
  return false
}

/**
 * Resolve the restart's initiating session. An explicit --initiator that
 * contradicts the shell's own DSH_SESSION_ID routes the wake-up report to a
 * session that is not the caller — observed 2026-08-29: an agent invented a
 * branch-derived slug ('skill-styles-merge'), the report went to a session
 * that does not exist, and the actual scheduler was never woken. Warn loudly;
 * do not refuse — scheduling on behalf of another session is legitimate.
 * @param explicit - the --initiator flag value, when given.
 * @param io - CLI streams.
 * @returns the initiator to record (explicit wins, else the env default).
 */
function resolveInitiator(explicit: string | undefined, io: CliIo): string | undefined {
  const fromEnv = process.env.DSH_SESSION_ID
  if (explicit !== undefined && explicit !== '' && fromEnv !== undefined && explicit !== fromEnv) {
    io.stderr(`warning: --initiator ${JSON.stringify(explicit)} does not match this session's DSH_SESSION_ID ${JSON.stringify(fromEnv)} — the restart report will be routed to ${JSON.stringify(explicit)} and THIS session will not be woken. Omit --initiator to route it to the current session.\n`)
  }
  return explicit !== undefined && explicit !== '' ? explicit : fromEnv
}

function testChildEnv(
  role: string,
  env: NodeJS.ProcessEnv,
  options: { port?: number; tempRoot?: string } = {},
): NodeJS.ProcessEnv {
  if (process.env[TEST_RUN_DIR_ENV] === undefined) return env
  return {
    ...env,
    [TEST_PROCESS_ROLE_ENV]: role,
    ...(options.port === undefined ? {} : { [TEST_PROCESS_PORT_ENV]: String(options.port) }),
    ...(options.tempRoot === undefined ? {} : { [TEST_PROCESS_TEMP_ROOT_ENV]: options.tempRoot }),
  }
}

function registerSpawnedTestProcess(
  child: ChildProcess,
  role: string,
  options: { port?: number; tempRoot?: string } = {},
): void {
  if (child.pid === undefined) return
  registerTestProcess(child.pid, role, {
    source: 'parent-observer',
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
  })
  appendTestLifecycleEventForProcess(child.pid, role, 'child-spawned', { childPid: child.pid, role }, 'parent-observer')
}

/**
 * Cross-session restart mutual exclusion: two concurrent restarts would both
 * stop the listener and double-start the instance — a port race whose loser
 * dies silently (stdio ignored). Atomic create, the watchdog pidfile's own
 * discipline; a stale lock (dead holder, or an empty file left by a writer
 * SIGKILLed mid-create) is reclaimed.
 */
function acquireRestartLock(stateDir: string, holderPid: number = process.pid): { ok: true; release(): void } | { ok: false; holder: string } {
  const file = stateFile(stateDir, 'restartLock')
  mkdirSync(stateDir, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(holderPid), { flag: 'wx' })
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
      if (pidAlive(holder)) return { ok: false, holder }
      try {
        unlinkSync(file)
      } catch (error) {
        return { ok: false, holder: `unreclaimable (${String(error)})` }
      }
    }
  }
  return { ok: false, holder: 'unknown' }
}

/** Release the restart lock only if it names this process (the detached driver's exit path). */
function releaseRestartLock(stateDir: string): void {
  const file = stateFile(stateDir, 'restartLock')
  try {
    if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file)
  } catch { /* already gone */ }
}

/**
 * argv (after process.execPath) that runs this CLI with the given args, with
 * the same source/built split as {@link guardInvocation} — array form for
 * spawn (the restart driver's self-detach).
 */
function cliInvocation(args: readonly string[]): string[] {
  const cliPath = fileURLToPath(import.meta.url)
  if (cliPath.includes(`${sep}src${sep}`)) {
    const nodeModules = resolve(dirname(cliPath), '../../../node_modules')
    const tsx = join(nodeModules, 'tsx', 'dist', 'esm', 'index.mjs')
    if (existsSync(tsx)) return ['--import', tsx, cliPath, ...args]
    return [cliPath, ...args]
  }
  return [join(cliPath), ...args]
}

const USAGE = `usage: dsh-ankh-guard <command> [args] [flags]
commands:
  verify [--state-dir DIR] [--repo DIR] [--max-age MIN]
  record <scope> [--state-dir DIR] [--repo DIR] --run -- PROGRAM [ARG...]
  record <scope> [--state-dir DIR] [--repo DIR] --trust-command --command CMD
  status [--state-dir DIR]
  clear [--state-dir DIR]
  checkpoint [--message MSG] [--include-dirty] [--repo DIR] [--state-dir DIR]
  reset <sha> [--repo DIR]
  canary [--port N] [--state-dir DIR] [--repo DIR] [--max-age MIN]
  verify-restart [--state-dir DIR]   # watchdog-facing: revalidate the scheduled authorization
  record-proven-deployment [--state-dir DIR]   # watchdog-facing: promote/retain proof after canary
  check-env [--state-dir DIR] [--repo DIR]   # sandbox / watchdog / git readiness probe
  preflight [--profile NAME] [--harness-root DIR] [--timeout-ms MS]
          [--preflight-surface source|built --preflight-install-anchor FILE] [--preflight-runner FILE]
  record-unexpected-exit [--state-dir DIR]   # watchdog-facing: record an unplanned-exit recovery
  record-adoption [--initiator ID] [--state-dir DIR]   # watchdog-facing: record the first (adoption) takeover
  record-composition-recovery [--state-dir DIR]   # watchdog-facing: record a composition-rollback recovery
  configure-launch --port N --start "CMD" [--home DIR] [--repo DIR] --harness-root DIR [--profile NAME]
          --preflight-surface source|built [--preflight-runner FILE] --preflight-install-anchor FILE [--if-absent]
  launch-status [--state-dir DIR]
  transition-apply CUTOVER_ID [--state-dir DIR]      # watchdog-facing: apply the prepared transition
  transition-rollback CUTOVER_ID [--state-dir DIR]   # watchdog-facing: restore previous state before previous starts
  abort-cutover [--state-dir DIR]      # apply the recovery policy approved by reconfigure
  restore-previous [--state-dir DIR]   # explicit new authorization to restore the complete previous spec
  reconfigure --start "CMD" --on-failure restore-previous|wait-for-user [--port N]
          [--home DIR] [--repo DIR] [--harness-root DIR] [--profile NAME] [--browser-handoff required|off]
          --preflight-surface source|built [--preflight-runner FILE] --preflight-install-anchor FILE
          --candidate-probe-command "CMD"
          [--transition-file FILE] [--delay-ms MS] [--supervisor-yield-timeout-ms MS] [--preflight-timeout-ms MS]
          [--boot-timeout-ms MS] [--state-dir DIR]
  restart --port N --start "CMD" [--pid PID] [--timeout-ms MS] [--delay-ms MS] [--stop-timeout-ms MS] [--rollback]
          [--profile NAME] [--harness-root DIR] [--preflight-timeout-ms MS] [--state-dir DIR] [--repo DIR] [--max-age MIN]
  schedule-exit [--port N] --delay-ms MS [--initiator ID] [--log FILE] [--profile NAME]
          [--harness-root DIR] [--preflight-timeout-ms MS] [--boot-timeout-ms MS] [--state-dir DIR] [--repo DIR]
  supervise --port N --start "CMD" [--foreground] [--log FILE] [--state-dir DIR] [--repo DIR] [--harness-root DIR] [--home DIR]
          [--cutover-id ID] [--boot-timeout-ms MS]
flags:
  --state-dir DIR  state directory (default: $DSH_HOME/state, else <cwd>/.dsh-guard-state)
  --repo DIR       repository the credential binds to (default: cwd)
  --harness-root DIR  dsh host checkout used by preflight and exported to the
                   child as DSH_HARNESS; launch-state initialization requires
                   this flag or an existing DSH_HARNESS
  --max-age MIN    credential freshness window in minutes (default: 10)
  --port N         canary/restart/supervise: TCP port that must be listening
  --run -- PROGRAM [ARG...]  record: execute this exact argv in --repo and record only on exit 0
  --trust-command  record: explicitly trust an external orchestrator's already-green --command
  --command CMD    record --trust-command: description of the externally proven command
  --message MSG    checkpoint: batch description
  --include-dirty  checkpoint: after review, explicitly commit every staged, unstaged, and untracked change
  --start "CMD"    restart/supervise/reconfigure: the shell command that starts the instance
                   (optional once the plugin has booted — it records the launch
                   command to <state-dir>/instance-launch.json)
  --pid PID        restart: process to stop (default: the listener on --port)
  --timeout-ms MS  restart: how long to wait for the new instance to listen (default 60000);
                   preflight: how long the dry-run boot may take (default 120000)
  --stop-timeout-ms MS  restart: how long to wait for the old instance to exit after SIGTERM
                   before escalating to SIGKILL (default 30000; large sessions writing out
                   logs can take tens of seconds to flush)
  --delay-ms MS    restart: sleep before stopping, so the current turn can finish first
                   (agent-driven graceful self-restart: schedule, complete, then restart);
                   schedule-exit: delay before the detached exit agent kills the host;
                   reconfigure: grace after successor supervisor claim before old-child stop
  --boot-timeout-ms MS  reconfigure/schedule-exit/supervise: readiness budget for one
                   boot (the watchdog's WD_BOOT_TIMEOUT, whole seconds, default 60).
                   reconfigure/supervise hand it to the spawned watchdog's environment;
                   schedule-exit records it in the restart marker for the respawn's boot
                   window only (the running watchdog then falls back to its own budget)
  --cutover-id ID  supervise: resume the durable launch-cutover transaction after its
                   supervisor chain died (the id is in launch-status / the receipt);
                   without it a bare supervise on an awaiting-user receipt only holds
                   the claim and consumes operator control markers, never booting the
                   rejected side
  --log FILE       supervise (detached only — with --foreground the external supervisor's
                   redirection owns the log) / schedule-exit: log file (default: <state-dir>/*.log)
  --home DIR       supervise: the dsh home the supervised instance boots with (profiles,
                   credentials — default: $DSH_HOME; required when that is unset)
  --initiator ID   schedule-exit: session id that requested the exit (default: $DSH_SESSION_ID);
                   recorded in last-restart.json so the restart report returns to that session.
                   Do NOT invent a value: a mismatched id routes the wake-up away from you
                   (the CLI warns when ID contradicts this shell's $DSH_SESSION_ID)
  --profile NAME   preflight/schedule-exit/restart/reconfigure: the dsh profile to dry-run (default:
                   $DSH_PROFILE, else "web")
  --preflight-timeout-ms MS  schedule-exit/restart: bound on the composition preflight (default 120000)
  --preflight-surface MODE  configure-launch/reconfigure: explicit successor module surface, source or built
  --preflight-runner FILE  runner file to bind by absolute path and SHA-256 (default: this package's matching face)
  --preflight-install-anchor FILE  the exact successor dsh package.json; built imports resolve from this npm toolchain
  --candidate-probe-command CMD  reconfigure: caller-supplied one-shot probe, durably co-bound with --start SHA-256
  --rollback       restart: on failure, git reset --hard to the recorded checkpoint
  --on-failure POLICY  reconfigure: REQUIRED pre-approved recovery policy:
                   restore-previous (restore the complete previous launch spec) or
                   wait-for-user (park without resetting a repository)
  --browser-handoff MODE  reconfigure: required (default) or off; when a protected
                   root announces a same-authority launch URL, readiness requires
                   303 cookie exchange and authenticated / = 200; browser handoff
                   separately requires an original/fallback page acknowledgement
  --transition-file FILE  reconfigure: a schema-v1 reversible quarantine plan.
                   The guard validates and preflights it on an isolated home,
                   then applies it only after previous stops; recovery retains
                   target-created replacements before restoring previous bytes.
  --if-absent      configure-launch: initialize only; keep an existing selected spec
  --force          restart/schedule-exit/supervise/reconfigure: override the sandbox probe refusal
  --sync           restart: run the whole loop in-process (debug/tests; the default
                   self-detaches a driver so the loop survives the caller's teardown)
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
    stateDir: '', repoDir: '', harnessRoot: '', home: '', maxAgeMinutes: 10, port: undefined, command: undefined, run: false, runArgv: undefined, message: undefined, detail: undefined,
    start: undefined, pid: undefined, timeoutMs: undefined, delayMs: undefined, stopTimeoutMs: undefined, supervisorYieldTimeoutMs: undefined,
    bootTimeoutMs: undefined,
    log: undefined,
    foreground: false, rollback: false, force: false, sync: false, initiator: undefined, profile: undefined, preflightTimeoutMs: undefined,
    preflightSurface: undefined, preflightRunner: undefined, preflightInstallAnchor: undefined, candidateProbeCommand: undefined,
    onFailure: undefined, browserHandoff: 'required', ifAbsent: false, trustCommand: false, includeDirty: false, takeoverFrom: undefined, cutoverId: undefined, transitionFile: undefined,
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
      if (arg === '--') {
        options.runArgv = argv.slice(i + 1)
        break
      }
      switch (arg) {
        case '--state-dir': options.stateDir = flagValue(arg, true) ?? ''; i++; break
        case '--home': options.home = flagValue(arg, true) ?? ''; i++; break
        case '--repo': options.repoDir = flagValue(arg, true) ?? ''; i++; break
        case '--harness-root': options.harnessRoot = flagValue(arg, true) ?? ''; i++; break
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
        case '--run': options.run = true; break
        case '--trust-command': options.trustCommand = true; break
        case '--include-dirty': options.includeDirty = true; break
        case '--message': options.message = flagValue(arg, true) ?? ''; i++; break
        case '--detail': options.detail = flagValue(arg, true); i++; break
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
        case '--supervisor-yield-timeout-ms': {
          const raw = flagValue(arg, true)
          const n = Number(raw)
          if (raw === undefined || !Number.isInteger(n) || n < 100) throw new Error('--supervisor-yield-timeout-ms must be an integer >= 100')
          options.supervisorYieldTimeoutMs = n
          i++
          break
        }
        case '--boot-timeout-ms': {
          const raw = flagValue(arg, true)
          const n = Number(raw)
          // The wrapper's budget is whole seconds; sub-second values are
          // rejected rather than silently rounded away.
          if (raw === undefined || !Number.isInteger(n) || n < 1000) throw new Error('--boot-timeout-ms must be an integer >= 1000')
          options.bootTimeoutMs = n
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
        case '--preflight-surface': {
          const value = flagValue(arg, true)
          if (value !== 'source' && value !== 'built') throw new Error('--preflight-surface must be source or built')
          options.preflightSurface = value
          i++
          break
        }
        case '--preflight-runner': options.preflightRunner = flagValue(arg, true) ?? ''; i++; break
        case '--preflight-install-anchor': options.preflightInstallAnchor = flagValue(arg, true) ?? ''; i++; break
        case '--candidate-probe-command': options.candidateProbeCommand = flagValue(arg, true) ?? ''; i++; break
        case '--on-failure': {
          const value = flagValue(arg, true)
          if (value !== 'restore-previous' && value !== 'wait-for-user') throw new Error('--on-failure must be restore-previous or wait-for-user')
          options.onFailure = value
          i++
          break
        }
        case '--browser-handoff': {
          const value = flagValue(arg, true)
          if (value !== 'required' && value !== 'off') throw new Error('--browser-handoff must be required or off')
          options.browserHandoff = value
          i++
          break
        }
        case '--takeover-from': {
          const raw = flagValue(arg, true)
          const value = Number(raw)
          if (raw === undefined || !Number.isInteger(value) || value <= 0) throw new Error('--takeover-from must be a positive pid')
          options.takeoverFrom = value
          i++
          break
        }
        case '--cutover-id': options.cutoverId = flagValue(arg, true) ?? ''; i++; break
        case '--transition-file': options.transitionFile = flagValue(arg, true) ?? ''; i++; break
        case '--if-absent': options.ifAbsent = true; break
        case '--rollback': options.rollback = true; break
        case '--force': options.force = true; break
        case '--sync': options.sync = true; break
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

/** Execute the exact argv used as credential evidence, streaming diagnostics. */
async function runCredentialCommand(
  argv: readonly string[],
  cwd: string,
  io: CliIo,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const executable = argv[0]
  if (executable === undefined || executable === '') return { ok: false, detail: 'no program was provided after --' }
  return new Promise((resolvePromise) => {
    let settled = false
    const settle = (result: { ok: true } | { ok: false; detail: string }): void => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    let child
    try {
      child = spawn(executable, argv.slice(1), {
        cwd,
        env: testChildEnv('credential-command', { ...process.env }, { tempRoot: cwd }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      registerSpawnedTestProcess(child, 'credential-command', { tempRoot: cwd })
    } catch (error) {
      settle({ ok: false, detail: `could not start ${JSON.stringify(executable)}: ${String(error)}` })
      return
    }
    child.stdout.on('data', (chunk: Buffer) => { io.stdout(chunk.toString()) })
    child.stderr.on('data', (chunk: Buffer) => { io.stderr(chunk.toString()) })
    child.once('error', (error) => {
      settle({ ok: false, detail: `could not start ${JSON.stringify(executable)}: ${String(error)}` })
    })
    child.once('exit', (code, signal) => {
      if (code === 0) settle({ ok: true })
      else settle({ ok: false, detail: signal === null ? `command exited ${code ?? 'without a status'}` : `command was terminated by ${signal}` })
    })
  })
}

/** Stable, non-shell rendering for credential audit metadata. */
function renderArgv(argv: readonly string[]): string {
  return argv.map(word => JSON.stringify(word)).join(' ')
}

/** The credential gate always includes uncommitted and untracked inputs. */
function verifyRepoCredential(stateDir: string, repoDir: string, maxAgeMinutes: number) {
  return verifyCredential(
    loadState(stateDir), currentHead(repoDir), Date.now(), maxAgeMinutes, isWorkingTreeClean(repoDir),
  )
}

/**
 * How the spawned watchdog should invoke the guard CLI. The executable is
 * always the ABSOLUTE process.execPath, never a bare `node`: the watchdog runs
 * under whatever PATH spawned it, and a launcher chain (launchd/systemd) has a
 * minimal PATH without homebrew — a bare `node` there makes every guard
 * invocation the watchdog issues (canary, record-proven-deployment, cutover
 * events) fail with command-not-found (the 2026-09-30 launchd incident). The
 * source form additionally needs tsx with an absolute path (the watchdog runs
 * with a deployment cwd that resolves no node_modules).
 * @returns the command prefix (verb args are appended by the watchdog).
 */
export function guardInvocation(): string {
  const cliPath = fileURLToPath(import.meta.url)
  if (cliPath.includes(`${sep}src${sep}`)) {
    // Source form: locate the tsx loader relative to this file's own
    // node_modules (works in the monorepo checkout and in a standalone
    // package tree alike), falling back to plain node when absent.
    const nodeModules = resolve(dirname(cliPath), '../../../node_modules')
    const tsx = join(nodeModules, 'tsx', 'dist', 'esm', 'index.mjs')
    if (existsSync(tsx)) return `${process.execPath} --import ${tsx} ${cliPath}`
    return `${process.execPath} ${cliPath}`
  }
  return `${process.execPath} ${cliPath}`
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

interface RestartRequestMarker {
  requestedAt?: number
  authorization?: RestartAuthorization
}

function isRestartAuthorization(value: unknown): value is RestartAuthorization {
  if (typeof value !== 'object' || value === null) return false
  const authorization = value as Partial<RestartAuthorization>
  return authorization.version === 1
    && (authorization.kind === 'fresh-credential' || authorization.kind === 'proven-deployment')
    && typeof authorization.revision === 'string' && authorization.revision !== ''
    && typeof authorization.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(authorization.evidenceSha256)
}

function readRestartRequestMarker(stateDir: string): RestartRequestMarker | null {
  try {
    const marker = JSON.parse(readFileSync(stateFile(stateDir, 'restartRequested'), 'utf8')) as RestartRequestMarker
    if (typeof marker !== 'object' || marker === null) return null
    return {
      ...(typeof marker.requestedAt === 'number' ? { requestedAt: marker.requestedAt } : {}),
      ...(isRestartAuthorization(marker.authorization) ? { authorization: marker.authorization } : {}),
    }
  } catch {
    return null
  }
}

/**
 * The restart marker's state. Every verb that can stop the instance must
 * consult this (and the restart lock) — a stop right invisible to the other
 * verb is how an exit agent once got to SIGTERM a freshly restarted instance.
 */
function restartMarkerState(stateDir: string): 'none' | 'fresh' | 'stale' {
  const file = stateFile(stateDir, 'restartRequested')
  if (!existsSync(file)) return 'none'
  const marker = readRestartRequestMarker(stateDir)
  return marker?.requestedAt !== undefined && Date.now() - marker.requestedAt <= RESTART_MARKER_TTL_MS ? 'fresh' : 'stale'
}

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
 * runner resolves the official published packages from): the
 * `--harness-root` target when given, else `DSH_HARNESS`, else the
 * conventional default. Credential repositories never enter this resolver.
 */
export function resolveHarnessRoot(optionHarnessRoot: string | undefined, env: Record<string, string | undefined> = process.env): string {
  if (optionHarnessRoot !== undefined && optionHarnessRoot !== '') return optionHarnessRoot
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
  return `node --import ${shellQuote(tsx)} ${shellQuote(runner)} --host-surface source --install-anchor ${shellQuote(join(harnessRoot, 'apps', 'cli', 'package.json'))}`
}

function fileSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function killSpawnGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try { process.kill(-pid, 'SIGKILL') } catch { /* already exited or platform lacks process groups */ }
}

function defaultPreflightRunner(surface: PreflightSurface): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const names = surface === 'source'
    ? [
        join(here, 'preflight-runner.ts'), join(here, '..', 'src', 'preflight-runner.ts'),
        join(here, 'preflight-runner.js'), join(here, '..', 'lib', 'preflight-runner.js'),
      ]
    : [join(here, 'preflight-runner.js'), join(here, '..', 'lib', 'preflight-runner.js')]
  return names.find(file => existsSync(file))
}

/** Build and validate the explicit preflight contract persisted with a launch spec. */
function resolvePreflightSpec(
  options: CliOptions,
  command: string,
  harnessRoot: string,
  requireCandidate: boolean,
): LaunchPreflightSpec {
  if (options.preflightSurface === undefined) {
    throw new Error('--preflight-surface source|built is required; the guard will not infer the successor execution surface')
  }
  if (options.preflightInstallAnchor === undefined || options.preflightInstallAnchor === '') {
    throw new Error('--preflight-install-anchor FILE is required and must name the successor dsh package.json')
  }
  const installAnchor = resolve(options.preflightInstallAnchor)
  let manifest: { name?: unknown; version?: unknown }
  try {
    manifest = JSON.parse(readFileSync(installAnchor, 'utf8')) as { name?: unknown; version?: unknown }
  } catch (error) {
    throw new Error(`preflight install anchor is unreadable: ${String(error)}`)
  }
  if (manifest.name !== '@deepseek-ai/dsh') {
    throw new Error('preflight install anchor must be @deepseek-ai/dsh/package.json')
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('preflight install anchor must declare the dsh package version')
  }
  const configuredRunner = options.preflightRunner ?? defaultPreflightRunner(options.preflightSurface)
  if (configuredRunner === undefined || configuredRunner === '') {
    throw new Error(`no ${options.preflightSurface} preflight runner exists; build ankh-guard or pass --preflight-runner FILE`)
  }
  const runnerPath = resolve(configuredRunner)
  if (!existsSync(runnerPath)) throw new Error(`preflight runner does not exist: ${runnerPath}`)
  if (options.preflightSurface === 'built' && !runnerPath.endsWith('.js')) {
    throw new Error('built preflight requires a JavaScript runner')
  }
  const runnerRuntimeArgs: string[] = []
  if (options.preflightSurface === 'source') {
    const tsx = join(harnessRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
    if (!existsSync(tsx)) throw new Error(`source preflight requires the target checkout's tsx runtime: ${tsx}`)
    runnerRuntimeArgs.push('--import', tsx)
  }
  const candidateProbeCommand = options.candidateProbeCommand
  if (requireCandidate && (candidateProbeCommand === undefined || candidateProbeCommand.trim() === '')) {
    throw new Error('--candidate-probe-command CMD is required; the caller must derive it from the target executable/argv before the previous host stops')
  }
  return {
    version: 1,
    surface: options.preflightSurface,
    runnerExecutable: process.execPath,
    runnerRuntimeArgs,
    runnerPath,
    runnerSha256: fileSha256(runnerPath),
    installAnchor,
    installAnchorSha256: fileSha256(installAnchor),
    hostPackageVersion: manifest.version,
    targetCommandSha256: commandSha256(command),
    ...(candidateProbeCommand === undefined || candidateProbeCommand.trim() === '' ? {} : {
      candidateProbeCommand,
      candidateProbeSha256: commandSha256(candidateProbeCommand),
      candidateProbeProvenance: 'caller-supplied' as const,
    }),
  }
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
 * The --start command: the flag, else the launch record written at boot. The
 * record is what lets an agent restart without reconstructing the instance's
 * launch command (ps is sandbox-blocked; "who supervises me" sent
 * fresh-machine agents into loops). On `restart`, a SUPERVISED record refuses
 * the fallback: spawning the instance directly would fight the supervisor's
 * respawn (double-start race) — schedule-exit is the supervised path.
 */
function resolveStartCommand(flag: string | undefined, stateDir: string, verb: 'restart' | 'supervise', io: CliIo, port: number | undefined): string | undefined {
  if (flag !== undefined && flag !== '') return flag
  // A LIVE supervisor owns every respawn; a bare restart would fight it —
  // refuse all fallbacks, whatever their source.
  if (verb === 'restart' && liveWatchdogPid(stateDir) !== null) {
    io.stderr('restart: a watchdog is alive and owns this port — a bare restart would fight its respawn. Drive the restart with `schedule-exit` (the watchdog respawns and canaries)\n')
    return undefined
  }
  const launch = readInstanceLaunch(stateDir)
  if (launch?.supervised === true) {
    // The record says supervised but the watchdog is DEAD: refusing here
    // sends the agent to schedule-exit, which kills the instance with nobody
    // to respawn it — the documented dead-end. Warn and rescue instead.
    io.stderr('warning: the launch record says this instance was watchdog-supervised, but no live watchdog was found — proceeding with the recorded command as a rescue; re-establish `supervise` after this restart\n')
  }
  if (launch !== null) return launch.command
  // No record (plugin never booted here): discover the launch live from the
  // port's listener — the CLI reads ps/lsof the agent's sandbox denies.
  if (port !== undefined) {
    const pid = findPidOnPort(port)
    if (pid !== null) {
      try {
        const discovered = discoverLaunchCommand(pid)
        if (discovered !== null) return discovered
      } catch (error) {
        io.stderr(`live launch discovery failed (${String(error)}) — ps is sandbox-blocked in this turn; rerun this command escalated (sandbox_permissions) or pass --start explicitly\n`)
      }
    }
  }
  return undefined
}

/** check-env display: redact credential-shaped env values inside the command. */
function redactLaunchCommand(command: string): string {
  return command.replace(/([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*=)'(?:[^'\\]|\\')*'/g, "$1'<redacted>'")
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
 * @param home - dsh home the dry-run must read instead of ambient process state.
 * @returns the classified outcome.
 */
export async function runPreflightCheck(
  profile: string, timeoutMs: number, harnessRoot?: string, home?: string, binding?: LaunchPreflightSpec,
): Promise<PreflightOutcome> {
  const override = binding === undefined ? process.env.DSH_PREFLIGHT_COMMAND : undefined
  let command: string | undefined
  let executable: string | undefined
  let argv: string[] = []
  let usingRunner = false
  if (binding !== undefined) {
    let runnerSha: string
    try { runnerSha = fileSha256(binding.runnerPath) } catch {
      return { kind: 'infra-failed', output: '', detail: `the bound preflight runner is unavailable: ${binding.runnerPath}` }
    }
    if (runnerSha !== binding.runnerSha256) {
      return { kind: 'infra-failed', output: '', detail: 'the bound preflight runner changed after launch configuration' }
    }
    try {
      if (fileSha256(binding.installAnchor) !== binding.installAnchorSha256) {
        return { kind: 'infra-failed', output: '', detail: 'the bound dsh install anchor changed after launch configuration' }
      }
    } catch {
      return { kind: 'infra-failed', output: '', detail: `the bound dsh install anchor is unavailable: ${binding.installAnchor}` }
    }
    executable = binding.runnerExecutable
    argv = [
      ...binding.runnerRuntimeArgs,
      binding.runnerPath,
      '--host-surface', binding.surface,
      '--install-anchor', binding.installAnchor,
      '--profile', profile,
    ]
    usingRunner = true
  } else if (override !== undefined && override !== '') {
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
    const preflightEnv = testChildEnv('composition-preflight', {
      ...process.env,
      DSH_HARNESS: harnessForRunner,
      ...(home === undefined ? {} : { DSH_HOME: home }),
    }, { ...(home === undefined ? {} : { tempRoot: home }) })
    const child = executable === undefined
      ? spawn(command ?? '', { shell: true, env: preflightEnv })
      : spawn(executable, argv, { shell: false, env: preflightEnv })
    registerSpawnedTestProcess(child, 'composition-preflight', { ...(home === undefined ? {} : { tempRoot: home }) })
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

/** Execute the caller-supplied one-shot probe under the target home/root. */
async function runCandidateProbe(
  binding: LaunchPreflightSpec,
  targetCommand: string,
  timeoutMs: number,
  harnessRoot: string,
  home: string,
): Promise<PreflightOutcome> {
  if (binding.targetCommandSha256 !== commandSha256(targetCommand)) {
    return { kind: 'infra-failed', output: '', detail: 'candidate probe is bound to a different target launch command' }
  }
  if (binding.candidateProbeCommand === undefined || binding.candidateProbeSha256 === undefined
    || commandSha256(binding.candidateProbeCommand) !== binding.candidateProbeSha256) {
    return { kind: 'infra-failed', output: '', detail: 'candidate probe command is missing or changed after binding' }
  }
  return await new Promise(resolvePromise => {
    let output = ''
    let timedOut = false
    const child = spawn(binding.candidateProbeCommand!, {
      shell: true,
      detached: true,
      env: testChildEnv('candidate-probe', {
        ...process.env,
        DSH_HARNESS: harnessRoot,
        DSH_HOME: home,
        ANKH_TARGET_COMMAND_SHA256: binding.targetCommandSha256,
      }, { tempRoot: home }),
    })
    registerSpawnedTestProcess(child, 'candidate-probe', { tempRoot: home })
    const append = (chunk: Buffer): void => {
      if (output.length < PREFLIGHT_OUTPUT_CAP) output += chunk.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      killSpawnGroup(child.pid)
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) resolvePromise({ kind: 'infra-failed', output, detail: `candidate probe timed out after ${timeoutMs} ms` })
      else if (code === 0) resolvePromise({ kind: 'pass', output })
      else resolvePromise({ kind: 'composition-failed', output, detail: `candidate probe exited ${String(code)}` })
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

/** A persisted launch spec must never guess which checkout is the host. */
function resolveLaunchHarnessRoot(optionHarnessRoot: string, selected?: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (optionHarnessRoot !== '') return optionHarnessRoot
  if (selected !== undefined && selected !== '') return selected
  const fromEnv = env.DSH_HARNESS
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined
}

function launchSpec(input: {
  command: string
  port: number
  home: string
  credentialRepo: string
  harnessRoot: string
  profile: string
  preflight?: LaunchPreflightSpec
}): LaunchSpec {
  return {
    version: 1,
    command: input.command,
    port: input.port,
    home: resolve(input.home),
    credentialRepo: resolve(input.credentialRepo),
    harnessRoot: resolve(input.harnessRoot),
    profile: input.profile,
    ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
  }
}

function sameLaunchSpec(left: LaunchSpec, right: LaunchSpec): boolean {
  return left.command === right.command && left.port === right.port && left.home === right.home
    && left.credentialRepo === right.credentialRepo && left.harnessRoot === right.harnessRoot
    && left.profile === right.profile
    && JSON.stringify(left.preflight) === JSON.stringify(right.preflight)
}

/** Resolve supervise's complete spec; a post-wait refresh always prefers durable state. */
function resolveSuperviseSpec(
  options: CliOptions,
  stateDir: string,
  repoDir: string,
  io: CliIo,
  preferDurable = false,
): LaunchSpec | undefined {
  const durable = readLaunchState(stateDir)
  const selected = durable === null ? undefined : selectedLaunchSpec(durable)
  const recorded = readInstanceLaunch(stateDir)
  const port = preferDurable && selected !== undefined ? selected.port : options.port ?? selected?.port ?? recorded?.port
  if (port === undefined) {
    io.stderr(`supervise requires --port N and --start "CMD" on first configuration\n\n${USAGE}`)
    return undefined
  }
  const command = !preferDurable && options.start !== undefined && options.start !== ''
    ? options.start
    : selected?.command ?? resolveStartCommand(undefined, stateDir, 'supervise', io, port)
  if (command === undefined || command === '') {
    io.stderr(`supervise requires --port N and --start "CMD" on first configuration\n\n${USAGE}`)
    return undefined
  }
  const home = !preferDurable && options.home !== '' ? options.home : selected?.home ?? resolveWdHome('')
  if (home === undefined) {
    io.stderr('supervise needs the dsh home: pass --home DIR or set DSH_HOME — the supervised instance reads its profiles/credentials from there, and deriving one from --state-dir would guess wrong\n')
    return undefined
  }
  const harnessRoot = resolveLaunchHarnessRoot(
    !preferDurable ? options.harnessRoot : '',
    selected?.harnessRoot,
  )
  if (harnessRoot === undefined) {
    io.stderr('supervise needs the dsh host checkout: pass --harness-root DIR or set DSH_HARNESS. The credential --repo is a separate role and is never used as the host root.\n')
    return undefined
  }
  return launchSpec({
    command,
    port,
    home,
    credentialRepo: !preferDurable && options.repoDir !== '' ? repoDir : selected?.credentialRepo ?? repoDir,
    harnessRoot,
    profile: !preferDurable && options.profile !== undefined && options.profile !== ''
      ? options.profile
      : selected?.profile ?? resolveProfileName(options),
    ...(selected?.preflight === undefined || selected.command !== command ? {} : { preflight: selected.preflight }),
  })
}

/** Existing full spec. The legacy launch record lacks both repository roles. */
function resolvePreviousSpec(stateDir: string, io: CliIo): LaunchSpec | undefined {
  const state = readLaunchState(stateDir)
  if (state !== null) return selectedLaunchSpec(state)
  io.stderr('reconfigure refused: no complete durable previous launch specification is available. The legacy instance-launch record does not identify credential repo, host root, home, and profile independently. Run `configure-launch --port N --start "CURRENT CMD" --home DIR --repo CREDENTIAL_REPO --harness-root HOST_ROOT --profile NAME` first.\n')
  return undefined
}

/** The first ~40 lines of captured preflight output, newline-terminated, or empty. */
function summarizeOutput(output: string): string {
  if (output.trim() === '') return ''
  // A failed candidate or composition can print its one-time browser launch
  // URL. Diagnostics may name the authority/path, never the bearer value.
  const redacted = output.replace(/([?&](?:token|grant)=)[^\s&#"']+/gi, '$1<redacted>')
  const lines = redacted.split('\n')
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
 * @param home - dsh home to dry-run.
 * @returns whether the verb may proceed.
 */
async function preflightGate(
  verb: string, profile: string, timeoutMs: number, io: CliIo, harnessRoot?: string, home?: string,
  binding?: LaunchPreflightSpec,
): Promise<boolean> {
  // The runner may legitimately consume most of its timeout while cold-loading
  // a full profile. Announce the blocking stage before awaiting it so a managed
  // shell with a shorter caller deadline does not report a misleading
  // "no output" timeout. This line is deliberately free of paths and runner
  // output: launch URLs and other credential-shaped diagnostics remain inside
  // the redacted completion path below.
  io.stdout(`composition preflight START (profile ${JSON.stringify(profile)}, timeout ${timeoutMs} ms)\n`)
  const outcome = await runPreflightCheck(profile, timeoutMs, harnessRoot, home, binding)
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

async function candidateProbeGate(
  target: LaunchSpec,
  timeoutMs: number,
  io: CliIo,
  home: string,
): Promise<boolean> {
  if (target.preflight === undefined) {
    io.stderr('reconfigure refused: target has no explicit candidate probe binding\n')
    return false
  }
  const outcome = await runCandidateProbe(
    target.preflight, target.command, timeoutMs, target.harnessRoot, home,
  )
  if (outcome.kind === 'pass') {
    io.stdout(`candidate command probe PASS (target command ${target.preflight.targetCommandSha256.slice(0, 16)})\n`)
    return true
  }
  io.stderr(`reconfigure refused: candidate command probe ${outcome.kind === 'composition-failed' ? 'failed' : 'could not execute'}${
    outcome.detail === undefined ? '' : ` — ${outcome.detail}`
  }:\n${summarizeOutput(outcome.output)}`)
  return false
}

/** Same-launch verbs follow the durable host root unless explicitly overridden. */
function preflightHarnessRoot(options: CliOptions, stateDir: string): string {
  if (options.harnessRoot !== '') return resolveHarnessRoot(options.harnessRoot)
  const state = readLaunchState(stateDir)
  return state === null ? resolveHarnessRoot(undefined) : selectedLaunchSpec(state).harnessRoot
}

/**
 * A same-launch restart must use the exact durable supervisor configuration.
 * Explicit flags may confirm that configuration, but may not silently replace
 * one field while the live watchdog still owns a different command.
 */
function stableScheduleSpec(
  options: CliOptions,
  stateDir: string,
  resolvedRepoDir: string,
  io: CliIo,
): LaunchSpec | null | undefined {
  const state = readLaunchState(stateDir)
  if (state === null) return null
  if (state.mode !== 'stable') {
    io.stderr(`schedule-exit refused: launch state is still in cutover mode (${state.cutoverId}); settle its receipt before a same-launch restart\n`)
    return undefined
  }
  const active = state.active
  const conflicts: string[] = []
  if (options.port !== undefined && options.port !== active.port) conflicts.push(`port ${options.port} != ${active.port}`)
  if (options.repoDir !== '' && resolve(resolvedRepoDir) !== resolve(active.credentialRepo)) {
    conflicts.push(`credential repo ${resolve(resolvedRepoDir)} != ${resolve(active.credentialRepo)}`)
  }
  if (options.harnessRoot !== '' && resolve(options.harnessRoot) !== resolve(active.harnessRoot)) {
    conflicts.push(`harness root ${resolve(options.harnessRoot)} != ${resolve(active.harnessRoot)}`)
  }
  if (options.profile !== undefined && options.profile !== '' && options.profile !== active.profile) {
    conflicts.push(`profile ${options.profile} != ${active.profile}`)
  }
  if (conflicts.length > 0) {
    io.stderr(`schedule-exit refused: explicit flags conflict with the durable active launch specification (${conflicts.join('; ')}). Use reconfigure for launch changes.\n`)
    return undefined
  }
  const recorded = readInstanceLaunch(stateDir)
  if (recorded === null || recorded.source !== 'supervisor' || recorded.supervised !== true
    || recorded.command !== active.command || recorded.port !== active.port) {
    io.stderr('schedule-exit refused: the live instance launch record does not prove that its supervisor owns the durable active launch specification. Re-establish supervision or use reconfigure; do not stop the host on an inferred command.\n')
    return undefined
  }
  return active
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
 * A machine-readable refusal verdict: which gate denied, plus a one-line
 * reason. In-process callers (the selfRestartGuard.requestRestart service
 * seam) read it back from the verdict file named by DSH_ANKH_VERDICT_FILE
 * instead of scraping the human stderr text.
 */
export interface CliRefusal {
  stage: string
  reason: string
}

/**
 * Run one CLI invocation against the guard state.
 * @param argv - arguments after the subcommand name.
 * @param io - output sinks.
 * @returns the process exit code: 0 ok, 1 gate denied / failure, 2 usage error.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  // The FIRST refusal is the verdict; later ones are fallout of the same stop.
  // The verdict file is a courtesy channel for the service seam — a write
  // failure changes nothing, the human refusal text stands either way.
  const verdictFile = process.env.DSH_ANKH_VERDICT_FILE
  let recorded: CliRefusal | undefined
  const note = (stage: string, reason: string): void => {
    if (recorded !== undefined) return
    recorded = { stage, reason }
    if (verdictFile !== undefined) {
      try { writeFileSync(verdictFile, `${JSON.stringify(recorded)}\n`, { mode: 0o600 }) } catch { /* courtesy channel */ }
    }
  }
  /** Record + print a one-line refusal, preserving the site's exit code. */
  const refuse = (stage: string, message: string, code = 1): number => {
    note(stage, message.trim().split('\n', 1)[0] ?? message.trim())
    io.stderr(message.endsWith('\n') ? message : `${message}\n`)
    return code
  }
  /** Record a refusal whose human text a gate already printed. */
  const refuseQuiet = (stage: string, reason: string, code = 1): number => {
    note(stage, reason)
    return code
  }
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
      const launch = readLaunchState(stateDir)
      const result = launch?.mode === 'stable'
        && resolve(launch.active.credentialRepo) === resolve(repoDir)
        ? verifyRestartEvidence(stateDir, launch.active, options.maxAgeMinutes)
        : verifyRepoCredential(stateDir, repoDir, options.maxAgeMinutes)
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
      if (positionals.length > 1) {
        io.stderr(`record accepts one <scope>; put the evidence command after --run --\n\n${USAGE}`)
        return 2
      }
      if (options.run && options.trustCommand) {
        io.stderr('record requires exactly one proof mode: --run or --trust-command\n')
        return 2
      }
      if (options.run && options.command !== undefined) {
        io.stderr('record --run derives its audit command from the exact argv after --; do not also pass --command\n')
        return 2
      }
      if (options.runArgv !== undefined && !options.run) {
        io.stderr('record command argv after -- requires --run\n')
        return 2
      }
      if (!options.run && !options.trustCommand) {
        io.stderr('record refuses self-attestation: use --run -- PROGRAM [ARG...] so the guard observes exit 0, or --trust-command --command CMD only from an external orchestrator that already observed the command\n')
        return 2
      }
      if (options.run && (options.runArgv === undefined || options.runArgv.length === 0)) {
        io.stderr('record --run requires -- PROGRAM [ARG...]\n')
        return 2
      }
      if (options.trustCommand && (options.command === undefined || options.command.trim() === '')) {
        io.stderr('record --trust-command requires a non-empty --command description\n')
        return 2
      }
      const headBefore = currentHead(repoDir)
      if (headBefore === null) {
        io.stderr('cannot record a credential outside a git repository\n')
        return 1
      }
      if (!isWorkingTreeClean(repoDir)) {
        io.stderr('cannot record a credential while the working tree has staged, unstaged, or untracked changes\n')
        return 1
      }
      let evidenceCommand = options.command ?? ''
      if (options.run) {
        const runArgv = options.runArgv ?? []
        // A failed/replaced proof attempt must not leave an older credential
        // available to a subsequent restart command in another session.
        clearCredential(stateDir, Date.now())
        evidenceCommand = renderArgv(runArgv)
        io.stdout(`running credential evidence: ${evidenceCommand}\n`)
        const evidence = await runCredentialCommand(runArgv, repoDir, io)
        if (!evidence.ok) {
          io.stderr(`credential evidence failed: ${evidence.detail}; no credential recorded\n`)
          return 1
        }
        const headAfter = currentHead(repoDir)
        if (headAfter !== headBefore || !isWorkingTreeClean(repoDir)) {
          io.stderr('credential evidence exited 0 but changed HEAD or left the working tree dirty; no credential recorded\n')
          return 1
        }
      }
      recordCredential(stateDir, { scope, revision: headBefore, command: evidenceCommand }, Date.now())
      io.stdout(`recorded green credential: ${scope} @ ${headBefore}${options.trustCommand ? ' (external proof trusted)' : ''}\n`)
      io.stdout(FULL_ACCESS_HINT)
      if (liveWatchdogPid(stateDir) === null) io.stderr(NO_WATCHDOG_HINT)
      return 0
    }
    case 'status': {
      const state = loadState(stateDir)
      io.stdout(`${JSON.stringify(state, null, 2)}\n`)
      return 0
    }
    case 'configure-launch': {
      if (options.ifAbsent && readLaunchState(stateDir) !== null) {
        io.stdout('launch specification already exists — kept it unchanged (--if-absent)\n')
        return 0
      }
      if (options.port === undefined || options.start === undefined || options.start === '') {
        io.stderr(`configure-launch requires --port N and --start "CMD"\n\n${USAGE}`)
        return 2
      }
      const home = resolveWdHome(options.home)
      if (home === undefined) {
        io.stderr('configure-launch requires --home DIR or DSH_HOME\n')
        return 2
      }
      const harnessRoot = resolveLaunchHarnessRoot(options.harnessRoot)
      if (harnessRoot === undefined) {
        io.stderr('configure-launch requires --harness-root DIR or DSH_HARNESS; --repo names the independent credential/rollback repository\n')
        return 2
      }
      let preflight: LaunchPreflightSpec
      try {
        preflight = resolvePreflightSpec(options, options.start, harnessRoot, false)
      } catch (error) {
        io.stderr(`configure-launch refused: ${error instanceof Error ? error.message : String(error)}\n`)
        return 2
      }
      const spec = launchSpec({
        command: options.start,
        port: options.port,
        home,
        credentialRepo: repoDir,
        harnessRoot,
        profile: resolveProfileName(options),
        preflight,
      })
      const written = writeStableLaunchSpec(stateDir, spec, options.ifAbsent)
      if (written) {
        writeInstanceLaunchAsSupervisor(stateDir, {
          command: spec.command, source: 'supervisor', supervised: true, port: spec.port, recordedAt: Date.now(),
        })
      }
      io.stdout(written
        ? `launch specification recorded for :${spec.port} (command sha is in launch-status)\n`
        : 'launch specification already exists — kept it unchanged (--if-absent)\n')
      return 0
    }
    case 'launch-status': {
      io.stdout(`${JSON.stringify({ launch: summarizeLaunchState(readLaunchState(stateDir)), receipt: readCutoverReceipt(stateDir) }, null, 2)}\n`)
      return 0
    }
    case 'transition-apply':
    case 'transition-rollback': {
      const id = positionals[0]
      if (id === undefined || positionals.length !== 1) {
        io.stderr(`${command} requires one CUTOVER_ID\n`)
        return 2
      }
      const transaction = activeCutover(stateDir)
      if (transaction === null || transaction.receipt.id !== id || transaction.state.transition === undefined) {
        io.stderr(`${command} refused: cutover ${id} has no active prepared transition\n`)
        return 1
      }
      const reference = transaction.state.transition
      const identityIsLive = (pid: number | undefined, startToken: string | undefined): boolean => (
        pid !== undefined && startToken !== undefined && processIdentityMatches({ pid, startToken })
      )
      if (command === 'transition-apply') {
        if (transaction.state.selected !== 'target') {
          io.stderr('transition-apply refused: the target launch specification is not selected\n')
          return 1
        }
        const previous = transaction.receipt.ownership.previous
        if (identityIsLive(previous.childPid, previous.childStartToken)
          || identityIsLive(previous.listenerPid, previous.listenerStartToken)) {
          io.stderr('transition-apply refused: the proven previous process is still alive\n')
          return 1
        }
        try {
          const result = applyTransition(reference, transaction.state.previous.home, stateDir, id)
          recordCutoverEvent(stateDir, id, 'transition', ['applied', reference.planSha256], Date.now())
          io.stdout(`transition applied (${result.changed.length} changed, ${result.unchanged.length} unchanged)\n`)
          return 0
        } catch (error) {
          try {
            recordCutoverEvent(stateDir, id, 'transition', [
              'apply-failed', reference.planSha256, error instanceof Error ? error.message : String(error),
            ], Date.now())
          } catch { /* the original transition failure remains authoritative */ }
          io.stderr(`transition-apply failed: ${String(error)}\n`)
          return 1
        }
      }
      const liveTarget = transaction.receipt.attempts.some(attempt => (
        attempt.role === 'target' && identityIsLive(attempt.childPid, attempt.childStartToken)
      ))
      const targetOwnership = transaction.receipt.ownership.target
      if (liveTarget || (targetOwnership !== undefined
        && (identityIsLive(targetOwnership.childPid, targetOwnership.childStartToken)
          || identityIsLive(targetOwnership.listenerPid, targetOwnership.listenerStartToken)))) {
        io.stderr('transition-rollback refused: a proven target process is still alive\n')
        return 1
      }
      try {
        const result = rollbackTransition(reference, transaction.state.previous.home, stateDir, id)
        recordCutoverEvent(stateDir, id, 'transition', ['rolled-back', reference.planSha256], Date.now())
        io.stdout(`transition rolled back (${result.changed.length} changed, ${result.unchanged.length} unchanged)\n`)
        return 0
      } catch (error) {
        try {
          recordCutoverEvent(stateDir, id, 'transition', [
            'rollback-failed', reference.planSha256, error instanceof Error ? error.message : String(error),
          ], Date.now())
        } catch { /* the original transition failure remains authoritative */ }
        io.stderr(`transition-rollback failed: ${String(error)}\n`)
        return 1
      }
    }
    case 'abort-cutover':
    case 'restore-previous': {
      const transaction = activeCutover(stateDir)
      if (transaction === null) {
        io.stderr(`${command} refused: no nonterminal launch cutover is active\n`)
        return 1
      }
      const watchdogPid = liveWatchdogPid(stateDir)
      if (watchdogPid === null) {
        io.stderr(`${command} refused: no live watchdog can consume the durable control request. Start the consumer first: \`supervise --state-dir ${stateDir}\` holds the awaiting-user cutover ${transaction.receipt.id} without launching anything, or \`supervise --cutover-id ${transaction.receipt.id} --state-dir ${stateDir}\` resumes the selected side directly\n`)
        return 1
      }
      const requested = command === 'restore-previous' ? 'restore-previous' : 'abort'
      try {
        const control = writeCutoverControl(stateDir, transaction.receipt.id, requested, Date.now())
        appendTestLifecycleEvent('control-marker-written', { action: control.action, watchdogPid }, 'parent-observer')
        try {
          process.kill(watchdogPid, 'SIGUSR2')
          appendTestLifecycleEvent('signal-result', { signal: 'SIGUSR2', targetPid: watchdogPid, result: 'sent' }, 'parent-observer')
        } catch (error) {
          appendTestLifecycleEvent('signal-result', { signal: 'SIGUSR2', targetPid: watchdogPid, result: String(error) }, 'parent-observer')
          throw error
        }
        io.stdout(control.action === 'restore-previous'
          ? `cutover ${control.cutoverId}: explicit restore-previous requested; watchdog ${watchdogPid} will stop only the proven target identity and relaunch the complete previous spec\n`
          : `cutover ${control.cutoverId}: abort requested; watchdog ${watchdogPid} will apply the pre-approved ${transaction.receipt.recovery.policy} policy\n`)
        return 0
      } catch (error) {
        io.stderr(`${command} failed: ${String(error)}\n`)
        return 1
      }
    }
    case 'cutover-event': {
      const id = positionals[0]
      const kind = positionals[1]
      if (id === undefined || kind === undefined) {
        io.stderr('cutover-event requires <id> <kind> [values...]\n')
        return 2
      }
      try {
        recordCutoverEvent(stateDir, id, kind, positionals.slice(2), Date.now())
        return 0
      } catch (error) {
        io.stderr(`cutover-event failed: ${String(error)}\n`)
        return 1
      }
    }
    case 'clear': {
      clearCredential(stateDir, Date.now())
      io.stdout('credential cleared\n')
      return 0
    }
    case 'checkpoint': {
      const message = options.message ?? 'batch snapshot'
      const changes = workingTreeChanges(repoDir)
      if (options.includeDirty && changes !== null && changes.length > 0) {
        io.stdout(`checkpoint includes ${changes.length} reviewed working-tree change(s)\n`)
      }
      const result = commitCheckpoint(
        repoDir, `dsh-ankh-guard checkpoint: ${message}`, SRC_ARTIFACT_PATTERN, options.includeDirty,
      )
      if (!result.ok) {
        io.stderr(`${result.error}\n`)
        return 1
      }
      setCheckpoint(stateDir, { revision: result.sha, message }, Date.now())
      io.stdout(result.createdCommit
        ? `checkpoint committed: ${result.sha}\n`
        : `checkpoint recorded at existing clean HEAD: ${result.sha}\n`)
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
      const verdict = verifyRepoCredential(stateDir, repoDir, options.maxAgeMinutes)
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
    case 'verify-restart': {
      if (restartMarkerState(stateDir) !== 'fresh') {
        io.stderr('restart authorization is missing or stale\n')
        return 1
      }
      const launch = readLaunchState(stateDir)
      if (launch === null) {
        io.stderr('restart authorization cannot be verified without durable launch state\n')
        return 1
      }
      const spec = selectedLaunchSpec(launch)
      const marker = readRestartRequestMarker(stateDir)
      const verdict = marker?.authorization === undefined
        ? verifyRepoCredential(stateDir, spec.credentialRepo, options.maxAgeMinutes)
        : verifyRestartAuthorization(stateDir, spec, marker.authorization)
      io.stdout(`${verdict.ok ? 'restart evidence PASS' : 'restart evidence FAIL'} — ${verdict.reason}\n`)
      return verdict.ok ? 0 : 1
    }
    case 'record-proven-deployment': {
      if (restartMarkerState(stateDir) !== 'fresh') {
        io.stderr('deployment proof refused: restart authorization is missing or stale\n')
        return 1
      }
      const launch = readLaunchState(stateDir)
      if (launch === null || launch.mode !== 'stable') {
        io.stderr('deployment proof refused: no stable durable launch specification is selected\n')
        return 1
      }
      const marker = readRestartRequestMarker(stateDir)
      let authorization = marker?.authorization
      if (authorization === undefined) {
        const state = loadState(stateDir)
        const credential = state.credential
        const fresh = verifyRepoCredential(stateDir, launch.active.credentialRepo, options.maxAgeMinutes)
        if (!fresh.ok || credential === undefined) {
          io.stderr(`deployment proof refused: ${fresh.reason}\n`)
          return 1
        }
        authorization = {
          version: 1,
          kind: 'fresh-credential',
          revision: credential.revision,
          evidenceSha256: commandSha256(credential.command),
        }
      }
      const result = proveCurrentDeployment(stateDir, launch.active, authorization)
      const sink = result.ok ? io.stdout : io.stderr
      sink(`${result.ok ? 'deployment proof PASS' : 'deployment proof FAIL'} — ${result.reason}\n`)
      return result.ok ? 0 : 1
    }
    case 'preflight': {
      const harnessRoot = resolveHarnessRoot(options.harnessRoot)
      let binding: LaunchPreflightSpec | undefined
      if (options.preflightSurface !== undefined || options.preflightInstallAnchor !== undefined
        || options.preflightRunner !== undefined) {
        try {
          binding = resolvePreflightSpec(options, 'standalone-preflight', harnessRoot, false)
        } catch (error) {
          io.stderr(`preflight refused: ${error instanceof Error ? error.message : String(error)}\n`)
          return 2
        }
      }
      const outcome = await runPreflightCheck(
        resolveProfileName(options),
        options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS,
        harnessRoot,
        undefined,
        binding,
      )
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
    case 'record-adoption': {
      // Invoked by the watchdog at the ADOPTION takeover — the first restart
      // a deployment ever sees (supervise handed it the port and a
      // pre-existing owner was stopped). The session that established
      // supervision promised a verification report; this record is what wakes
      // it after the bounce. Same pending protection as the unexpected-exit
      // record.
      const written = writeAdoptionRecord(stateDir, Date.now(), options.initiator)
      io.stdout(written
        ? '[watchdog] adoption takeover — left a report record for the supervising session\n'
        : '[watchdog] adoption takeover — a report record is still pending, left it untouched\n')
      return 0
    }
    case 'record-composition-recovery': {
      // Invoked by the watchdog when it recovered repeated boot failures by
      // restoring the last healthy profile composition (a freshly installed
      // plugin that kills the real boot is the common case). The service is
      // up again minus the newest plugin change — reported, never silent.
      const written = writeCompositionRecovery(stateDir, Date.now(), options.detail)
      io.stdout(written
        ? '[watchdog] composition rollback recovery — left a report record for the next session\n'
        : '[watchdog] composition rollback recovery — a report record is still pending, left it untouched\n')
      return 0
    }
    case 'check-env': {
      // THE one-call readiness answer for an agent planning a restart: (1) is
      // this instance supervised and by whom, (2) what command a restart
      // should use, (3) the bare-exit warning when unsupervised — plus the
      // sandbox verdict. An agent's FIRST hop; it must never need ps.
      const sandboxed = envInternals.sandboxedByProbe()
      io.stdout(`sandbox: ${sandboxed
        ? 'SANDBOXED — detached processes are reaped when the turn ends; ask the user for /permission danger-full-access in THIS session'
        : 'unsandboxed (full access)'}\n`)
      const watchdogPid = liveWatchdogPid(stateDir)
      if (watchdogPid !== null) {
        let chain = `supervised by ankh watchdog (pid ${watchdogPid})`
        if (existsSync(join(homedir(), 'Library', 'LaunchAgents', 'com.dsh.watchdog.plist'))) chain += '; the watchdog itself is supervised (launchd com.dsh.watchdog)'
        else {
          try {
            const units = execFileSync('systemctl', ['--user', 'list-unit-files', 'dsh-watchdog.service'], { encoding: 'utf8', stdio: 'pipe' })
            if (units.includes('dsh-watchdog.service')) chain += '; the watchdog itself is supervised (systemd dsh-watchdog.service)'
          } catch { /* no systemd on this host */ }
        }
        io.stdout(`supervision: ${chain}\n`)
      } else {
        io.stdout('supervision: NOT supervised — a bare exit leaves the service DOWN with nothing to respawn it; establish the watchdog with `supervise` first, or drive the restart with the `restart` verb (self-contained stop→start→canary)\n')
      }
      const launch = readInstanceLaunch(stateDir)
      const probePort = options.port ?? launch?.port
      let startLine: string
      if (launch !== null) {
        startLine = `${redactLaunchCommand(launch.command)}  (source: launch record${launch.supervised === true ? ', watchdog-supervised' : ''})`
      } else if (probePort !== undefined) {
        const pid = findPidOnPort(probePort)
        try {
          const discovered = pid === null ? null : discoverLaunchCommand(pid)
          startLine = discovered === null ? 'unknown — pass --start explicitly' : `${redactLaunchCommand(discovered)}  (source: live discovery from the port listener)`
        } catch (error) {
          startLine = `unknown — live discovery failed (${String(error)}); rerun escalated (sandbox_permissions) or pass --start explicitly`
        }
      } else {
        startLine = 'unknown — pass --start explicitly (no launch record yet; give --port for live discovery)'
      }
      io.stdout(`start: ${startLine}\n`)
      const skillReg = readSkillRegistration(stateDir)
      io.stdout(`skill: ${skillReg === null
        ? 'not recorded (the plugin has not booted with this state dir, or predates the record)'
        : skillReg.registered
          ? 'dsh-self-restart-guard registered in the skill catalog'
          : `NOT registered (${skillReg.reason ?? 'unknown reason'}) — the restart protocol will not surface in the skill catalog`}\n`)
      io.stdout(`git repo: ${currentHead(repoDir) !== null
        ? `yes (${repoDir})`
        : `no (${repoDir}) — git init + initial commit before record`}\n`)
      return sandboxed ? 1 : 0
    }
    case 'reconfigure': {
      if (options.start === undefined || options.start === '') {
        io.stderr(`reconfigure requires --start "CMD"\n\n${USAGE}`)
        return 2
      }
      if (options.onFailure === undefined) {
        io.stderr('reconfigure refused: --on-failure restore-previous|wait-for-user is required so recovery is explicitly approved before the old instance stops\n')
        return 2
      }
      const inFlightCutover = activeCutover(stateDir)
      if (inFlightCutover !== null) {
        return refuse('cutover-active', `reconfigure refused: launch cutover ${inFlightCutover.receipt.id} is still ${inFlightCutover.receipt.phase}; inspect it with \`launch-status\` and settle/retry that transaction first\n`)
      }
      const previous = resolvePreviousSpec(stateDir, io)
      if (previous === undefined) {
        return refuseQuiet('previous-spec', 'reconfigure refused: could not resolve the active launch specification (see stderr)', 2)
      }
      let target = launchSpec({
        command: options.start,
        port: options.port ?? previous.port,
        home: options.home !== '' ? options.home : previous.home,
        credentialRepo: options.repoDir !== '' ? repoDir : previous.credentialRepo,
        harnessRoot: options.harnessRoot !== '' ? options.harnessRoot : previous.harnessRoot,
        profile: options.profile !== undefined && options.profile !== '' ? options.profile : previous.profile,
      })
      try {
        target = { ...target, preflight: resolvePreflightSpec(options, target.command, target.harnessRoot, true) }
      } catch (error) {
        io.stderr(`reconfigure refused: ${error instanceof Error ? error.message : String(error)}\n`)
        return 2
      }
      if (target.port !== previous.port) {
        return refuse('port-mismatch', `reconfigure refused: online supervisor handoff keeps one authority and port (${previous.port}); target requested ${target.port}. Move ports as a separately supervised deployment, then cut traffic over.\n`, 2)
      }
      if (sameLaunchSpec(previous, target)) {
        return refuse('identical', 'reconfigure refused: target launch specification is identical to the active specification\n', 2)
      }
      let transitionPlan: TransitionPlan | undefined
      if (options.transitionFile !== undefined) {
        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(resolve(options.transitionFile), 'utf8')) as unknown
        } catch (error) {
          io.stderr(`reconfigure refused: transition plan is unreadable: ${String(error)}\n`)
          return 2
        }
        try {
          transitionPlan = validateTransitionPlan(raw, previous.home, stateDir)
          validateTransitionPlan(raw, target.home, stateDir)
        } catch (error) {
          io.stderr(`reconfigure refused: ${String(error)}\n`)
          return 2
        }
      }
      const previousSupervisorPid = liveWatchdogPid(stateDir)
      if (previousSupervisorPid === null) {
        return refuse('unsupervised', 'reconfigure refused: no live watchdog owns the old instance. Establish supervision first; an online handoff cannot promise continuity without an old supervisor.\n')
      }
      const gate = verifyRepoCredential(stateDir, target.credentialRepo, options.maxAgeMinutes)
      if (!gate.ok) {
        return refuse('credential', `reconfigure refused: ${gate.reason}\n`)
      }
      if (!sandboxGate('reconfigure', options, io)) {
        return refuseQuiet('sandbox', 'reconfigure refused: the environment is sandboxed, so the detached replacement supervisor would be reaped mid-flight')
      }
      const snapshotStartedAt = Date.now()
      let snapshot: { home: string; copiedFiles: number; copiedBytes: number; cleanup(): void }
      try {
        // The copy runs synchronously before any stop; without progress output
        // a multi-GB prepare looked exactly like a hang (2026-09-27: 848 s of
        // silence dragging the host checkout's node_modules into the snapshot).
        let lastProgressAt = 0
        const onProgress = (progress: SnapshotProgress): void => {
          const now = Date.now()
          if (now - lastProgressAt < 2000) return
          lastProgressAt = now
          io.stdout(`preflight snapshot: ${progress.files} files / ${Math.round(progress.bytes / 1024 / 1024)} MB copied…\n`)
        }
        snapshot = transitionPlan === undefined
          ? createPreflightSnapshot(target.home, { onProgress })
          : createTransitionPreflightSnapshot(transitionPlan, { onProgress })
      } catch (error) {
        return refuse('preflight-snapshot', `reconfigure refused: could not prepare an isolated${transitionPlan === undefined ? '' : ' transitioned'} home: ${String(error)}\n`)
      }
      // A large home copy eats the credential's freshness window: the post-boot
      // canary revalidates the same credential, so a slow prepare can expire it
      // mid-cutover and force a restore (observed with a 24 GB scratch tree).
      // The snapshot copies only the composition's boot inputs
      // (SNAPSHOT_INCLUDED_TOP_LEVEL), so size tracks the host's boot surface —
      // warn when it still comes in slow.
      const snapshotMs = Date.now() - snapshotStartedAt
      io.stdout(`isolated home snapshot ready: ${snapshot.copiedFiles} files / ${Math.round(snapshot.copiedBytes / 1024 / 1024)} MB in ${Math.round(snapshotMs / 1000)}s\n`)
      if (snapshotMs > options.maxAgeMinutes * 60_000 / 2) {
        io.stdout(`note: the isolated-home snapshot took ${Math.round(snapshotMs / 1000)}s — over half the ${options.maxAgeMinutes}min credential window; re-record the credential immediately before reconfigure\n`)
      }
      try {
        const timeout = options.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS
        if (!(await candidateProbeGate(target, timeout, io, snapshot.home))) {
          return refuseQuiet('preflight', 'reconfigure refused: the candidate probe failed (see stderr)')
        }
        if (!(await preflightGate(
          'reconfigure', target.profile, timeout,
          io, target.harnessRoot, snapshot.home, target.preflight,
        ))) {
          return refuseQuiet('preflight', 'reconfigure refused: the composition preflight failed (see stderr for the failing entries)')
        }
        io.stdout(`${transitionPlan === undefined ? 'candidate' : 'filesystem transition'} preflight PASS on an isolated copy of the live home\n`)
      } finally {
        snapshot.cleanup()
      }

      const lock = acquireRestartLock(stateDir)
      if (!lock.ok) {
        return refuse('lock', `reconfigure refused: a restart is in flight (pid ${lock.holder})\n`)
      }
      const cutoverId = `${Date.now()}-${process.pid}`
      let driverPid: number | undefined
      try {
        if (restartMarkerState(stateDir) === 'fresh') {
          return refuse('marker', 'reconfigure refused: a scheduled exit is already pending\n')
        }
        const initiator = resolveInitiator(options.initiator, io)
        const previousSupervisor = processIdentity(previousSupervisorPid)
        if (previousSupervisor === null) {
          throw new Error(`could not capture a start identity for watchdog ${previousSupervisorPid}`)
        }
        const previousOwned = findOwnedListener(previous.port, previousSupervisorPid)
        if (previousOwned === null) {
          throw new Error(`the listener on :${previous.port} is not uniquely owned by watchdog ${previousSupervisorPid}; refusing a port-inferred takeover`)
        }
        if (!processIdentityMatches(previousSupervisor)) {
          throw new Error(`watchdog ${previousSupervisorPid} changed while ownership was captured; refusing a recycled-PID takeover`)
        }
        const transition = transitionPlan === undefined
          ? undefined
          : prepareTransition(transitionPlan, previous.home, stateDir, cutoverId)
        prepareLaunchCutover(stateDir, {
          id: cutoverId,
          previous,
          target,
          recoveryPolicy: options.onFailure,
          browserHandoff: options.browserHandoff,
          previousSupervisorPid,
          previousSupervisorStartToken: previousSupervisor.startToken,
          previousOwnership: {
            childPid: previousOwned.child.pid,
            childStartToken: previousOwned.child.startToken,
            listenerPid: previousOwned.listener.pid,
            listenerStartToken: previousOwned.listener.startToken,
          },
          ...(transition === undefined ? {} : { transition }),
          ...(initiator !== undefined ? { initiator } : {}),
          now: Date.now(),
        })
        // A detached foreground-supervise DRIVER keeps the new watchdog as its
        // child after the old host exits. The watchdog first replaces the
        // pidfile claim; the old watchdog's existing yield rule then exits
        // without reaping its child. Only after that claim is observed do we
        // schedule the child exit below.
        const logPath = options.log ?? stateFile(stateDir, 'watchdogLog')
        mkdirSync(dirname(logPath), { recursive: true })
        const driverArgs = [
          'supervise', '--foreground', '--state-dir', stateDir,
          '--takeover-from', String(previousSupervisorPid), '--cutover-id', cutoverId,
          '--delay-ms', String(options.delayMs ?? 5000),
          '--supervisor-yield-timeout-ms', String(options.supervisorYieldTimeoutMs ?? 15_000),
          // The successor watchdog's readiness budget rides the driver argv;
          // the durable spec stays free of per-restart tuning.
          ...(options.bootTimeoutMs !== undefined ? ['--boot-timeout-ms', String(options.bootTimeoutMs)] : []),
          ...(initiator !== undefined ? ['--initiator', initiator] : []),
        ]
        const cutoverDriverEnv: NodeJS.ProcessEnv = { ...process.env }
        // Same verdict-file hygiene as the restart driver: the caller-side
        // verdict is the caller's; this long-lived driver must not rewrite it.
        delete cutoverDriverEnv.DSH_ANKH_VERDICT_FILE
        const driver = spawn(process.execPath, cliInvocation(driverArgs), {
          detached: true,
          stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
          env: testChildEnv('cutover-supervisor-driver', cutoverDriverEnv, { port: previous.port, tempRoot: stateDir }),
        })
        registerSpawnedTestProcess(driver, 'cutover-supervisor-driver', { port: previous.port, tempRoot: stateDir })
        driver.unref()
        driverPid = driver.pid
        if (driverPid === undefined) throw new Error('could not detach the replacement supervisor driver')

        const takeoverDeadline = Date.now() + 15_000
        let replacementPid: number | undefined
        while (Date.now() < takeoverDeadline) {
          const receipt = readCutoverReceipt(stateDir)
          const candidate = receipt?.supervisor.targetPid
          const candidateStartToken = receipt?.supervisor.targetStartToken
          if (candidate !== undefined && candidateStartToken !== undefined
            && processIdentityMatches({ pid: candidate, startToken: candidateStartToken })
            && livePidIn(stateFile(stateDir, 'watchdogPid')) === String(candidate)) {
            replacementPid = candidate
            break
          }
          // Both proofs are required: the pidfile is the ownership commit,
          // and the receipt binds that PID to its start identity. Never fall
          // back to accepting an arbitrary new live pidfile owner.
          try { process.kill(driverPid, 0) } catch { break }
          await sleep(100)
        }
        if (replacementPid === undefined) throw new Error('replacement watchdog did not claim supervision within 15000 ms')
        io.stdout(`launch cutover ${cutoverId} prepared: supervisor ${previousSupervisorPid} → ${replacementPid}; the replacement watchdog stops the old child in ${options.delayMs ?? 5000} ms\nreceipt: ${stateFile(stateDir, 'launchCutover')}\n`)
        return 0
      } catch (error) {
        if (driverPid !== undefined) {
          try { process.kill(-driverPid, 'SIGTERM') } catch { try { process.kill(driverPid, 'SIGTERM') } catch { /* already gone */ } }
          // Let the driver's watchdog finish cleanup before writing the
          // terminal preparation failure. Two atomic read-modify-write events
          // racing here could otherwise resurrect a nonterminal receipt.
          await waitForExit(driverPid, 2_000)
        }
        try { recordCutoverEvent(stateDir, cutoverId, 'prepare-failed', [String(error)], Date.now()) } catch { /* preparation may have failed before the receipt */ }
        return refuse('preparation', `reconfigure refused before stopping the old instance: ${String(error)}\n`)
      } finally {
        lock.release()
      }
    }
    case 'restart': {
      const port = options.port ?? readInstanceLaunch(stateDir)?.port
      if (port === undefined) {
        io.stderr(`restart requires --port N and --start "CMD"\n\n${USAGE}`)
        return 2
      }
      const start = resolveStartCommand(options.start, stateDir, 'restart', io, port)
      if (start === undefined) {
        return 2
      }
      const restartCutover = activeCutover(stateDir)
      if (restartCutover !== null) {
        return refuse('cutover-active', `restart refused: launch cutover ${restartCutover.receipt.id} is ${restartCutover.receipt.phase}; a second stop would violate its recovery policy\n`)
      }
      const isDriver = process.env.DSH_ANKH_RESTART_DRIVER === '1'
      // THE GATE: never stop an instance on a denial.
      const gate = verifyRepoCredential(stateDir, repoDir, options.maxAgeMinutes)
      if (!gate.ok) {
        return refuse('credential', `restart refused: ${gate.reason}\n`)
      }
      // THE ENVIRONMENT GATE: a sandboxed turn reaps the detached restart
      // mid-flight — refuse before anything is stopped.
      if (!sandboxGate('restart', options, io)) {
        return refuseQuiet('sandbox', 'restart refused: the environment is sandboxed, so the detached restart driver would be reaped mid-flight')
      }
      // THE COMPOSITION GATE (caller side only — the detached driver inherits
      // a composition the caller already proved; re-running it would double a
      // minute-long dry-run). A green build does not prove the profile boots.
      if (!isDriver && !(await preflightGate('restart', resolveProfileName(options), options.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS, io, preflightHarnessRoot(options, stateDir)))) {
        return refuseQuiet('preflight', 'restart refused: the composition preflight failed (see stderr for the failing entries)')
      }
      // See every other pending stop before becoming one: a scheduled exit's
      // agent would SIGTERM the instance this restart starts.
      if (restartMarkerState(stateDir) === 'fresh') {
        return refuse('marker', 'restart refused: a scheduled exit is still pending (restart-requested.json) — its exit agent would kill the instance this restart starts; wait for it or remove the stale marker\n')
      }
      if (options.sync !== true && !isDriver) {
        // SELF-DETACH: the stop→start→canary half must outlive the caller. A
        // restart CLI inside the instance's managed process tree dies with it
        // (teardown kills managed processes between "old stopped" and "new
        // started" — observed on fresh machines); a setsid'd driver, like the
        // exit agent and the watchdog, provably survives.
        const logPath = options.log ?? stateFile(stateDir, 'restartLog')
        mkdirSync(dirname(logPath), { recursive: true })
        const restartDriverEnv: NodeJS.ProcessEnv = { ...process.env, DSH_ANKH_RESTART_DRIVER: '1' }
        // The caller-side verdict belongs to the caller: a later driver-side
        // refusal must not overwrite it after the caller already returned.
        delete restartDriverEnv.DSH_ANKH_VERDICT_FILE
        const driver = spawn(process.execPath, cliInvocation(argv), {
          detached: true,
          stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
          env: testChildEnv('restart-driver', restartDriverEnv, { port, tempRoot: stateDir }),
        })
        registerSpawnedTestProcess(driver, 'restart-driver', { port, tempRoot: stateDir })
        driver.unref()
        if (driver.pid === undefined) {
          return refuse('spawn', 'restart refused: could not detach the restart driver\n')
        }
        // ONE restart at a time across sessions: the lock names the DRIVER
        // (it outlives this caller by design); a live holder refuses.
        const lock = acquireRestartLock(stateDir, driver.pid)
        if (!lock.ok) {
          try { process.kill(driver.pid, 'SIGKILL') } catch { /* already gone */ }
          return refuse('lock', /^\d+$/.test(lock.holder)
            ? `restart refused: another restart is already in flight (pid ${lock.holder})\n`
            : `restart refused: cannot claim the restart lock (${lock.holder}) — remove ${stateFile(stateDir, 'restartLock')} if it is stale\n`)
        }
        io.stdout(`restart driver detached (pid ${driver.pid}) — log ${logPath}\nthe instance stops in ${options.delayMs ?? 0} ms and comes back on its own; check the log or \`status\` afterwards\n`)
        return 0
      }
      // Driver / --sync path. The lock covers the WHOLE verb, rollback
      // included; try/finally so no return path or exception can strand it.
      // The driver releases only a lock that names it; --sync acquires here.
      let restartLock: { release(): void } | undefined
      if (options.sync === true) {
        const lock = acquireRestartLock(stateDir)
        if (!lock.ok) {
          refuse('lock', /^\d+$/.test(lock.holder)
            ? `restart refused: another restart is already in flight (pid ${lock.holder})\n`
            : `restart refused: cannot claim the restart lock (${lock.holder}) — remove ${stateFile(stateDir, 'restartLock')} if it is stale\n`)
          return 1
        }
        restartLock = lock
      }
      try {
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
        // Graceful-exit deadline before the SIGKILL escalation: large sessions
        // flushing out tens of thousands of log tokens can take longer than
        // the old hardcoded 10 s. Configurable via --stop-timeout-ms.
        const stopTimeoutMs = options.stopTimeoutMs ?? 30_000
        const exited = await waitForExit(pidNumber, stopTimeoutMs, () => {
          // This line lives in the CLI's stdout; the watchdog's own log carries
          // the matching `Killed: 9` for the same pid — the two align on pid.
          io.stdout(`pid ${pid} did not exit within ${stopTimeoutMs} ms of SIGTERM — sending SIGKILL (the watchdog log will show 'Killed: 9' for ${pid})\n`)
        })
        io.stdout(`stopped ${pid}${exited ? '' : ' (forced)'}\n`)
        const stoppedAt = Date.now()
        // The new instance must not inherit this caller's supervision
        // variables: a restart driven from inside a supervised instance's
        // agent session carries that instance's WD_* (the watchdog spawns
        // the instance with its own environment), and forwarding them leaks
        // them into the new instance's shells — a leaked WD_STATE_DIR
        // retargets any watchdog script those shells spawn. The watchdog's
        // own launch_instance applies the same scrub.
        const startEnv = { ...process.env }
        delete startEnv.DSH_ANKH_RESTART_DRIVER
        for (const key of Object.keys(startEnv)) {
          if (key.startsWith('WD_')) delete startEnv[key]
        }
        const child = spawn(start, {
          shell: true, detached: true, stdio: 'ignore',
          env: testChildEnv('restart-instance-root', startEnv, { port, tempRoot: stateDir }),
        })
        registerSpawnedTestProcess(child, 'restart-instance-root', { port, tempRoot: stateDir })
        child.unref()
        io.stdout(`started: ${start}\n`)
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
        // The restart verb must not be invisible to the report machinery:
        // record the outcome (the exit agent's semantics) so the next boot's
        // pendingRestartRecord delivers the report to its initiator.
        const initiator = resolveInitiator(options.initiator, io)
        if (!listening) {
          io.stderr(`new instance not listening on 127.0.0.1:${port} within ${timeoutMs}ms\n`)
          writeRestartOutcome(stateDir, { exitAt: stoppedAt, pid: pidNumber, error: `new instance not listening on :${port}`, ...(initiator !== undefined ? { initiator } : {}) })
          if (options.rollback) rollbackToKnownGood(stateDir, repoDir, io)
          return 1
        }
        const post = verifyRepoCredential(stateDir, repoDir, options.maxAgeMinutes)
        io.stdout(`canary verify: ${post.ok ? 'PASS' : 'FAIL'} — ${post.reason}\n`)
        io.stdout(`canary port: PASS — listening on 127.0.0.1:${port}\n`)
        if (!post.ok) {
          writeRestartOutcome(stateDir, { exitAt: stoppedAt, pid: pidNumber, error: `canary failed: ${post.reason}`, ...(initiator !== undefined ? { initiator } : {}) })
          if (options.rollback) rollbackToKnownGood(stateDir, repoDir, io)
          return 1
        }
        writeRestartOutcome(stateDir, { exitAt: stoppedAt, pid: pidNumber, ...(initiator !== undefined ? { initiator } : {}) })
        io.stdout('restart + canary PASS\n')
        return 0
      } finally {
        if (restartLock !== undefined) restartLock.release()
        else releaseRestartLock(stateDir)
      }
    }
    case 'supervise': {
      let spec = resolveSuperviseSpec(options, stateDir, repoDir, io)
      if (spec === undefined) return 2
      // An OS supervisor restarting after the replacement watchdog itself
      // crashes must resume the durable transaction. Treating that start as
      // ordinary would compact selected target into stable and discard the
      // pre-approved recovery contract.
      let transaction = activeCutover(stateDir)
      if (options.cutoverId !== undefined && (transaction === null || transaction.receipt.id !== options.cutoverId)) {
        io.stderr(`supervise refused: cutover ${options.cutoverId} is not the selected launch transaction\n`)
        return 1
      }
      // A receipt parked in awaiting-user must never auto-boot the rejected
      // side — but exiting here leaves NO live consumer for the operator
      // control markers, and abort-cutover/restore-previous then refuse with
      // "no live watchdog" (the 2026-09-30 mid-cutover wedge). Hold instead:
      // spawn the watchdog in its parked mode, which claims the pidfile and
      // consumes those markers without launching anything.
      let parkedCutover = false
      if (options.cutoverId === undefined && transaction?.receipt.phase === 'awaiting-user') {
        parkedCutover = true
      }
      // An explicit --cutover-id resume against a live PARKED holder: the
      // driver-started event below flips the receipt out of awaiting-user,
      // which is the hold's release signal. Remember the entry phase so the
      // pidfile branch below knows the live owner is expected to let go.
      const resumeFromAwaitingUser = options.cutoverId !== undefined && transaction?.receipt.phase === 'awaiting-user'
      // A detached watchdog spawned from a sandboxed turn is reaped with it —
      // refuse before claiming anything. Foreground mode is driven by the
      // external supervisor (launchd/systemd) and stays exempt.
      if (options.foreground !== true && !sandboxGate('supervise', options, io)) return 2
      if (options.cutoverId !== undefined) {
        try {
          // The driver records itself before spawning the watchdog. Every
          // later receipt update then comes from this ordered process tree;
          // the reconfigure caller only observes the pidfile handoff.
          const driverIdentity = processIdentity(process.pid)
          if (driverIdentity === null) throw new Error(`could not capture driver ${process.pid} start identity`)
          recordCutoverEvent(stateDir, options.cutoverId, 'driver-started', [String(process.pid), driverIdentity.startToken], Date.now())
        } catch (error) {
          io.stderr(`supervise refused: could not persist cutover driver PID: ${String(error)}\n`)
          return 1
        }
      }
      // One state directory owns every marker and the pidfile; the plugin,
      // this CLI, and the watchdog must agree on it. Deriving a home from
      // stateDir and re-appending 'state' breaks whenever stateDir is not
      // literally '$DSH_HOME/state' (an explicit --state-dir, or the
      // '<cwd>/.dsh-guard-state' fallback): the CLI would write '<cwd>/state'
      // while the plugin reads '<cwd>/.dsh-guard-state'.
      const pidfile = stateFile(stateDir, 'watchdogPid')
      let waitedForWatchdog = false
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
            if (options.takeoverFrom !== undefined) {
              if (existingPid !== options.takeoverFrom) {
                io.stderr(`supervise takeover refused: expected watchdog ${options.takeoverFrom}, but pidfile names live ${existingPid}\n`)
                return 1
              }
              // Continue: the new watchdog performs an atomic pidfile replace.
            } else {
              const durable = readLaunchState(stateDir)
              if (options.start !== undefined && durable !== null && !sameLaunchSpec(spec, selectedLaunchSpec(durable))) {
                io.stderr('supervise refused: a live watchdog owns a different launch specification; use `reconfigure --on-failure ...` so the supervisor and full config move transactionally\n')
                return 1
              }
              if (durable === null) writeStableLaunchSpec(stateDir, spec)
              if (resumeFromAwaitingUser) {
                // The live owner is the awaiting-user hold (or a wrapper still
                // parked on its crash page). The hold releases its claim as
                // soon as the driver-started event above flips the receipt out
                // of awaiting-user — wait for that release, bounded: an owner
                // that keeps the claim is not the hold, and waiting behind it
                // forever would wedge the explicit resume it never sees.
                const existingIdentity = processIdentity(existingPid)
                if (existingIdentity === null) {
                  io.stderr(`supervise refused: could not capture watchdog ${existingPid} start identity before waiting\n`)
                  return 1
                }
                io.stdout(`watchdog ${existing} holds the parked cutover — waiting for it to release, then resuming\n`)
                const releaseDeadline = Date.now() + 15_000
                while (processIdentityMatches(existingIdentity) && Date.now() < releaseDeadline) await sleep(250)
                if (processIdentityMatches(existingIdentity)) {
                  io.stderr(`supervise refused: watchdog ${existingPid} did not release the parked cutover ${options.cutoverId ?? ''} within 15000 ms — it is not the awaiting-user hold; settle the transaction with \`abort-cutover --state-dir ${stateDir}\` or \`restore-previous --state-dir ${stateDir}\`, or stop that watchdog and retry\n`)
                  return 1
                }
                waitedForWatchdog = true
                io.stdout(`watchdog ${existing} released the parked cutover — resuming\n`)
              } else if (options.foreground) {
              // Foreground = an external supervisor (launchd KeepAlive) runs
              // THIS process. Exiting 0 here would read as an intentional stop
              // under `KeepAlive SuccessfulExit: false`, so the job would go
              // idle and never restart the CLI — silently leaving the OTHER
              // watchdog unsupervised, i.e. a quiet regression to the
              // single-point-of-failure shape. Instead, wait for it to exit
              // and then take over: the chain (supervisor → this CLI →
              // watchdog) stays intact the whole time.
                io.stdout(`watchdog ${existing} already supervises the port — waiting for it to exit, then taking over (foreground)\n`)
              const existingIdentity = processIdentity(existingPid)
              if (existingIdentity === null) {
                io.stderr(`supervise refused: could not capture watchdog ${existingPid} start identity before waiting\n`)
                return 1
              }
              while (processIdentityMatches(existingIdentity)) await sleep(1000)
              waitedForWatchdog = true
              io.stdout(`watchdog ${existing} exited — taking over\n`)
            } else {
              io.stdout(`already supervised by pid ${existing}\n`)
              return 0
            }
            }
          }
        }
      }
      if (waitedForWatchdog) {
        // The successor can settle the cutover while this launchd/systemd
        // process waits. Its pre-wait target snapshot is stale at that point:
        // reread both the atomically selected spec and receipt before spawning
        // anything, and ignore installer-time flags when durable state exists.
        const refreshed = resolveSuperviseSpec(options, stateDir, repoDir, io, true)
        if (refreshed === undefined) return 2
        spec = refreshed
        transaction = activeCutover(stateDir)
        if (options.cutoverId !== undefined && (transaction === null || transaction.receipt.id !== options.cutoverId)) {
          io.stderr(`supervise refused after wait: cutover ${options.cutoverId} is no longer the selected launch transaction\n`)
          return 1
        }
        if (options.cutoverId === undefined && transaction?.receipt.phase === 'awaiting-user') {
          // Settled into awaiting-user while this supervisor waited behind the
          // old owner: park exactly like the entry check above instead of
          // booting the rejected target — or exiting and leaving no consumer.
          parkedCutover = true
        }
        io.stdout('launch state refreshed after wait — using the durable selected specification\n')
      }
      const previousOwnership = transaction?.receipt.ownership?.previous
      if (transaction !== null && (previousOwnership === undefined
        || !Number.isInteger(previousOwnership.childPid) || previousOwnership.childPid <= 0
        || !Number.isInteger(previousOwnership.listenerPid) || previousOwnership.listenerPid <= 0
        || previousOwnership.childStartToken === '' || previousOwnership.listenerStartToken === '')) {
        io.stderr(`supervise refused: active cutover ${transaction.receipt.id} predates authoritative child/listener ownership evidence; refusing to infer or kill a process by port. Keep the existing host untouched and settle the transaction explicitly.\n`)
        return 1
      }
      const previousSupervisorStart = transaction?.receipt.supervisor?.previousStartToken
      if (transaction !== null && (previousSupervisorStart === undefined || previousSupervisorStart === '')) {
        io.stderr(`supervise refused: active cutover ${transaction.receipt.id} predates supervisor start identity evidence; refusing a PID-only takeover. Keep the existing host untouched and settle the transaction explicitly.\n`)
        return 1
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
      if (transaction === null) {
        writeStableLaunchSpec(stateDir, spec)
        // The supervisor's record is authoritative: the FULL chain (watchdog
        // + launch wrapper), not the inner argv the instance self-records.
        writeInstanceLaunchAsSupervisor(stateDir, {
          command: spec.command, source: 'supervisor', supervised: true, port: spec.port, recordedAt: Date.now(),
        })
      }
      // A caller may itself live inside (or debug) another supervisor. Only
      // the values resolved above may configure this watchdog; ambient WD_*
      // must not turn an ordinary spawn into a takeover or point it at a
      // foreign state directory.
      const supervisorBaseEnv = { ...process.env }
      // A caller-side verdict file belongs to that caller, not to the
      // long-lived watchdog this spawn becomes.
      delete supervisorBaseEnv.DSH_ANKH_VERDICT_FILE
      for (const key of Object.keys(supervisorBaseEnv)) {
        if (key.startsWith('WD_')) delete supervisorBaseEnv[key]
      }
      const env = {
        ...supervisorBaseEnv,
        WD_PORT: String(spec.port),
        WD_HOME: spec.home,
        WD_STATE_DIR: stateDir,
        WD_REPO: spec.credentialRepo,
        WD_HARNESS_ROOT: spec.harnessRoot,
        WD_START: spec.command,
        // Let the instance mark its own launch record as supervised (the
        // watchdog passes its env to the instance it spawns).
        DSH_ANKH_SUPERVISED: '1',
        // The session establishing supervision: the watchdog's adoption
        // takeover reports back to it (record-adoption). Empty for
        // human-driven supervise runs — the record then waits for the first
        // root agent created.
        WD_INITIATOR: options.initiator ?? process.env.DSH_SESSION_ID ?? '',
        // Adoption vs first-ever boot, decided HERE — race-free: by the time
        // a spawned watchdog would probe the port, the owner may already be
        // gone.
        WD_ADOPTION: transaction === null && findPidOnPort(spec.port) !== null ? '1' : '0',
        // The profile whose composition inputs the watchdog snapshots at
        // healthy boots (and restores on out-of-repo boot failures).
        WD_PROFILE: spec.profile,
        // Foreground (launchd-supervised) mode: the watchdog owns the port by
        // adoption; the detached form waits for the current owner to exit.
        WD_WAIT_OWNER: options.takeoverFrom !== undefined || !options.foreground ? '1' : '0',
        WD_GUARD: guardInvocation(),
        // One boot's readiness budget, in the wrapper's whole-seconds unit.
        // Ceiling: never round a requested budget DOWN into a tighter window.
        ...(options.bootTimeoutMs !== undefined
          ? { WD_BOOT_TIMEOUT: String(Math.ceil(options.bootTimeoutMs / 1000)) }
          : {}),
        ...(options.takeoverFrom !== undefined ? {
          WD_TAKEOVER_FROM: String(options.takeoverFrom),
          WD_TAKEOVER_FROM_START: previousSupervisorStart ?? '',
        } : {}),
        ...(transaction !== null && previousOwnership !== undefined ? {
          WD_CUTOVER_ID: transaction.receipt.id,
          WD_CUTOVER_ROLE: transaction.state.selected,
          WD_CUTOVER_POLICY: transaction.receipt.recovery.policy,
          WD_BROWSER_HANDOFF: transaction.receipt.authentication.browserHandoff === 'off' ? 'off' : 'required',
          WD_CUTOVER_DELAY_SECONDS: String((options.delayMs ?? 5000) / 1000),
          WD_SUPERVISOR_YIELD_TIMEOUT_MS: String(options.supervisorYieldTimeoutMs ?? 15_000),
          WD_PREVIOUS_START: transaction.state.previous.command,
          WD_PREVIOUS_HOME: transaction.state.previous.home,
          WD_PREVIOUS_REPO: transaction.state.previous.credentialRepo,
          WD_PREVIOUS_HARNESS_ROOT: transaction.state.previous.harnessRoot,
          WD_PREVIOUS_PROFILE: transaction.state.previous.profile,
          WD_PREVIOUS_CHILD_PID: String(previousOwnership.childPid),
          WD_PREVIOUS_CHILD_START: previousOwnership.childStartToken,
          WD_PREVIOUS_LISTENER_PID: String(previousOwnership.listenerPid),
          WD_PREVIOUS_LISTENER_START: previousOwnership.listenerStartToken,
          // Parked hold: claim supervision and consume operator control
          // markers, but never launch — the receipt's selected side was
          // explicitly rejected and waits for a user decision.
          ...(parkedCutover ? { WD_CUTOVER_PARKED: '1' } : {}),
          ...(transaction.state.transition === undefined ? {} : {
            WD_TRANSITION_PLAN_SHA256: transaction.state.transition.planSha256,
          }),
        } : {}),
      }
      if (parkedCutover && transaction !== null) {
        io.stdout(`supervise: cutover ${transaction.receipt.id} is waiting for user action — holding the supervision claim WITHOUT launching the rejected ${transaction.state.selected} side (receipt ${stateFile(stateDir, 'launchCutover')}). The operator verbs now have a live consumer: \`abort-cutover --state-dir ${stateDir}\` applies the pre-approved ${transaction.receipt.recovery.policy} policy, \`restore-previous --state-dir ${stateDir}\` restores the complete previous spec. To end the hold without settling: write the stop marker (\`touch ${stateFile(stateDir, 'watchdogStop')}\`). To resume the rejected side: \`supervise --cutover-id ${transaction.receipt.id} --state-dir ${stateDir}\`\n`)
      }
      if (options.foreground) {
        // Run the watchdog inline: the CLI process stays alive as the
        // watchdog's parent, so an external supervisor (launchd KeepAlive)
        // supervises the watchdog, which supervises the instance. The CLI
        // exits with the watchdog so a dead watchdog triggers a restart.
        const child = spawn('bash', [watchdog, '--supervise'], {
          stdio: 'inherit',
          env: testChildEnv('watchdog-foreground', env, { port: spec.port, tempRoot: stateDir }),
        })
        registerSpawnedTestProcess(child, 'watchdog-foreground', { port: spec.port, tempRoot: stateDir })
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
        env: testChildEnv('watchdog-detached', env, { port: spec.port, tempRoot: stateDir }),
      })
      registerSpawnedTestProcess(child, 'watchdog-detached', { port: spec.port, tempRoot: stateDir })
      let spawnError: Error | undefined
      child.once('error', (error) => { spawnError = error })
      child.unref()
      const spawnedPid = child.pid
      if (spawnedPid === undefined) {
        io.stderr('supervise refused: watchdog process has no pid\n')
        return 1
      }
      // Returning before the pidfile claim creates a dangerous API race: an
      // immediate schedule-exit sees no owner. Wait until the detached child
      // has durably claimed supervision (or failed) before reporting success.
      const claimDeadline = Date.now() + 5_000
      while (Date.now() < claimDeadline && spawnError === undefined) {
        if (liveWatchdogPid(stateDir) === spawnedPid) {
          io.stdout(parkedCutover && transaction !== null
            ? `watchdog spawned and parked on cutover ${transaction.receipt.id} (pid ${spawnedPid}) — nothing launched; consuming abort-cutover/restore-previous markers; log ${logPath}\n`
            : `watchdog spawned and ready (pid ${spawnedPid}) — supervises :${spec.port}, log ${logPath}\n`)
          return 0
        }
        try { process.kill(spawnedPid, 0) } catch { break }
        await sleep(50)
      }
      try { process.kill(-spawnedPid, 'SIGTERM') } catch { try { process.kill(spawnedPid, 'SIGTERM') } catch { /* already gone */ } }
      io.stderr(`supervise refused: watchdog ${spawnedPid} did not claim ${pidfile} within 5000 ms${
        spawnError === undefined ? '' : ` (${String(spawnError)})`
      }; inspect ${logPath}\n`)
      return 1
    }
    case 'schedule-exit': {
      const delayMs = options.delayMs
      if (delayMs === undefined) {
        io.stderr(`schedule-exit requires --delay-ms MS (and --port N before durable launch configuration exists)\n\n${USAGE}`)
        return 2
      }
      const scheduledCutover = activeCutover(stateDir)
      if (scheduledCutover !== null) {
        io.stderr(`schedule-exit refused: launch cutover ${scheduledCutover.receipt.id} is ${scheduledCutover.receipt.phase}; let that transaction settle before scheduling another stop\n`)
        return 1
      }
      const durableSpec = stableScheduleSpec(options, stateDir, repoDir, io)
      if (durableSpec === undefined) return 1
      const port = durableSpec?.port ?? options.port ?? readInstanceLaunch(stateDir)?.port
      if (port === undefined) {
        io.stderr(`schedule-exit requires --port N before a durable launch specification exists\n\n${USAGE}`)
        return 2
      }
      const credentialRepo = durableSpec?.credentialRepo ?? repoDir
      const profile = durableSpec?.profile ?? resolveProfileName(options)
      const harnessRoot = durableSpec?.harnessRoot ?? preflightHarnessRoot(options, stateDir)
      // Killing the child without an owner that will respawn it is never a
      // degraded restart: it is a guaranteed outage. Refuse before running
      // the expensive composition gate or writing any restart marker.
      if (liveWatchdogPid(stateDir) === null) {
        io.stderr(`schedule-exit refused: no live watchdog owns the instance on :${port}; establish supervision first. A scheduled exit here would leave the service down.\n`)
        return 1
      }
      // THE GATE: never schedule an exit on a denial.
      // A same-launch restart may reuse an exact deployment proof written
      // only after a previous readiness + canary success. Fresh credentials
      // remain the first choice; all launch/profile/runtime drift fails closed.
      const gate: RestartEvidenceResult = durableSpec === null
        ? verifyRepoCredential(stateDir, credentialRepo, options.maxAgeMinutes)
        : verifyRestartEvidence(stateDir, durableSpec, options.maxAgeMinutes)
      if (!gate.ok) {
        io.stderr(`schedule-exit refused: ${gate.reason}\n`)
        return 1
      }
      io.stdout(`restart evidence PASS — ${gate.reason}\n`)
      // THE ENVIRONMENT GATE: the detached exit agent must outlive this turn.
      if (!sandboxGate('schedule-exit', options, io)) return 1
      // THE COMPOSITION GATE: a green build does not prove the profile boots.
      if (!(await preflightGate(
        'schedule-exit', profile, options.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS, io, harnessRoot,
        durableSpec?.home, durableSpec?.preflight,
      ))) {
        return 1
      }
      // One scheduled restart at a time, and never while a restart is in
      // flight. Both checks must hold ATOMICALLY with writing the marker and
      // spawning the exit agent: an earlier version checked without holding
      // the lock, and the narrow read→write window let a concurrent restart
      // pass its own checks in between — the scheduled exit agent then
      // SIGTERMed the instance that restart had just started. Taking the
      // restart lock here serializes the two verbs on the same primitive
      // (restart's own marker check stays: it guards against an exit agent
      // scheduled BEFORE its acquisition, already past this window).
      const lock = acquireRestartLock(stateDir)
      if (!lock.ok) {
        io.stderr(`schedule-exit refused: a restart is in flight (pid ${lock.holder}) — the exit agent would kill the instance it is starting\n`)
        return 1
      }
      try {
        // The marker carries a single initiator, so overwriting a FRESH one
        // would silently reassign the pending report. A marker past the TTL
        // is stale (the watchdog died mid-flow without clearing it) —
        // overwrite with a warning instead of refusing forever.
        const markerFile = stateFile(stateDir, 'restartRequested')
        const markerState = restartMarkerState(stateDir)
        if (markerState === 'fresh') {
          io.stderr('schedule-exit refused: a restart is already scheduled (restart-requested.json still pending); a stale marker expires on its own after 15 minutes\n')
          return 1
        }
        if (markerState === 'stale' && existsSync(markerFile)) {
          io.stderr('warning: overwriting a stale restart marker (a previous schedule never completed)\n')
        }
        // Intentional-restart marker: the supervising watchdog runs the canary
        // after the respawn and clears this on pass. The initiator (the session
        // that requested the exit) rides along so the restart report can return
        // to that session instead of racing to whichever root agent resumes
        // first. Everything lands in stateDir directly — the same directory the
        // plugin reads (see the supervise case for why no home is derived).
        const initiator = resolveInitiator(options.initiator, io)
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(stateFile(stateDir, 'restartRequested'),
          `${JSON.stringify({
            reason: 'scheduled self-restart',
            requestedAt: Date.now(),
            // A one-boot readiness budget for the respawn: the live watchdog
            // applies it over its own WD_BOOT_TIMEOUT for boots attempted
            // while this marker is pending, then falls back to its default.
            ...(options.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: options.bootTimeoutMs }),
            ...(gate.authorization === undefined ? {} : { authorization: gate.authorization }),
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
          env: testChildEnv('schedule-exit-agent', {
            ...process.env,
            WD_PORT: String(port),
            WD_DELAY_MS: String(delayMs),
            WD_RESULT_FILE: resultFile,
            ...(initiator !== undefined ? { WD_INITIATOR: initiator } : {}),
          }, { port, tempRoot: stateDir }),
        })
        registerSpawnedTestProcess(child, 'schedule-exit-agent', { port, tempRoot: stateDir })
        child.unref()
        io.stdout(`exit scheduled in ${delayMs} ms (exit-agent pid ${child.pid ?? 'unknown'}) — watchdog will respawn and run the canary\n`)
        return 0
      } finally {
        lock.release()
      }
    }
    default:
      io.stderr(`unknown command ${command}\n\n${USAGE}`)
      return 2
  }
}

// Direct invocation (`tsx src/cli.ts ...`) vs import by tests. Symlink-proof
// (isDirectInvocation): a plain URL compare silently never-fires via /tmp.
if (isDirectInvocation(import.meta.url)) {
  registerCurrentTestProcess()
  void runCli(process.argv.slice(2), {
    stdout: line => process.stdout.write(line),
    stderr: line => process.stderr.write(line),
  }).then((code) => { process.exitCode = code })
    .catch((error: unknown) => {
      process.stderr.write(`ankh-guard: ${String(error)}\n`)
      process.exitCode = 1
    })
}
