/**
 * The guard's state-directory protocol: every file that lives in the state
 * dir, named exactly once. Four processes in three languages (this package's
 * TS, the watchdog's bash, the schedule-exit exit agent's inline JS) read and
 * write these — a literal drifting in any one of them splits the protocol
 * silently (three review rounds of path bugs came from exactly that). The
 * bash side is pinned by tests/state-files.spec.ts, which asserts every
 * $STATE_DIR literal in dsh-watchdog.sh appears here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  /** Marker: exit the watchdog without respawn. */
  watchdogStop: 'watchdog-stop',
  /** Marker: the watchdog gave up; a crash page holds the port. */
  watchdogGaveUp: 'watchdog-gave-up',
  /** The current boot attempt's captured output. */
  bootAttemptLog: 'boot-attempt.log',
  /** The watchdog's own log. */
  watchdogLog: 'watchdog.log',
  /** The exit agent's log. */
  scheduleExitLog: 'schedule-exit.log',
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
