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
import { stateFile } from './state-files.ts'

/** The exit agent's durable restart record (written by `schedule-exit`). */
export interface RestartRecord {
  exitAt?: number
  pid?: number
  error?: string
  /** Session id of the agent that scheduled the exit, when known. */
  initiator?: string
  /**
   * The watchdog recovered an UNPLANNED exit (crash, or a stop outside the
   * guard) — written on the respawn so the recovery is reported, not silent.
   */
  unexpected?: boolean
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
  return stateFile(stateDir, 'lastRestart')
}

/** Absolute path of the interrupted-session snapshot inside a state directory. */
export function interruptedSnapshotFile(stateDir: string): string {
  return stateFile(stateDir, 'interruptedSessions')
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
 * The model-visible boot notice: how restarts must be driven in this
 * deployment. Injected (no wake) into every root session at creation —
 * the README is not reliably read, and a fresh-machine agent once
 * hand-rolled a sleep/kill/nohup restart script, which the instance's
 * teardown reaped mid-flight, leaving the service down.
 */
export function bootNoticeText(): string {
  return '[ankh-guard] 本实例已挂载自重启守护。需要重启服务时必须使用守护 CLI：先 `dsh-ankh-guard check-env`（一次回答监管状态/重启命令/环境就绪），再 `record` 绿色凭证，然后 `dsh-ankh-guard restart`（`--start` 通常可省略——启动命令已自动记录；受 watchdog 监管时用 `schedule-exit`）。禁止手写 sleep/kill/nohup 类重启脚本——它们会被实例 teardown 回收，服务就此宕掉无人拉起。'
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
  if (record.unexpected === true) {
    return `[ankh-guard] 服务最近发生过一次非计划退出（崩溃或被手动停止）：${time}，watchdog 已自动拉起实例。请向用户简要回报这次非计划重启。`
  }
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
  if (record.unexpected === true) {
    return `[ankh-guard] 服务于 ${time} 发生非计划退出（崩溃或被手动停止），watchdog 已自动拉起实例。你上次正在进行的回合被中断（日志已标记 interrupted）。请检查当前状态并继续未完成的任务，并向用户简要回报这次非计划重启；若任务已不再适用，简要说明原因后停止。`
  }
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
 * Record an unplanned-exit recovery (the watchdog respawned the instance with
 * no restart marker), unless a record still awaits its report. Returns whether
 * the record was written — the caller (CLI verb, invoked by the watchdog) logs
 * either way, so the watchdog log must never claim a write that was skipped.
 * @param stateDir - state directory.
 * @param now - epoch milliseconds of the recovery.
 * @returns true when the record was written, false when a pending record was kept.
 */
export function writeUnexpectedExitRecord(stateDir: string, now: number): boolean {
  if (pendingRestartRecord(stateDir) !== null) return false
  mkdirSync(stateDir, { recursive: true })
  atomicWrite(restartRecordFile(stateDir), `${JSON.stringify({ exitAt: now, unexpected: true })}\n`)
  return true
}

/**
 * Record the restart verb's outcome for the report machinery (the restart
 * verb is otherwise invisible to it: it writes no marker and no record, so a
 * restart it drove would never be reported to any session). Mirrors the exit
 * agent's record semantics; a still-pending earlier record is replaced only
 * by a completed newer restart.
 * @param stateDir - state directory.
 * @param record - the outcome fields (exitAt/pid for a stop, error on failure).
 */
export function writeRestartOutcome(stateDir: string, record: { exitAt: number; pid?: number; error?: string; initiator?: string }): void {
  mkdirSync(stateDir, { recursive: true })
  atomicWrite(restartRecordFile(stateDir), `${JSON.stringify(record)}\n`)
}

/** How the current instance was launched, recorded at boot. */
export interface InstanceLaunch {
  /** The shell command that starts the instance. */
  command: string
  /** Who wrote the record: the instance itself, or its supervisor. */
  source: 'instance' | 'supervisor'
  /**
   * The instance runs under a watchdog (the supervisor's respawn owns the
   * port). A restart FALLING BACK to a bare per-instance command would spawn
   * the instance directly and fight the supervisor's respawn — the fallback
   * must refuse and point at schedule-exit instead.
   */
  supervised?: boolean
  /** The instance's listening port, when discovered at apply time. */
  port?: number
  /** Epoch milliseconds when recorded. */
  recordedAt: number
}

/**
 * Persist the launch record (atomic). The instance-facing side of
 * {@link writeInstanceLaunch}: only an `instance`-sourced record may be
 * replaced by another — a `supervisor` record carries the FULL supervision
 * chain (watchdog, launch wrapper) and the inner process must not overwrite
 * it with its own bare argv.
 * @param stateDir - state directory.
 * @param launch - the launch facts.
 * @returns whether the record was written.
 */
export function writeInstanceLaunch(stateDir: string, launch: InstanceLaunch): boolean {
  const existing = readInstanceLaunch(stateDir)
  if (existing?.source === 'supervisor') return false
  mkdirSync(stateDir, { recursive: true })
  atomicWrite(stateFile(stateDir, 'instanceLaunch'), `${JSON.stringify(launch)}\n`)
  return true
}

/** POSIX single-quote one word for a shell command line. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`
}

/**
 * Render the instance's launch as a shell command: cwd, DSH_* env, and the
 * FULL node invocation — execArgv included, because a tsx chain
 * (`node --import tsx …`) rendered without it becomes a bare `node bin.ts`
 * that cannot load TypeScript sources.
 */
export function buildLaunchCommand(execPath: string, execArgv: readonly string[], args: readonly string[], cwd: string, env: Record<string, string>): string {
  const envPart = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')
  const argv = [execPath, ...execArgv, ...args].map(shellQuote).join(' ')
  return `cd ${shellQuote(cwd)} && ${envPart !== '' ? `${envPart} ` : ''}${argv}`
}

/** Replace any record unconditionally (the supervisor's own write path). */
export function writeInstanceLaunchAsSupervisor(stateDir: string, launch: InstanceLaunch): void {
  mkdirSync(stateDir, { recursive: true })
  atomicWrite(stateFile(stateDir, 'instanceLaunch'), `${JSON.stringify(launch)}\n`)
}

/**
 * Read the launch record, or null when absent/unparseable (older deployments,
 * or the plugin never applied in this home).
 * @param stateDir - state directory.
 * @returns the record, or null.
 */
export function readInstanceLaunch(stateDir: string): InstanceLaunch | null {
  try {
    const launch = JSON.parse(readFileSync(stateFile(stateDir, 'instanceLaunch'), 'utf8')) as InstanceLaunch
    return typeof launch.command === 'string' ? launch : null
  } catch {
    return null
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
