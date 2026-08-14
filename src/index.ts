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
 * authorize a restart of unverified code. Checkpoints (P2) are plain commits
 * with a guard message; rollback is `git reset --hard` to the checkpoint.
 *
 * @module @khorsheed/dsh-ankh-guard
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { connect } from 'node:net'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the agent package's event merge ('agent/pre-step').
import type {} from '@deepseek-ai/dsh-agent'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRepoDir, resolveStateDir } from './defaults.ts'
import { commitCheckpoint, currentHead, resetToCheckpoint } from './git.ts'
import {
  acknowledgeRestartRecord, pendingRestartRecord, restartContextText,
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
   * How long a non-initiator root agent waits before claiming a restart record
   * whose initiator session has not resumed yet (default 60000 ms). While the
   * initiator is still present in session persistence, its own agent creation
   * is expected within this window; only after it elapses without the initiator
   * appearing does any root agent fall back and claim the record, so a slow
   * session restore never loses the report to a session that resumed first.
   */
  fallbackGraceMs?: number
}

export const Config: z<SelfRestartGuardConfig> = z.object({
  maxAgeMinutes: z.natural().min(1).default(10),
  stateDir: z.string().default(''),
  repoDir: z.string().default(''),
  reportRestartContext: z.union([z.const('followup'), z.const('step'), z.const('off')]).default('followup'),
  fallbackGraceMs: z.natural().min(1).default(60000),
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
  | { ok: true; sha: string }
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
   * Hard-reset the checkout to a checkpoint commit.
   * @param sha - the checkpoint commit to reset to.
   * @returns success or a failure reason.
   */
  reset(sha: string): { ok: boolean; error?: string }
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
  const graceMs = config.fallbackGraceMs ?? 60_000

  // Autonomous report: on agent creation (session resume after a restart),
  // queue the restart record as the next turn via `agent.followup` — the
  // official wake-the-agent seam the schedule system uses for reminders — so
  // the agent reports without any user message. Only root agents (not
  // subagents) and only once (the record is acknowledged on followup). The
  // report returns to the session that scheduled the exit (`record.initiator`,
  // recorded by `schedule-exit` from $DSH_SESSION_ID).
  //
  // Session restore after a restart is asynchronous and ordered, so a
  // non-initiator root agent can fire `agent/created` before the initiator's
  // session has resumed. Two gates keep the record from racing to the wrong
  // session: while the initiator's agent is live, only it may claim; when it
  // is not live yet but its session still exists in persistence, a grace timer
  // (Config `fallbackGraceMs`, default 60000 ms) waits for its resume before
  // any root agent falls back — a slow restore never loses the report to a
  // session that resumed first. The timer is idempotent (one pending timer per
  // record), validates the record identity on fire (the same exitAt, still
  // unreported), and refuses to ack when no root agent is live. An initiator
  // that is absent from persistence entirely (deleted, or a subagent that
  // never resumes) falls back immediately.
  if (reportMode === 'followup') {
    // One pending grace timer per record; cleared by ctx.effect disposal.
    let graceTimer: NodeJS.Timeout | null = null
    let graceRecord: RestartRecord | null = null
    ctx.effect(() => () => {
      if (graceTimer !== null) clearTimeout(graceTimer)
      graceTimer = null
      graceRecord = null
    })

    const claim = (agent: unknown, record: RestartRecord): void => {
      const canaryPending = existsSync(join(stateDir, 'restart-requested.json'))
      const text = restartContextText(record, canaryPending)
      if (text === '') return
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: 'restart', text }] },
      })
      // Deliver before acknowledging: an ack on an undelivered followup would
      // lose the report (the record is already marked reported and no one
      // re-injects). A followup that throws keeps the record pending for the
      // next creation instead.
      ;(agent as { followup: (message: ReturnType<typeof createUserMessage>) => void }).followup(message)
      acknowledgeRestartRecord(stateDir, record, Date.now())
    }

    const armGraceTimer = (record: RestartRecord, graceMs: number): void => {
      if (graceTimer !== null) return // one pending timer per record
      graceRecord = record
      graceTimer = setTimeout(() => {
        graceTimer = null
        const pending = graceRecord
        graceRecord = null
        // Identity check: only the exact record that armed this timer may be
        // claimed, and only while it is still unreported — a second restart
        // (new exitAt) or an earlier claim must not be acked by this timer.
        const current = pendingRestartRecord(stateDir)
        if (current === null || pending === null || current.exitAt !== pending.exitAt) {
          // The record was replaced while this timer was pending (second
          // restart). The new record never armed a timer of its own (the
          // singleton guard rejected it), so re-arm it here — otherwise its
          // fallback would never fire without another creation event.
          if (current !== null && pending !== null && current.exitAt !== pending.exitAt) {
            armGraceTimer(current, graceMs)
          }
          return
        }
        const liveIds = new Set<string>(ctx.agents.list().map(live => live.id))
        if (pending.initiator !== undefined && liveIds.has(pending.initiator)) return // initiator resumed — its own creation claims it
        const roots = ctx.agents.roots()
        if (roots.length === 0) return // no live root agent — keep the record for the next creation
        claim(roots[0], pending)
      }, graceMs)
    }

    ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return
      const record = pendingRestartRecord(stateDir)
      if (record === null) return
      if (record.initiator !== undefined) {
        const liveIds = new Set<string>(ctx.agents.list().map(live => live.id))
        if (liveIds.has(record.initiator)) {
          if (agent.id !== record.initiator) return
        } else {
          // Initiator not live yet. If its session still exists in
          // persistence, wait for its resume within the grace window;
          // otherwise (deleted, or a never-resuming subagent) fall back now.
          const persistence = ctx.get('sessionPersistence') as
            | { list(signal?: AbortSignal): Promise<Array<{ id: string }>> }
            | undefined
          if (persistence !== undefined) {
            void persistence.list().then((sessions) => {
              // Identity re-check: while list() was in flight the initiator
              // may have resumed and claimed the record, or a second restart
              // replaced it. A stale resolution must not double-ack or claim
              // a record that is already handled — same rule as the timer.
              const current = pendingRestartRecord(stateDir)
              if (current === null || current.exitAt !== record.exitAt) return
              const initiator = record.initiator
              if (initiator !== undefined && !sessions.some(session => session.id === initiator)) {
                const liveNow = new Set<string>(ctx.agents.list().map(live => live.id))
                if (!liveNow.has(initiator)) {
                  const roots = ctx.agents.roots()
                  if (roots.length > 0) claim(roots[0], record)
                }
              } else {
                armGraceTimer(record, graceMs)
              }
            }).catch(() => {
              // Persistence listing failed: fall back to the grace window alone.
              armGraceTimer(record, graceMs)
            })
            return
          }
          // No persistence service: rely on the grace window alone.
          armGraceTimer(record, graceMs)
          return
        }
      }
      claim(agent, record)
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
