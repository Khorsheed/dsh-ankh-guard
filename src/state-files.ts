/**
 * The guard's state-directory protocol: every file that lives in the state
 * dir, named exactly once. Five writers in three languages (this package's
 * TS, the watchdog's bash, the schedule-exit exit agent's inline JS, and the
 * two supervisor installers) read and write these — a literal drifting in
 * any one of them splits the protocol silently (three review rounds of path
 * bugs came from exactly that). The bash sides are pinned by
 * tests/state-files.spec.ts, which asserts every state-dir literal in the
 * watchdog and both installers appears here, and that no script re-derives
 * the directory from the home.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendTestLifecycleEvent } from './test-seam.ts'

/** Every state-directory file name, keyed by role. */
export const STATE_FILES = {
  /** The guard's credential/checkpoint/audit state (state.ts). */
  guard: 'self-restart-guard.json',
  /** Watchdog-stamped last deployment-proven revision. */
  lastGoodBoot: 'last-good-boot.json',
  /** schedule-exit → watchdog: an intentional restart, run the canary. */
  restartRequested: 'restart-requested.json',
  /** The exit agent's restart outcome record (the report's source). */
  lastRestart: 'last-restart.json',
  /** The SIGTERM snapshot of interrupted sessions. */
  interruptedSessions: 'interrupted-sessions.json',
  /** The supervising watchdog's pidfile. */
  watchdogPid: 'watchdog.pid',
  /** Cross-session mutual exclusion for the restart verb. */
  restartLock: 'restart.lock',
  /** The detached restart driver's log. */
  restartLog: 'restart.log',
  /** Marker: exit the watchdog without respawn. */
  watchdogStop: 'watchdog-stop',
  /** Marker: the watchdog gave up; a crash page holds the port. */
  watchdogGaveUp: 'watchdog-gave-up',
  /** The current boot attempt's captured output. */
  bootAttemptLog: 'boot-attempt.log',
  /** The watchdog's own log. */
  watchdogLog: 'watchdog.log',
  /** The watchdog's stderr, captured separately by the supervisor installers. */
  watchdogStderrLog: 'watchdog.stderr.log',
  /** The exit agent's log. */
  scheduleExitLog: 'schedule-exit.log',
  /** How the current instance was launched (recorded by the plugin at apply). */
  instanceLaunch: 'instance-launch.json',
  /** The atomically selected full launch configuration (stable or in cutover). */
  launchSpec: 'launch-spec.json',
  /** Redacted durable receipt for the latest launch-configuration cutover. */
  launchCutover: 'launch-cutover.json',
  /** Legacy combined operator-control marker, retained for rolling upgrades. */
  cutoverControl: 'launch-cutover-control.json',
  /** Operator → watchdog: abort according to the pre-approved recovery policy. */
  cutoverAbort: 'launch-cutover-abort.json',
  /** Monotonic stronger operator action: explicitly restore the previous spec. */
  cutoverRestorePrevious: 'launch-cutover-restore-previous.json',
  /** Original browser-tab registry: per-tab capability hashes only; retained through terminal recovery. */
  browserHandoffRequest: 'browser-handoff-request.json',
  /** Browser → watchdog acknowledgement for one proven final process. */
  browserHandoffAck: 'browser-handoff-ack.json',
  /** Whether the restart-protocol skill registered at apply (and why not). */
  skillRegistration: 'skill-registration.json',
  /** Directory: the healthy-boot snapshot of the profile composition inputs. */
  lastGoodComposition: 'last-good-composition',
  /** Directory prefix: a failing composition backed up before rollback restores over it. */
  compositionBackup: 'composition-backup-',
} as const

/** A STATE_FILES key. */
export type StateFileRole = keyof typeof STATE_FILES

/** Absolute path of a state file inside a state directory. */
export function stateFile(stateDir: string, role: StateFileRole): string {
  return join(stateDir, STATE_FILES[role])
}

/**
 * The last deployment-proven revision, stamped by the watchdog on every
 * healthy boot, or undefined. Lives here rather than in the credential core:
 * the stamp is written by the watchdog and proves the deployment composed and
 * came up — a green credential only ever proves build+test passed.
 * @param stateDir - state directory.
 * @returns the stamped revision, or undefined.
 */
export function lastGoodBootRevision(stateDir: string): string | undefined {
  try {
    const stamp = JSON.parse(readFileSync(stateFile(stateDir, 'lastGoodBoot'), 'utf8')) as { revision?: unknown }
    return typeof stamp.revision === 'string' && stamp.revision !== '' ? stamp.revision : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the pid named by this raw pid/lock-file content is alive. Empty
 * content reads as NO holder: Number('') is 0 and kill(0, 0) probes our own
 * process group (always succeeds), which once read as "alive" and refused
 * every restart forever — the bug that had to be fixed in two copies of this
 * logic before it was consolidated here.
 */
export function pidAlive(raw: string): boolean {
  const pid = Number(raw)
  if (raw === '' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The live pid named by a pid/lock file (as the raw string), or null when absent/stale. */
export function livePidIn(file: string): string | null {
  try {
    const raw = readFileSync(file, 'utf8').trim()
    return pidAlive(raw) ? raw : null
  } catch {
    return null
  }
}

/** The live supervising watchdog's pid, or null when none is (pidfile + kill 0). */
export function liveWatchdogPid(stateDir: string): number | null {
  const raw = livePidIn(stateFile(stateDir, 'watchdogPid'))
  const pid = raw === null ? null : Number(raw)
  appendTestLifecycleEvent('watchdog-liveness-probe', { pid: pid ?? 0, live: pid !== null }, 'parent-observer')
  return pid
}
