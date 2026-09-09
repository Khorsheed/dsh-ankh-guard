/**
 * Pure credential/checkpoint state core for the self-restart guard.
 *
 * The guard records one "green build" credential — bound to the git HEAD it
 * was recorded on and to a freshness window — and answers `verify()` against
 * the CURRENT head and wall clock. A later fully gated boot may promote that
 * credential into a deployment proof whose exact runtime fingerprint can be
 * reused by the same-launch restart path. Framework-free: the cordis plugin,
 * the CLI, and the invariant companion all share this module.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { stateFile } from './state-files.ts'

/** A green-build credential: proof that HEAD {@link revision} passed {@link scope} at {@link recordedAt}. */
export interface GuardCredential {
  /** What passed, e.g. 'build' or 'build+test:gui'. */
  scope: string
  /** The git HEAD revision the green state was produced on. */
  revision: string
  /** Epoch milliseconds when the credential was recorded. */
  recordedAt: number
  /** The exact command that produced the green state. */
  command: string
}

/**
 * Durable proof that one exact deployment passed restart readiness + canary.
 * Digests contain no command, profile content, or credential values.
 */
export interface ProvenDeployment {
  version: 1
  provenAt: number
  credential: {
    revision: string
    recordedAt: number
    scope: string
    commandSha256: string
  }
  fingerprint: {
    version: 1
    credentialRevision: string
    harnessRevision: string
    launchSpecSha256: string
    profileSha256: string
    hostRuntimeSha256: string
  }
  fingerprintSha256: string
}

/** A pre-batch snapshot commit the guard can reset back to. */
export interface GuardCheckpoint {
  /** Commit SHA of the checkpoint. */
  revision: string
  /** Epoch milliseconds when the checkpoint was taken. */
  recordedAt: number
  /** Human description of the batch the checkpoint guards. */
  message: string
}

/** Append-only audit trail of state mutations (capped; verify is read-only). */
export interface GuardAuditEntry {
  action: 'record' | 'clear' | 'checkpoint' | 'prove-deployment'
  ts: number
  detail: string
}

/** The whole persisted state file. */
export interface GuardState {
  credential?: GuardCredential
  provenDeployment?: ProvenDeployment
  checkpoint?: GuardCheckpoint
  audit: readonly GuardAuditEntry[]
}

/** The gate's answer. */
export interface VerifyResult {
  ok: boolean
  reason: string
}

const AUDIT_CAP = 50

/** Absolute path of the state file inside a state directory. */
export function stateFilePath(stateDir: string): string {
  return stateFile(stateDir, 'guard')
}

/** A fresh, credential-less state. */
export function emptyState(): GuardState {
  return { audit: [] }
}

function isCredential(value: unknown): value is GuardCredential {
  if (typeof value !== 'object' || value === null) return false
  const c = value as GuardCredential
  return typeof c.scope === 'string' && typeof c.revision === 'string'
    && typeof c.recordedAt === 'number' && typeof c.command === 'string'
}

function isCheckpoint(value: unknown): value is GuardCheckpoint {
  if (typeof value !== 'object' || value === null) return false
  const c = value as GuardCheckpoint
  return typeof c.revision === 'string' && typeof c.recordedAt === 'number' && typeof c.message === 'string'
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isProvenDeployment(value: unknown): value is ProvenDeployment {
  if (typeof value !== 'object' || value === null) return false
  const proof = value as Partial<ProvenDeployment>
  const credential = proof.credential as Partial<ProvenDeployment['credential']> | undefined
  const fingerprint = proof.fingerprint as Partial<ProvenDeployment['fingerprint']> | undefined
  return proof.version === 1 && typeof proof.provenAt === 'number'
    && credential !== undefined
    && typeof credential.revision === 'string' && credential.revision !== ''
    && typeof credential.recordedAt === 'number'
    && typeof credential.scope === 'string'
    && isSha256(credential.commandSha256)
    && fingerprint?.version === 1
    && typeof fingerprint.credentialRevision === 'string' && fingerprint.credentialRevision !== ''
    && typeof fingerprint.harnessRevision === 'string' && fingerprint.harnessRevision !== ''
    && isSha256(fingerprint.launchSpecSha256)
    && isSha256(fingerprint.profileSha256)
    && isSha256(fingerprint.hostRuntimeSha256)
    && isSha256(proof.fingerprintSha256)
}

function isAuditEntry(value: unknown): value is GuardAuditEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as GuardAuditEntry
  return (e.action === 'record' || e.action === 'clear' || e.action === 'checkpoint' || e.action === 'prove-deployment')
    && typeof e.ts === 'number' && typeof e.detail === 'string'
}

/**
 * Read the state file; an absent file is an empty state, a malformed one is a
 * loud misconfiguration error (never silently ignored).
 * @param stateDir - directory holding the state file.
 * @returns the parsed state.
 */
export function loadState(stateDir: string): GuardState {
  try {
    const raw = readFileSync(stateFilePath(stateDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<GuardState> | null
    if (parsed === null || typeof parsed !== 'object') return emptyState()
    const audit = Array.isArray(parsed.audit) ? parsed.audit.filter(isAuditEntry) : []
    const state: GuardState = { audit }
    if (isCredential(parsed.credential)) state.credential = parsed.credential
    if (isProvenDeployment(parsed.provenDeployment)) state.provenDeployment = parsed.provenDeployment
    if (isCheckpoint(parsed.checkpoint)) state.checkpoint = parsed.checkpoint
    return state
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return emptyState()
    throw new Error(`ankh-guard: unreadable state file ${stateFilePath(stateDir)}: ${String(error)}`)
  }
}

/** Persist a state (creates the directory as needed). */
export function saveState(stateDir: string, state: GuardState): void {
  mkdirSync(stateDir, { recursive: true })
  // Atomic via tmp + rename: a crash mid-write must never leave a truncated
  // state file — a malformed one throws in loadState and fails the host's
  // boot invariant, i.e. the guard's own state would take the host down.
  const file = stateFilePath(stateDir)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, file)
}

function withAudit(state: GuardState, entry: GuardAuditEntry): GuardState {
  return { ...state, audit: [...state.audit, entry].slice(-AUDIT_CAP) }
}

/** Input for recording a credential. */
export interface RecordInput {
  scope: string
  revision: string
  command: string
}

/**
 * Record a green-build credential bound to {@link RecordInput.revision}.
 * @param stateDir - state directory.
 * @param input - scope, the git HEAD, and the command that went green.
 * @param now - epoch milliseconds (injected for deterministic tests).
 * @returns the persisted state.
 */
export function recordCredential(stateDir: string, input: RecordInput, now: number): GuardState {
  const credential: GuardCredential = { ...input, recordedAt: now }
  const state = loadState(stateDir)
  const next = withAudit(state, { action: 'record', ts: now, detail: `${input.scope} @ ${input.revision}` })
  // A new proof attempt invalidates the old deployed-runtime proof even when
  // it happens to target the same HEAD: ignored build outputs may be changing.
  const { provenDeployment: _oldProof, ...withoutOldProof } = next
  const updated: GuardState = { ...withoutOldProof, credential }
  saveState(stateDir, updated)
  return updated
}

/**
 * Drop the credential (checkpoint and audit survive).
 * @param stateDir - state directory.
 * @param now - epoch milliseconds (injected for deterministic tests).
 * @returns the persisted state.
 */
export function clearCredential(stateDir: string, now: number): GuardState {
  const state = loadState(stateDir)
  const audited = withAudit(state, { action: 'clear', ts: now, detail: 'credential cleared' })
  const updated: GuardState = { audit: audited.audit }
  if (audited.checkpoint !== undefined) updated.checkpoint = audited.checkpoint
  saveState(stateDir, updated)
  return updated
}

/** Persist a deployment proof after the watchdog has completed its canary. */
export function setProvenDeployment(stateDir: string, proof: ProvenDeployment, now: number): GuardState {
  const state = loadState(stateDir)
  const next = withAudit(state, {
    action: 'prove-deployment', ts: now,
    detail: `${proof.credential.revision} ${proof.fingerprintSha256.slice(0, 16)}`,
  })
  const updated: GuardState = { ...next, provenDeployment: proof }
  saveState(stateDir, updated)
  return updated
}

/**
 * Persist a pre-batch checkpoint commit reference.
 * @param stateDir - state directory.
 * @param input - the checkpoint commit SHA and its message.
 * @param now - epoch milliseconds (injected for deterministic tests).
 * @returns the persisted state.
 */
export function setCheckpoint(stateDir: string, input: { revision: string; message: string }, now: number): GuardState {
  const checkpoint: GuardCheckpoint = { ...input, recordedAt: now }
  const state = loadState(stateDir)
  const next = withAudit(state, { action: 'checkpoint', ts: now, detail: `${input.revision} ${input.message}` })
  const updated: GuardState = { ...next, checkpoint }
  saveState(stateDir, updated)
  return updated
}

/**
 * Answer the gate: a credential is valid only when present, recorded on the
 * CURRENT revision, and younger than {@link maxAgeMinutes}.
 * @param state - the loaded state.
 * @param currentRevision - the git HEAD of the checkout, or null when unavailable.
 * @param now - epoch milliseconds (injected for deterministic tests).
 * @param maxAgeMinutes - freshness window.
 * @param workingTreeClean - whether staged, unstaged, and untracked inputs are absent.
 * @returns ok plus a human reason either way.
 */
export function verifyCredential(
  state: GuardState,
  currentRevision: string | null,
  now: number,
  maxAgeMinutes: number,
  workingTreeClean = true,
): VerifyResult {
  const credential = state.credential
  if (credential === undefined) return { ok: false, reason: 'no green-build credential recorded' }
  if (currentRevision === null) {
    return { ok: false, reason: 'current git HEAD unavailable (not inside a git repository?)' }
  }
  if (!workingTreeClean) {
    return {
      ok: false,
      reason: 'working tree is dirty (staged, unstaged, or untracked changes exist) — commit or remove them, then rebuild and re-record',
    }
  }
  if (credential.revision !== currentRevision) {
    return {
      ok: false,
      reason: `green credential is bound to revision ${credential.revision}, but current HEAD is ${currentRevision} — the tree changed since it was recorded; rebuild and re-record`,
    }
  }
  const ageMs = now - credential.recordedAt
  const maxMs = maxAgeMinutes * 60_000
  if (ageMs > maxMs) {
    return {
      ok: false,
      reason: `green credential is stale (${Math.round(ageMs / 60_000)} min old, limit ${maxAgeMinutes} min) — rebuild and re-record`,
    }
  }
  const leftMs = Math.max(0, maxMs - ageMs)
  return {
    ok: true,
    reason: `green credential valid (${credential.scope} @ ${credential.revision}, ${Math.round(leftMs / 60_000)} min left)`,
  }
}
