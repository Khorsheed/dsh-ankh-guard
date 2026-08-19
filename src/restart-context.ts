/**
 * Restart-record context injection and interrupted-session continuity. After
 * a scheduled restart, the FULL report waits for the initiating session's
 * root agent, whenever it resumes (session restore is lazy, so no other
 * session is ever woken for reporting); a record without an initiator is
 * claimed by the first root agent created. Separately, a snapshot written at
 * SIGTERM time (`interrupted-sessions.json`) records which root sessions had
 * a live turn when the process stopped, so the next restart boot can resume
 * those sessions and queue a "continue" turn. Pure logic reads the durable
 * files; the plugin wires them into `agent/created` and `agent.followup`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The exit agent's durable restart record (written by `schedule-exit`). */
export interface RestartRecord {
  exitAt?: number
  pid?: number
  error?: string
  /** Session id of the agent that scheduled the exit, when known. */
  initiator?: string
  reportedAt?: number
}

/**
 * The shutdown snapshot: which root sessions to resume on the next restart
 * boot. `resume` carries the restart's initiator (so the report's owner comes
 * back even when its own turn had already finished); `interrupted` carries
 * the sessions whose turn was live at SIGTERM — those additionally receive a
 * "continue" followup. Written synchronously in the signal handler.
 */
export interface InterruptedSnapshot {
  exitAt: number
  resume: string[]
  interrupted: string[]
}

/** Absolute path of the restart record inside a state directory. */
export function restartRecordFile(stateDir: string): string {
  return join(stateDir, 'last-restart.json')
}

/** Absolute path of the interrupted-session snapshot inside a state directory. */
export function interruptedSnapshotFile(stateDir: string): string {
  return join(stateDir, 'interrupted-sessions.json')
}

/**
 * The pending restart record, or null when none is awaiting a report (absent,
 * unparseable, or settled). The record stays pending until the initiator
 * resumes or the next restart replaces it (a new exitAt) — those are the only
 * retirement paths.
 * @param stateDir - state directory.
 * @returns the record without `reportedAt`, or null.
 */
export function pendingRestartRecord(stateDir: string): RestartRecord | null {
  const file = restartRecordFile(stateDir)
  if (!existsSync(file)) return null
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as RestartRecord
    return record.reportedAt !== undefined ? null : record
  } catch {
    return null
  }
}

/**
 * The model-visible restart report (Chinese product copy, factual).
 * @param record - the pending restart record.
 * @param canaryPending - whether the restart marker is still present (the
 * watchdog has not yet run/cleared the canary).
 * @returns the report text, or an empty string for a malformed record.
 */
export function restartContextText(record: RestartRecord, canaryPending: boolean): string {
  if (record.exitAt === undefined && record.error === undefined) return ''
  const time = record.exitAt !== undefined ? new Date(record.exitAt).toISOString() : '未知时间'
  const outcome = record.error !== undefined ? `失败（${record.error}）` : '成功'
  const canary = canaryPending ? '金丝雀尚未完成' : '金丝雀已处理'
  return `[ankh-guard] 服务最近重启过：${time}，退出${outcome}，${canary}。请向用户简要回报本次重启结果。`
}

/**
 * The model-visible "continue" prompt for a session whose turn was
 * interrupted by the restart (its log tail was closed with
 * `reason.kind === 'interrupted'` by crash-recovery repair).
 * @param exitAt - epoch milliseconds of the exit that interrupted the turn.
 * @returns the prompt text.
 */
export function continueInterruptedText(exitAt: number): string {
  return `[ankh-guard] 服务于 ${new Date(exitAt).toISOString()} 重启，你上次正在进行的回合被中断（日志已标记 interrupted）。请检查当前状态并继续未完成的任务；若任务已不再适用，简要说明原因后停止。`
}

/**
 * The combined prompt for a session that is BOTH the restart's initiator and
 * an interrupted session: one turn continues the work and reports the
 * restart, instead of two near-duplicate turns.
 * @param record - the pending restart record.
 * @param canaryPending - whether the restart marker is still present.
 * @returns the prompt text, or an empty string for a malformed record.
 */
export function continueAndReportText(record: RestartRecord, canaryPending: boolean): string {
  if (record.exitAt === undefined && record.error === undefined) return ''
  const time = record.exitAt !== undefined ? new Date(record.exitAt).toISOString() : '未知时间'
  const outcome = record.error !== undefined ? `失败（${record.error}）` : '成功'
  const canary = canaryPending ? '金丝雀尚未完成' : '金丝雀已处理'
  return `[ankh-guard] 服务于 ${time} 重启，退出${outcome}，${canary}。你上次正在进行的回合被中断（日志已标记 interrupted）。请检查当前状态并继续未完成的任务，并向用户简要回报本次重启结果；若任务已不再适用，简要说明原因后停止。`
}

/**
 * Acknowledge a restart record so it injects exactly once.
 * @param stateDir - state directory.
 * @param record - the record being reported.
 * @param now - epoch milliseconds of the acknowledgement.
 */
export function acknowledgeRestartRecord(stateDir: string, record: RestartRecord, now: number): void {
  try {
    atomicWrite(restartRecordFile(stateDir), `${JSON.stringify({ ...record, reportedAt: now })}\n`)
  } catch {
    // Best-effort: an unwritable record re-injects next step rather than crashing.
  }
}

/**
 * Read the shutdown snapshot, or null when absent/unparseable. Malformed
 * snapshots are dropped by the caller's delete-after-read, never retried.
 * @param stateDir - state directory.
 * @returns the snapshot, or null.
 */
export function readInterruptedSnapshot(stateDir: string): InterruptedSnapshot | null {
  const file = interruptedSnapshotFile(stateDir)
  if (!existsSync(file)) return null
  try {
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as InterruptedSnapshot
    if (!Array.isArray(snapshot.resume) || !Array.isArray(snapshot.interrupted)) return null
    return snapshot
  } catch {
    return null
  }
}

/**
 * Write the shutdown snapshot (synchronous — called from a signal handler).
 * The state directory is created on demand: a fresh deployment has no
 * `$DSH_HOME/state` yet, and a missing directory must not silently drop the
 * snapshot.
 * @param stateDir - state directory.
 * @param snapshot - the snapshot to persist.
 */
export function writeInterruptedSnapshot(stateDir: string, snapshot: InterruptedSnapshot): void {
  try {
    mkdirSync(stateDir, { recursive: true })
    atomicWrite(interruptedSnapshotFile(stateDir), `${JSON.stringify(snapshot)}\n`)
  } catch {
    // Best-effort: a failed snapshot loses auto-continue for this stop, never the process.
  }
}

/** Write a small durable file atomically (tmp + rename in the same directory). */
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}
