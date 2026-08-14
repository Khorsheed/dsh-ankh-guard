/**
 * Restart-record context injection: after a scheduled restart, the initiating
 * session's root agent reports it (falling back to any root agent when the
 * initiator is gone). Pure logic reads the exit agent's durable record
 * (`last-restart.json`) and the marker state; the plugin wires it into the
 * `agent/pre-step` messages so the model sees the restart facts without the
 * user having to ask.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/** Absolute path of the restart record inside a state directory. */
export function restartRecordFile(stateDir: string): string {
  return join(stateDir, 'last-restart.json')
}

/**
 * The pending restart record, or null when none is awaiting a report (absent,
 * unparseable, or already reported).
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
 * Acknowledge a restart record so it injects exactly once.
 * @param stateDir - state directory.
 * @param record - the record being reported.
 * @param now - epoch milliseconds of the acknowledgement.
 */
export function acknowledgeRestartRecord(stateDir: string, record: RestartRecord, now: number): void {
  try {
    writeFileSync(restartRecordFile(stateDir), `${JSON.stringify({ ...record, reportedAt: now })}\n`)
  } catch {
    // Best-effort: an unwritable record re-injects next step rather than crashing.
  }
}
