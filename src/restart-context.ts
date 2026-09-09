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
  /**
   * The watchdog recovered repeated boot failures by restoring the last
   * healthy profile composition (the newest plugin change was unmounted).
   */
  compositionRecovered?: boolean
  /** What the composition rollback changed (the unmounted rows), for the report. */
  detail?: string
  /** Durable launch-configuration cutover outcome and receipt location. */
  cutover?: {
    id: string
    outcome: 'target-ready' | 'restored' | 'awaiting-user' | 'prepare-failed'
    receipt: string
  }
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
 * The model-visible restart report (Chinese product copy, factual).
 * @param record - the pending restart record.
 * @param canaryPending - whether the restart marker is still present (the
 * watchdog has not yet run/cleared the canary).
 * @returns the report text, or an empty string for a malformed record.
 */
export function restartContextText(record: RestartRecord, canaryPending: boolean): string {
  if (record.exitAt === undefined && record.error === undefined) return ''
  const time = record.exitAt !== undefined ? new Date(record.exitAt).toISOString() : '未知时间'
  if (record.cutover !== undefined) {
    if (record.cutover.outcome === 'target-ready') {
      return `[ankh-guard] 服务于 ${time} 完成启动配置切换；新 supervisor 与 child 已接管，应用就绪证明（受保护宿主需要时包含认证交接）和金丝雀均通过。耐久回执：${record.cutover.receipt}。请读取回执中的 PID、配置摘要、认证、重试与恢复字段，并向用户生成最终报告。`
    }
    if (record.cutover.outcome === 'restored') {
      return `[ankh-guard] 服务于 ${time} 尝试切换启动配置失败，但已按重启前批准的策略恢复上一份完整启动配置并重新就绪。耐久回执：${record.cutover.receipt}。请读取回执并向用户报告失败、重试和恢复结果。`
    }
    if (record.cutover.outcome === 'awaiting-user') {
      return `[ankh-guard] 服务于 ${time} 切换启动配置失败；批准的策略是停留等待用户，watchdog 未擅自重置仓库。耐久回执：${record.cutover.receipt}。请读取回执并向用户报告当前等待点。`
    }
    return `[ankh-guard] 启动配置切换在停止旧实例前失败，上一份启动配置仍有效。耐久回执：${record.cutover.receipt}。请读取回执并向用户报告准备阶段失败。`
  }
  if (record.compositionRecovered === true) {
    const what = record.detail !== undefined ? `回滚内容：${record.detail}。` : ''
    return `[ankh-guard] 服务于 ${time} 前后连续启动失败，watchdog 已自动回滚到上次健康的 profile 组合并恢复。${what}原组合已备份到 state 的 composition-backup-* 目录。建议用户修复或卸载相关插件后重新安装验证。请向用户简要回报本次自动恢复与上述建议。`
  }
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
  if (record.cutover !== undefined) {
    const outcome = record.cutover.outcome === 'target-ready'
      ? '新启动配置的应用就绪证明（受保护宿主需要时包含认证交接）与金丝雀均已通过'
      : record.cutover.outcome === 'restored'
        ? '目标启动失败，上一份完整启动配置已恢复并重新就绪'
        : record.cutover.outcome === 'awaiting-user'
          ? '目标启动失败，watchdog 正按批准策略等待用户'
          : '切换在停止旧实例前失败，上一份启动配置仍有效'
    return `[ankh-guard] 服务于 ${time} 发生启动配置切换：${outcome}。你上次正在进行的回合被中断（日志已标记 interrupted）。耐久回执：${record.cutover.receipt}。请检查当前状态并继续未完成的任务，读取回执后向用户报告 supervisor/child PID、配置摘要、认证、重试与恢复结果。`
  }
  if (record.compositionRecovered === true) {
    return `[ankh-guard] 服务于 ${time} 前后连续启动失败，watchdog 已自动回滚到上次健康的 profile 组合并恢复（最近的插件变更已卸载）。你上次正在进行的回合被中断（日志已标记 interrupted）。请检查当前状态并继续未完成的任务，并向用户简要回报本次自动恢复；若任务已不再适用，简要说明原因后停止。`
  }
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

/**
 * Record the watchdog's ADOPTION takeover — the first restart a deployment
 * ever sees: `supervise` handed the port to the watchdog, which stopped the
 * pre-existing owner and booted the supervised instance. The session that
 * established supervision promised the user a verification report; without
 * this record nothing wakes it after the bounce (the adoption writes no
 * restart marker and no outcome record). Never overwrites a record that still
 * awaits its report.
 * @param stateDir - state directory.
 * @param now - epoch milliseconds of the takeover boot.
 * @param initiator - the session that established supervision, when known.
 * @returns whether the record was written.
 */
export function writeAdoptionRecord(stateDir: string, now: number, initiator: string | undefined): boolean {
  if (pendingRestartRecord(stateDir) !== null) return false
  mkdirSync(stateDir, { recursive: true })
  atomicWrite(restartRecordFile(stateDir), `${JSON.stringify({
    exitAt: now,
    ...(initiator !== undefined && initiator !== '' ? { initiator } : {}),
  })}\n`)
  return true
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
 * Record a composition rollback recovery: repeated boot failures whose
 * subject lived outside the checkout (a freshly installed plugin is the
 * common case) were recovered by restoring the last healthy profile
 * composition. The service is UP again minus the newest plugin change — the
 * recovery must be reported, never silent.
 *
 * Pending-record policy: a pending record with real diagnostics (error /
 * unexpected) is kept; a BARE exit outcome (exitAt/pid only) is merged over —
 * the watchdog knows the boot actually failed and recovered, so its record is
 * the truthful one, and it inherits the exit record's initiator so the report
 * still reaches its owner.
 * @param stateDir - state directory.
 * @param now - epoch milliseconds of the recovery boot.
 * @param detail - what changed in the rolled-back composition (e.g. the
 * unmounted bundle rows), for the report text.
 * @returns whether the record was written.
 */
export function writeCompositionRecovery(stateDir: string, now: number, detail?: string): boolean {
  const pending = pendingRestartRecord(stateDir)
  if (pending !== null && (pending.error !== undefined || pending.unexpected === true || pending.compositionRecovered === true)) return false
  mkdirSync(stateDir, { recursive: true })
  atomicWrite(restartRecordFile(stateDir), `${JSON.stringify({
    exitAt: now,
    compositionRecovered: true,
    ...(detail !== undefined && detail !== '' ? { detail } : {}),
    ...(pending?.initiator !== undefined ? { initiator: pending.initiator } : {}),
  })}\n`)
  return true
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
/**
 * Per-invocation transients, never launch configuration: the restart driver's
 * own marker, the calling session's identity, and the shell/web hand-off
 * vars. A recorded launch must not leak them into the next instance (a
 * restart driver reading DSH_ANKH_RESTART_DRIVER would misbehave; a stale
 * DSH_SESSION_ID misattributes reports).
 */
const TRANSIENT_ENV_KEYS = new Set(['DSH_ANKH_RESTART_DRIVER', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_WEB_URL', 'DSH_SHELL'])

export function buildLaunchCommand(execPath: string, execArgv: readonly string[], args: readonly string[], cwd: string, env: Record<string, string>): string {
  const envPart = Object.entries(env).filter(([key]) => !TRANSIENT_ENV_KEYS.has(key)).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')
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

/** The plugin's skill-registration outcome, rewritten at every boot. */
export interface SkillRegistrationRecord {
  /** Whether the restart-protocol skill is in the skill catalog. */
  registered: boolean
  /** Why registration was skipped/failed, when registered is false. */
  reason?: string
  /** Epoch milliseconds of this boot's attempt. */
  at: number
}

/**
 * Persist the skill-registration outcome (atomic, best-effort). A migration
 * or repackaging that drops the skill is otherwise invisible until someone
 * notices the catalog entry missing — this record lets `check-env` surface it.
 * @param stateDir - state directory.
 * @param record - the outcome of this boot's registration attempt.
 */
export function writeSkillRegistration(stateDir: string, record: SkillRegistrationRecord): void {
  try {
    mkdirSync(stateDir, { recursive: true })
    atomicWrite(stateFile(stateDir, 'skillRegistration'), `${JSON.stringify(record)}\n`)
  } catch {
    // Best-effort: the marker is an observability aid, never a boot blocker.
  }
}

/**
 * Read the skill-registration record, or null when absent/unparseable (the
 * plugin never applied with this state dir, or predates the record).
 * @param stateDir - state directory.
 * @returns the record, or null.
 */
export function readSkillRegistration(stateDir: string): SkillRegistrationRecord | null {
  try {
    const record = JSON.parse(readFileSync(stateFile(stateDir, 'skillRegistration'), 'utf8')) as SkillRegistrationRecord
    return typeof record.registered === 'boolean' && typeof record.at === 'number' ? record : null
  } catch {
    return null
  }
}

/** The tool whose open call means the turn is parked waiting for the human. */
const USER_INPUT_TOOL = 'ask_user_question'

/** Minimal log-event view this helper reads (the session-persistence event shape). */
interface ParkedProbeEvent {
  type: string
  seq?: number
  data: Record<string, unknown>
}

/**
 * Whether the session's last turn ended PARKED on user input: interrupted
 * while waiting on an open `ask_user_question` call, or on an approval
 * (`approval/asked` with no `approval/decided` in the same turn / after the
 * turn's start). A parked turn has no interrupted WORK — the card persists in
 * the log and the user answers whenever — so the restart resume must leave
 * such sessions alone (no resume, no continue injection, no replayed card).
 * @param events - the session's durable events (crash-repair already applied).
 * @returns whether the last interrupted turn was parked on user input.
 */
export function isParkedOnUserInput(events: readonly ParkedProbeEvent[]): boolean {
  let parkedTurn: number | undefined
  let parkedTurnStartSeq = -1
  for (const event of events) {
    const reason = event.data['reason'] as { kind?: string } | undefined
    if (event.type === 'turn/end' && reason?.kind === 'interrupted') {
      parkedTurn = event.data['turn'] as number
    }
  }
  if (parkedTurn === undefined) return false
  for (const event of events) {
    if (event.type === 'turn/start' && event.data['turn'] === parkedTurn) {
      parkedTurnStartSeq = event.seq ?? -1
    }
  }
  let lastToolName: string | undefined
  let pendingApproval = false
  for (const event of events) {
    // Approval events are not guaranteed to carry a turn — fall back to the
    // turn's start sequence boundary.
    const inTurn = event.data['turn'] === parkedTurn
      || (parkedTurnStartSeq >= 0 && (event.seq ?? -1) >= parkedTurnStartSeq)
    if (!inTurn) continue
    if (event.type === 'tool/call') lastToolName = event.data['name'] as string
    if (event.type === 'approval/asked') pendingApproval = true
    if (event.type === 'approval/decided') pendingApproval = false
  }
  return lastToolName === USER_INPUT_TOOL || pendingApproval
}
