/**
 * Self-restart guard: the hard gate between "the tree is green" and "it is
 * safe to restart the running instance". A self-modifying agent records a
 * green-build credential ONLY after the full build and targeted tests pass;
 * any restart path (launcher canary, the agent's own restart procedure) must
 * consult {@link SelfRestartGuard.verify} and be denied while the credential
 * is missing, stale, or bound to a different HEAD than the checkout.
 *
 * The credential is bound to the git HEAD it was recorded on, so any change
 * after recording invalidates it — a post-hoc or stale credential can never
 * authorize a restart of unverified code. Checkpoints are plain commits with
 * a guard message; rollback is `git reset --hard` to the last known-good
 * revision (the watchdog's healthy-boot stamp, else the checkpoint, else the
 * credential), always leaving `guard-backup-*` anchors for whatever it
 * discards.
 *
 * @module @khorsheed/dsh-ankh-guard
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { connect } from 'node:net'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the agent package's event merge ('agent/pre-step').
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset, type PresetBearingSession } from '@deepseek-ai/dsh-agent-presets'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRepoDir, resolveStateDir } from './defaults.ts'
import { commitCheckpoint, currentHead, resetToCheckpoint } from './git.ts'
import {
  acknowledgeRestartRecord, continueAndReportText, continueInterruptedText, interruptedSnapshotFile,
  pendingRestartRecord, readInterruptedSnapshot, restartContextText, writeInterruptedSnapshot,
  type RestartRecord,
} from './restart-context.ts'
import {
  clearCredential, loadState, recordCredential, setCheckpoint, verifyCredential,
  type GuardState, type VerifyResult,
} from './state.ts'

/** Plugin configuration. */
export interface SelfRestartGuardConfig {
  /** Credential freshness window in minutes (default 10). */
  maxAgeMinutes?: number
  /** State directory; defaults to $DSH_HOME/state, else `<cwd>/.dsh-guard-state`. */
  stateDir?: string
  /** Repository the credential binds to; defaults to the process cwd. */
  repoDir?: string
  /**
   * How to surface a scheduled restart's record to the agent (default
   * `followup` — fully autonomous: the plugin queues the report as the next
   * turn via `agent.followup`, the official wake-the-agent seam the schedule
   * system uses for reminders, so the agent reports without any user message).
   * `step` rides the first step of whatever turn comes next; `off` disables.
   */
  reportRestartContext?: 'followup' | 'step' | 'off'
  /**
   * Resume the sessions a restart interrupted (default true). At SIGTERM the
   * plugin snapshots which root sessions had a live turn (plus the restart's
   * initiating session); on the next restart boot it resumes them via
   * `ctx.agents.resume` and queues a "continue" followup for the interrupted
   * ones, so a self-restart no longer silently pauses every other session.
   * The pass only runs on a restart boot (restart marker or pending restart
   * record present); a cold start drops the snapshot without acting.
   */
  resumeInterrupted?: boolean
  /**
   * Delay before the interrupted-session resume pass runs after plugin load
   * (default 5000 ms), so the pass starts turns only after the app's services
   * are up.
   */
  resumeDelayMs?: number
  /**
   * Maximum age of the interrupted-session snapshot the resume pass honors
   * (default 600000 ms, ten minutes). A snapshot older than that comes from a
   * manual stop/start, not a restart, and is dropped without acting.
   */
  resumeMaxSnapshotAgeMs?: number
}

export const Config: z<SelfRestartGuardConfig> = z.object({
  maxAgeMinutes: z.natural().min(1).default(10),
  stateDir: z.string().default(''),
  repoDir: z.string().default(''),
  reportRestartContext: z.union([z.const('followup'), z.const('step'), z.const('off')]).default('followup'),
  resumeInterrupted: z.boolean().default(true),
  resumeDelayMs: z.natural().min(0).default(5000),
  resumeMaxSnapshotAgeMs: z.natural().min(1).default(600000),
})

/** One canary check line. */
export interface CanaryCheck {
  name: string
  ok: boolean
  detail: string
}

/** Canary verdict: the gate plus optional liveness probes. */
export interface CanaryResult {
  ok: boolean
  checks: CanaryCheck[]
}

/** Result of a checkpoint request. */
export type CheckpointResult =
  | { ok: true; sha: string; artifacts: string[] }
  | { ok: false; error: string }

/**
 * The guard's public face: what the agent and the launcher consult before and
 * after a self-restart.
 */
export interface SelfRestartGuard {
  /**
   * The gate: is there a fresh, HEAD-bound green credential right now?
   * @returns ok plus a human reason either way.
   */
  verify(): VerifyResult
  /**
   * Record a green credential for the current HEAD.
   * @param scope - what passed, e.g. 'build+test'.
   * @param options - optional command that produced the green state.
   * @returns the persisted state including the new credential.
   * @throws outside a git repository (no HEAD to bind to).
   */
  record(scope: string, options?: { command?: string }): GuardState
  /**
   * Drop the credential (checkpoint and audit survive).
   * @returns the persisted state without the credential.
   */
  clear(): GuardState
  /**
   * Read the full state (credential, checkpoint, audit).
   * @returns the loaded state.
   */
  status(): GuardState
  /**
   * Commit the whole tree as a pre-batch checkpoint and remember it.
   * @param message - batch description; defaults to 'batch snapshot'.
   * @returns the checkpoint commit sha, or a failure reason.
   */
  checkpoint(message?: string): CheckpointResult
  /**
   * Hard-reset the checkout to a checkpoint commit, leaving `guard-backup-*`
   * recovery anchors for the discarded HEAD and any uncommitted work.
   * @param sha - the checkpoint commit to reset to.
   * @returns success with the recovery anchor refs, or a failure reason.
   */
  reset(sha: string): { ok: boolean; error?: string; anchors: string[] }
  /**
   * Post-restart canary: verify plus an optional port-liveness probe.
   * @param options - optional TCP port that must be listening.
   * @returns one check line per probe; ok only when every check passed.
   */
  canary(options?: { port?: number }): Promise<CanaryResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    selfRestartGuard: SelfRestartGuard
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ankh-guard'

/** Required services: the agents registry (root-agent gate for the followup path). */
export const inject = ['agents']

/** Probe whether something is listening on a TCP port (bounded, never hangs). */
async function checkPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1500, () => { done(false) })
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
  })
}

/**
 * Mount the guard service with resolved configuration.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: SelfRestartGuardConfig): void {
  const stateDir = resolveStateDir(config.stateDir)
  const repoDir = resolveRepoDir(config.repoDir)
  const maxAgeMinutes = config.maxAgeMinutes ?? 10
  const reportMode = config.reportRestartContext ?? 'followup'
  const resumeInterrupted = config.resumeInterrupted ?? true
  const resumeDelayMs = config.resumeDelayMs ?? 5000
  const resumeMaxSnapshotAgeMs = config.resumeMaxSnapshotAgeMs ?? 600_000

  // Restart continuity, two halves wired into `agent/created`:
  //
  // 1. The restart REPORT waits for its owner. Session restore after a
  //    restart is lazy (an agent is created only when the UI or an RPC
  //    touches the session), so the full report is queued via
  //    `agent.followup` — the official wake-the-agent seam the schedule
  //    system uses for reminders — only for the session that scheduled the
  //    exit (`record.initiator`, recorded by `schedule-exit` from
  //    $DSH_SESSION_ID), whenever it resumes; a record without an initiator
  //    is claimed by the first root agent created. No other session is ever
  //    woken for reporting: the record stays pending until its owner resumes
  //    or the next restart replaces it (a new exitAt), the only retirement
  //    paths. Only root agents (not subagents), and only once (the record is
  //    acknowledged on delivery).
  // 2. Sessions the restart INTERRUPTED are resumed and continued. The
  //    SIGTERM handler snapshots which root sessions had a live turn (plus
  //    the restart's initiator, so the report's owner comes back even when
  //    its own turn had already finished); on the next restart boot — and
  //    only then: a cold start drops the snapshot without acting — the
  //    resume pass re-creates those agents via `ctx.agents.resume` and queues
  //    a "continue" followup for the interrupted ones (their logs were closed
  //    with `reason.kind === 'interrupted'` by crash-recovery repair).
  //
  // The two halves are gated INDEPENDENTLY: half 1 by reportMode, half 2 by
  // resumeInterrupted. Nesting both under reportMode once meant
  // `reportRestartContext: 'step'/'off'` silently disabled session recovery
  // (default-on!) with no warning — a misconfiguration failing silent.
  const followupReport = reportMode === 'followup'
  if (followupReport || resumeInterrupted) {
    type FollowupAgent = { followup: (message: ReturnType<typeof createUserMessage>) => void }
    const pluginMessage = (text: string): ReturnType<typeof createUserMessage> => createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: 'restart', text }] },
    })
    // Interrupted sessions awaiting their `agent/created` to receive the
    // "continue" followup: session id → exitAt of the interrupting exit.
    const pendingContinue = new Map<string, number>()
    let disposed = false
    ctx.effect(() => () => { disposed = true })

    const claim = (agent: FollowupAgent, record: RestartRecord): void => {
      const canaryPending = existsSync(join(stateDir, 'restart-requested.json'))
      const text = restartContextText(record, canaryPending)
      if (text === '') return
      // Deliver before acknowledging: an ack on an undelivered followup would
      // lose the report; a followup that throws keeps the record pending for
      // the next creation instead.
      agent.followup(pluginMessage(text))
      acknowledgeRestartRecord(stateDir, record, Date.now())
    }

    // The single delivery path for every resume trigger (this plugin's pass,
    // the UI, the schedule system): an interrupted session gets exactly one
    // "continue" injection; the restart's initiator gets the report — merged
    // into one message when it is both. The map makes repeat calls no-ops.
    const deliver = (agent: FollowupAgent & { id: unknown }): void => {
      const id = agent.id as string
      const exitAt = pendingContinue.get(id)
      const record = followupReport ? pendingRestartRecord(stateDir) : null
      if (exitAt !== undefined && record !== null
        && (record.initiator === undefined || id === record.initiator)) {
        // The initiator was itself interrupted by its own restart: one
        // combined turn continues the work AND reports the outcome — two
        // separate injections would run two near-duplicate turns.
        const canaryPending = existsSync(join(stateDir, 'restart-requested.json'))
        const text = continueAndReportText(record, canaryPending)
        if (text !== '') {
          agent.followup(pluginMessage(text))
          pendingContinue.delete(id)
          acknowledgeRestartRecord(stateDir, record, Date.now())
          return
        }
        // A record with nothing to report yet (no exitAt/error) must not
        // swallow the continue — fall through to the continue-only path.
      }
      if (exitAt !== undefined) {
        agent.followup(pluginMessage(continueInterruptedText(exitAt)))
        // Delete only after a successful injection: a throwing followup keeps
        // the session eligible at its next creation (same rule as claim()).
        pendingContinue.delete(id)
      }
      if (record === null) return
      // The report waits for its owner; other sessions are never woken.
      if (record.initiator !== undefined && id !== record.initiator) return
      claim(agent, record)
    }

    // Shutdown snapshot: which root sessions had a live turn when the process
    // stopped. Synchronous by design — a signal handler cannot await. Only
    // registered when resume is on: the snapshot's sole consumer is the resume
    // pass, so a disabled resume must not leave stray state files behind.
    const snapshotInterrupted = (): void => {
      try {
        const interrupted = ctx.agents.roots()
          .filter(agent => agent.status === 'running')
          .map(agent => agent.id as string)
        let initiator: string | undefined
        try {
          const marker = JSON.parse(readFileSync(join(stateDir, 'restart-requested.json'), 'utf8')) as { initiator?: string }
          initiator = marker.initiator
        } catch {
          // No scheduled-restart marker: a plain stop snapshots turns only.
        }
        writeInterruptedSnapshot(stateDir, {
          exitAt: Date.now(),
          resume: initiator !== undefined ? [initiator] : [],
          interrupted,
        })
      } catch {
        // Best-effort: a signal handler must never throw into shutdown.
      }
    }
    if (resumeInterrupted) {
      process.on('SIGTERM', snapshotInterrupted)
      ctx.effect(() => () => { process.off('SIGTERM', snapshotInterrupted) })
    }

    // A faithful resume mirrors the API proxy's cold-resume path: the
    // session's stored preset composition (resolved from the LOG, not the
    // creation header) and the deployment's current default model selection.
    // A bare resume loses both — the persona's {{model}} variable then has no
    // value and every turn of the resumed agent fails.
    const buildResumeOptions = async (id: string): Promise<ResumeAgentOptions> => {
      const agentOptions: AgentOptions = {}
      const defaultModel = ctx.get('agentDefaultModel') as
        | { currentSelection(): { provider?: string; model?: string } }
        | undefined
      const selection = defaultModel?.currentSelection()
      if (defaultModel !== undefined && (selection?.provider === undefined || selection?.model === undefined)) {
        // The hand-copied structural type above degrades SILENTLY on host
        // signature drift: the resume succeeds, the persona's {{model}} is
        // empty, and every resumed turn fails. Say so when it happens.
        ctx.logger(name).warn('agentDefaultModel present but yielded no complete provider/model selection — resumed sessions may fail every turn (host signature drift?)')
      }
      if (selection?.provider !== undefined) agentOptions.provider = selection.provider
      if (selection?.model !== undefined) agentOptions.model = selection.model
      let setup: ResumeAgentOptions['setup']
      const presets = ctx.get('agentPresets') as
        | { resolve(presetId?: string): Promise<{ id: string }>; mount(agentCtx: Context, presetId?: string): Promise<unknown> }
        | undefined
      const persistence = ctx.get('sessionPersistence') as
        | { inspect(sessionId: string): Promise<{ meta: PresetBearingSession['header']; events: PresetBearingSession['events'] }> }
        | undefined
      if (presets !== undefined && persistence !== undefined) {
        const inspected = await persistence.inspect(id)
        const presetId = resolveSessionPreset({ header: inspected.meta, events: inspected.events })
        setup = async (agentCtx) => { await presets.mount(agentCtx, (await presets.resolve(presetId)).id) }
      }
      return { resumeSessionId: id, agentOptions, ...(setup === undefined ? {} : { setup }) } as ResumeAgentOptions
    }

    // The resume gate is the snapshot's freshness alone. Marker-based gating
    // (restart-requested.json / pending record) breaks on multi-attempt
    // boots: the first attempt that reaches healthy consumes both markers, so
    // a later attempt within the same restart cycle reads "not a restart" and
    // drops the snapshot unacted. A fresh snapshot only exists when a graceful
    // stop interrupted live turns, and a quick stop/start rescuing them is
    // desirable whether the stop was scheduled or manual.
    //
    // Pre-populate the continue map at apply time: every interrupted session
    // then receives exactly one injection whoever resumes it — this plugin's
    // pass below, the UI, or the schedule system. (Reading the snapshot here
    // also covers sessions the UI resumes before the delayed pass runs.)
    if (resumeInterrupted) {
      const snapshot = readInterruptedSnapshot(stateDir)
      if (snapshot !== null && Date.now() - snapshot.exitAt <= resumeMaxSnapshotAgeMs) {
        for (const id of snapshot.interrupted) pendingContinue.set(id, snapshot.exitAt)
      }
    }

    // The resume pass, once per boot: resume the snapshot's sessions; delivery
    // happens through `deliver` below, from the `agent/created` listener or
    // the live branch here.
    const resumePass = async (): Promise<void> => {
      const snapshot = readInterruptedSnapshot(stateDir)
      if (snapshot === null) return
      // A stale snapshot (a stop/start hours later) is dropped: only a recent
      // graceful stop resumes sessions.
      if (Date.now() - snapshot.exitAt <= resumeMaxSnapshotAgeMs) {
        for (const id of [...new Set([...snapshot.resume, ...snapshot.interrupted])]) {
          if (disposed) return
          const live = ctx.agents.list().find(agent => (agent.id as string) === id)
          if (live !== undefined) {
            // Already live: its `agent/created` may have predated this plugin's
            // apply (config-resumed agents), so deliver directly — the map
            // makes it a no-op when the listener already delivered.
            deliver(live)
            continue
          }
          try {
            await ctx.agents.resume(await buildResumeOptions(id))
          } catch (error) {
            pendingContinue.delete(id)
            ctx.logger(name).warn(`auto-resume of session ${id} failed: ${String(error)}`)
          }
        }
      }
      try {
        unlinkSync(interruptedSnapshotFile(stateDir))
      } catch {
        // Best-effort: a leftover snapshot is dropped on the next boot's read.
      }
    }
    if (resumeInterrupted) {
      const timer = setTimeout(() => { void resumePass() }, resumeDelayMs)
      ctx.effect(() => () => { clearTimeout(timer) })
    }

    ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return
      deliver(agent)
    })
  }

  // Step-riding report: the first step after a scheduled restart injects the
  // record (plugin-sourced user message in `agent/pre-step` messages).
  if (reportMode === 'step') {
    ctx.on('agent/pre-step', async ({ signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const record = pendingRestartRecord(stateDir)
      if (record === null) return decision
      const canaryPending = existsSync(join(stateDir, 'restart-requested.json'))
      const text = restartContextText(record, canaryPending)
      if (text === '') return decision
      acknowledgeRestartRecord(stateDir, record, Date.now())
      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind: 'plugin', plugin: name, form: 'snapshot',
              sections: [{ name: 'restart', text }],
            },
          }),
        ],
      }
    }, { prepend: true })
  }

  const service: SelfRestartGuard = {
    verify: () => verifyCredential(loadState(stateDir), currentHead(repoDir), Date.now(), maxAgeMinutes),
    record: (scope, options) => {
      const head = currentHead(repoDir)
      if (head === null) throw new Error('ankh-guard: cannot record a credential outside a git repository')
      return recordCredential(stateDir, { scope, revision: head, command: options?.command ?? '' }, Date.now())
    },
    clear: () => clearCredential(stateDir, Date.now()),
    status: () => loadState(stateDir),
    checkpoint: (message) => {
      const result = commitCheckpoint(repoDir, `dsh-ankh-guard checkpoint: ${message ?? 'batch snapshot'}`)
      if (!result.ok) return result
      setCheckpoint(stateDir, { revision: result.sha, message: message ?? 'batch snapshot' }, Date.now())
      return result
    },
    reset: sha => resetToCheckpoint(repoDir, sha),
    canary: async (options) => {
      const checks: CanaryCheck[] = []
      const verdict = service.verify()
      checks.push({ name: 'verify', ok: verdict.ok, detail: verdict.reason })
      if (options?.port !== undefined) {
        const listening = await checkPort(options.port, '127.0.0.1')
        checks.push({ name: 'port', ok: listening, detail: listening ? `listening on 127.0.0.1:${options.port}` : `nothing listening on 127.0.0.1:${options.port}` })
      }
      return { ok: checks.every(c => c.ok), checks }
    },
  }
  ctx.provide('selfRestartGuard', service)
}
