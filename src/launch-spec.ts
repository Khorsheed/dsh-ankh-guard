/**
 * Durable launch-configuration cutovers.
 *
 * A launch change is not a repository rollback: the command, home, credential
 * repository, host root, profile, port, readiness handoff, and recovery choice
 * move as one unit. The selected side lives in launch-spec.json (one atomic
 * write); the redacted,
 * append-only-ish operational receipt lives in launch-cutover.json. The full
 * commands never enter the receipt because a launch command may carry secret
 * environment values.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { stateFile } from './state-files.ts'
import type { TransitionReference } from './transition.ts'

export type CutoverRecoveryPolicy = 'restore-previous' | 'wait-for-user'
export type BrowserHandoffPolicy = 'required' | 'off'
export type LaunchRole = 'target' | 'previous'
export type CutoverControlAction = 'abort' | 'restore-previous'

export type PreflightSurface = 'source' | 'built'

/**
 * Immutable execution binding for composition preflight. The runner and host
 * installation are explicit because the guarded checkout and the successor's
 * npm toolchain may be different module graphs.
 */
export interface LaunchPreflightSpec {
  version: 1
  surface: PreflightSurface
  runnerExecutable: string
  runnerRuntimeArgs: string[]
  runnerPath: string
  runnerSha256: string
  /** package.json used as createRequire()'s anchor for a built successor. */
  installAnchor: string
  installAnchorSha256: string
  hostPackageVersion: string
  /** Full digest of the launch command this preflight contract approves. */
  targetCommandSha256: string
  /** One-shot candidate command that validates the target CLI/argv contract. */
  candidateProbeCommand?: string
  candidateProbeSha256?: string
  /** Guard binds and runs this caller assertion; it does not derive the probe. */
  candidateProbeProvenance?: 'caller-supplied'
}

/** Everything needed to launch one supervised instance. The state directory is the transaction anchor. */
export interface LaunchSpec {
  version: 1
  command: string
  port: number
  home: string
  /** Repository whose HEAD is bound to the guard credential and rollback. */
  credentialRepo: string
  /** dsh host checkout used by preflight and exported as DSH_HARNESS. */
  harnessRoot: string
  profile: string
  /** Absent only on launch state written before execution binding existed. */
  preflight?: LaunchPreflightSpec
}

export interface StableLaunchState {
  version: 1
  mode: 'stable'
  active: LaunchSpec
}

export interface CutoverLaunchState {
  version: 1
  mode: 'cutover'
  cutoverId: string
  selected: LaunchRole
  previous: LaunchSpec
  target: LaunchSpec
  /** Immutable, cutover-scoped filesystem transition prepared before takeover. */
  transition?: TransitionReference
}

export type LaunchState = StableLaunchState | CutoverLaunchState

export type CutoverPhase =
  | 'prepared'
  | 'supervisor-starting'
  | 'supervisor-ready'
  | 'target-starting'
  | 'target-retrying'
  | 'restoring'
  | 'ready'
  | 'restored'
  | 'awaiting-user'
  | 'prepare-failed'

export interface LaunchSpecSummary {
  commandSha256: string
  port: number
  home: string
  credentialRepo: string
  harnessRoot: string
  profile: string
  preflight?: {
    surface: PreflightSurface
    runnerExecutable: string
    runnerRuntimeArgs: string[]
    runnerPath: string
    runnerSha256: string
    installAnchor: string
    installAnchorSha256: string
    hostPackageVersion: string
    targetCommandSha256: string
    candidateProbeSha256?: string
    candidateProbeProvenance?: 'caller-supplied'
  }
}

export interface CutoverAttempt {
  role: LaunchRole
  number: number
  childPid: number
  childStartToken?: string
  startedAt: number
  outcome?: 'failed' | 'ready'
  detail?: string
}

/** PID identity proof safe to persist in the redacted operational receipt. */
export interface CutoverProcessOwnership {
  childPid: number
  childStartToken: string
  listenerPid: number
  listenerStartToken: string
}

export interface CutoverBrowserHandoff {
  required: boolean
  status: 'pending' | 'acknowledged' | 'fallback-opened' | 'off' | 'failed' | 'not-required'
  channel?: 'original-tab' | 'fallback-tab'
  authentication?: 'existing-cookie' | 'launch-url'
  authority?: string
  acknowledgedAt?: number
}

export interface LaunchCutoverReceipt {
  version: 1
  id: string
  phase: CutoverPhase
  preparedAt: number
  updatedAt: number
  initiator?: string
  previous: LaunchSpecSummary
  target: LaunchSpecSummary
  /** Redacted transition evidence; the plan paths live only in launch state. */
  transition?: {
    planSha256: string
    operationCount: number
    phase: 'pending' | 'applied' | 'rolled-back' | 'failed'
    failureOperation?: 'apply' | 'rollback'
    detail?: string
  }
  supervisor: {
    previousPid: number
    previousStartToken: string
    targetDriverPid?: number
    targetDriverStartToken?: string
    targetPid?: number
    targetStartToken?: string
    previousRetirement?: 'yielded' | 'identity-gone' | 'forced'
  }
  child: {
    previousPid?: number
    targetPid?: number
    restoredPid?: number
  }
  ownership: {
    previous: CutoverProcessOwnership
    target?: CutoverProcessOwnership
    restored?: CutoverProcessOwnership
  }
  readiness?: {
    role: LaunchRole
    childPid: number
    listenerPid: number
    stableWindowMs: number
    retryCount: number
  }
  authentication: {
    transportStatus?: number
    launchUrlObserved?: boolean
    exchangeStatus?: number
    authenticatedStatus?: number
    /** Compatibility summary; detailed browser evidence lives in browserHandoff. */
    browserHandoff: CutoverBrowserHandoff['status']
  }
  /** Browser acknowledgement is independent of server transport/readiness/canary. */
  browserHandoff: CutoverBrowserHandoff
  /** Candidate and composition checks completed before the previous host stopped. */
  preflight?: {
    surface: PreflightSurface
    runnerExecutable: string
    runnerRuntimeArgs: string[]
    runnerPath: string
    runnerSha256: string
    installAnchor: string
    installAnchorSha256: string
    hostPackageVersion: string
    targetCommandSha256: string
    candidateProbeSha256: string
    candidateProbeProvenance: 'caller-supplied'
    candidateProbe: 'pass'
    composition: 'pass'
  }
  /** Target evidence is retained even if recovery later becomes terminal. */
  targetValidation?: {
    readiness?: LaunchCutoverReceipt['readiness']
    canary?: { outcome: 'pass' | 'fail'; detail?: string }
  }
  canary?: { outcome: 'pass' | 'fail'; detail?: string }
  attempts: CutoverAttempt[]
  failureCount: { target: number; previous: number }
  recovery: {
    policy: CutoverRecoveryPolicy
    result: 'pending' | 'not-needed' | 'restored' | 'waiting-for-user' | 'prepare-failed'
    detail?: string
    validation?: {
      readiness?: LaunchCutoverReceipt['readiness']
      canary?: { outcome: 'pass' | 'fail' | 'skipped'; detail?: string }
    }
  }
  events: Array<{ at: number; kind: string; detail?: string }>
}

export interface CutoverControlRequest {
  version: 1
  cutoverId: string
  action: CutoverControlAction
  requestedAt: number
}

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  // rename over an older file keeps the tmp inode's mode on POSIX. chmod is a
  // belt-and-suspenders guarantee for state dirs copied from older installs.
  try { chmodSync(file, 0o600) } catch { /* best effort on non-POSIX filesystems */ }
}

function isLaunchSpec(value: unknown): value is LaunchSpec {
  if (typeof value !== 'object' || value === null) return false
  const spec = value as Partial<LaunchSpec>
  return spec.version === 1
    && typeof spec.command === 'string' && spec.command !== ''
    && Number.isInteger(spec.port) && (spec.port ?? 0) > 0 && (spec.port ?? 0) <= 65535
    && typeof spec.home === 'string' && spec.home !== ''
    && typeof spec.credentialRepo === 'string' && spec.credentialRepo !== ''
    && typeof spec.harnessRoot === 'string' && spec.harnessRoot !== ''
    && typeof spec.profile === 'string' && spec.profile !== ''
    && (spec.preflight === undefined || isLaunchPreflightSpec(spec.preflight))
}

function isLaunchPreflightSpec(value: unknown): value is LaunchPreflightSpec {
  if (typeof value !== 'object' || value === null) return false
  const spec = value as Partial<LaunchPreflightSpec>
  return spec.version === 1
    && (spec.surface === 'source' || spec.surface === 'built')
    && typeof spec.runnerExecutable === 'string' && spec.runnerExecutable !== ''
    && Array.isArray(spec.runnerRuntimeArgs) && spec.runnerRuntimeArgs.every(arg => typeof arg === 'string')
    && typeof spec.runnerPath === 'string' && spec.runnerPath !== ''
    && typeof spec.runnerSha256 === 'string' && /^[a-f0-9]{64}$/.test(spec.runnerSha256)
    && typeof spec.installAnchor === 'string' && spec.installAnchor !== ''
    && typeof spec.installAnchorSha256 === 'string' && /^[a-f0-9]{64}$/.test(spec.installAnchorSha256)
    && typeof spec.hostPackageVersion === 'string' && spec.hostPackageVersion !== ''
    && typeof spec.targetCommandSha256 === 'string' && /^[a-f0-9]{64}$/.test(spec.targetCommandSha256)
    && (spec.candidateProbeCommand === undefined
      ? spec.candidateProbeSha256 === undefined && spec.candidateProbeProvenance === undefined
      : typeof spec.candidateProbeCommand === 'string' && spec.candidateProbeCommand !== ''
        && typeof spec.candidateProbeSha256 === 'string' && /^[a-f0-9]{64}$/.test(spec.candidateProbeSha256)
        && (spec.candidateProbeProvenance === undefined || spec.candidateProbeProvenance === 'caller-supplied'))
}

export function commandSha256(command: string): string {
  return createHash('sha256').update(command).digest('hex')
}

function isTransitionReference(value: unknown): value is TransitionReference {
  if (typeof value !== 'object' || value === null) return false
  const reference = value as Partial<TransitionReference>
  return reference.version === 1
    && typeof reference.planPath === 'string' && reference.planPath !== ''
    && typeof reference.planSha256 === 'string' && /^[a-f0-9]{64}$/.test(reference.planSha256)
    && Number.isInteger(reference.operationCount) && (reference.operationCount ?? 0) > 0
}

/** Read the selected launch state, or null for a deployment predating this protocol. */
export function readLaunchState(stateDir: string): LaunchState | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(stateDir, 'launchSpec'), 'utf8')) as Partial<LaunchState>
    if (parsed.version !== 1) return null
    if (parsed.mode === 'stable' && isLaunchSpec(parsed.active)) return parsed as StableLaunchState
    if (parsed.mode === 'cutover' && typeof parsed.cutoverId === 'string'
      && (parsed.selected === 'target' || parsed.selected === 'previous')
      && isLaunchSpec(parsed.previous) && isLaunchSpec(parsed.target)
      && (parsed.transition === undefined || isTransitionReference(parsed.transition))) {
      return parsed as CutoverLaunchState
    }
    return null
  } catch {
    return null
  }
}

/** The exact spec a newly starting supervisor must honor. */
export function selectedLaunchSpec(state: LaunchState): LaunchSpec {
  if (state.mode === 'stable') return state.active
  return state[state.selected]
}

/** Persist an ordinary, non-transactional active spec. */
export function writeStableLaunchSpec(stateDir: string, spec: LaunchSpec, ifAbsent = false): boolean {
  if (!isLaunchSpec(spec)) throw new Error('invalid launch specification')
  if (ifAbsent && readLaunchState(stateDir) !== null) return false
  atomicWriteJson(stateFile(stateDir, 'launchSpec'), { version: 1, mode: 'stable', active: spec } satisfies StableLaunchState)
  return true
}

export function summarizeLaunchSpec(spec: LaunchSpec): LaunchSpecSummary {
  return {
    commandSha256: commandSha256(spec.command).slice(0, 16),
    port: spec.port,
    home: spec.home,
    credentialRepo: spec.credentialRepo,
    harnessRoot: spec.harnessRoot,
    profile: spec.profile,
    ...(spec.preflight === undefined ? {} : {
      preflight: {
        surface: spec.preflight.surface,
        runnerExecutable: spec.preflight.runnerExecutable,
        runnerRuntimeArgs: spec.preflight.runnerRuntimeArgs,
        runnerPath: spec.preflight.runnerPath,
        runnerSha256: spec.preflight.runnerSha256,
        installAnchor: spec.preflight.installAnchor,
        installAnchorSha256: spec.preflight.installAnchorSha256,
        hostPackageVersion: spec.preflight.hostPackageVersion,
        targetCommandSha256: spec.preflight.targetCommandSha256,
        ...(spec.preflight.candidateProbeSha256 === undefined
          ? {} : {
              candidateProbeSha256: spec.preflight.candidateProbeSha256,
              candidateProbeProvenance: 'caller-supplied' as const,
            }),
      },
    }),
  }
}

/** Safe operator view: preserve topology and selection without printing commands. */
export function summarizeLaunchState(state: LaunchState | null): unknown {
  if (state === null) return null
  if (state.mode === 'stable') {
    return { version: state.version, mode: state.mode, active: summarizeLaunchSpec(state.active) }
  }
  return {
    version: state.version,
    mode: state.mode,
    cutoverId: state.cutoverId,
    selected: state.selected,
    previous: summarizeLaunchSpec(state.previous),
    target: summarizeLaunchSpec(state.target),
    ...(state.transition === undefined ? {} : {
      transition: {
        planSha256: state.transition.planSha256,
        operationCount: state.transition.operationCount,
      },
    }),
  }
}

/** Read the durable receipt, or null when absent/malformed. */
export function readCutoverReceipt(stateDir: string): LaunchCutoverReceipt | null {
  try {
    const receipt = JSON.parse(readFileSync(stateFile(stateDir, 'launchCutover'), 'utf8')) as LaunchCutoverReceipt
    if (receipt.version !== 1 || typeof receipt.id !== 'string' || !Array.isArray(receipt.events)) return null
    // Rolling migration from receipts written before browser acknowledgement
    // became its own evidence plane. A legacy "accepted" means only that the
    // opener returned success; never relabel it as a page acknowledgement.
    if (receipt.browserHandoff === undefined) {
      const legacy = receipt.authentication?.browserHandoff as string | undefined
      const status: CutoverBrowserHandoff['status'] = legacy === 'off' ? 'off'
        : legacy === 'not-required' ? 'not-required'
          : legacy === 'failed' ? 'failed'
            : legacy === 'accepted' ? 'fallback-opened' : 'pending'
      receipt.browserHandoff = {
        required: status !== 'off',
        status,
      }
      if (legacy === 'accepted') receipt.authentication.browserHandoff = status
    }
    // Rolling migration for an in-flight receipt from the single canary
    // field era. Attribute it only when the current readiness role makes the
    // provenance unambiguous; new recovery receipts never reuse that field.
    if (receipt.readiness?.role === 'target') {
      receipt.targetValidation ??= {}
      receipt.targetValidation.readiness ??= receipt.readiness
      if (receipt.targetValidation.canary === undefined && receipt.canary !== undefined) {
        receipt.targetValidation.canary = receipt.canary
      }
    } else if (receipt.readiness?.role === 'previous') {
      receipt.recovery.validation ??= {}
      receipt.recovery.validation.readiness ??= receipt.readiness
      if (receipt.recovery.validation.canary === undefined && receipt.canary !== undefined) {
        receipt.recovery.validation.canary = receipt.canary
        delete receipt.canary
      }
    }
    return receipt
  } catch {
    return null
  }
}

/** Persist an operator control request for the current watchdog to consume. */
export function writeCutoverControl(
  stateDir: string, cutoverId: string, action: CutoverControlAction, now: number,
): CutoverControlRequest {
  const active = activeCutover(stateDir)
  if (active === null || active.receipt.id !== cutoverId) throw new Error(`cutover ${cutoverId} is not active`)
  const request: CutoverControlRequest = { version: 1, cutoverId, action, requestedAt: now }
  // Separate monotonic markers remove the read-then-overwrite race between
  // independent operator sessions. Once restore exists, no later abort write
  // can downgrade the durable effective action.
  if (action === 'restore-previous') {
    atomicWriteJson(stateFile(stateDir, 'cutoverRestorePrevious'), request)
  } else {
    const existing = readControlFile(stateFile(stateDir, 'cutoverRestorePrevious'))
    if (existing?.cutoverId === cutoverId) return existing
    atomicWriteJson(stateFile(stateDir, 'cutoverAbort'), request)
  }
  const effective = readCutoverControl(stateDir)
  return effective?.cutoverId === cutoverId ? effective : request
}

function readControlFile(file: string): CutoverControlRequest | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<CutoverControlRequest>
    if (value.version !== 1 || typeof value.cutoverId !== 'string'
      || (value.action !== 'abort' && value.action !== 'restore-previous')
      || typeof value.requestedAt !== 'number') return null
    return value as CutoverControlRequest
  } catch {
    return null
  }
}

export function readCutoverControl(stateDir: string): CutoverControlRequest | null {
  const restore = readControlFile(stateFile(stateDir, 'cutoverRestorePrevious'))
  if (restore?.action === 'restore-previous') return restore
  const legacy = readControlFile(stateFile(stateDir, 'cutoverControl'))
  if (legacy?.action === 'restore-previous') return legacy
  return readControlFile(stateFile(stateDir, 'cutoverAbort')) ?? legacy
}

export function clearCutoverControl(stateDir: string, cutoverId: string): void {
  for (const role of ['cutoverRestorePrevious', 'cutoverAbort', 'cutoverControl'] as const) {
    const file = stateFile(stateDir, role)
    if (readControlFile(file)?.cutoverId === cutoverId) rmSync(file, { force: true })
  }
}

/**
 * Prepare one cutover. The receipt lands first; the single launch-state rename
 * is the commit point selecting target. A crash before that rename leaves the
 * previous stable state authoritative and the old supervisor untouched.
 */
export function prepareLaunchCutover(stateDir: string, input: {
  id: string
  previous: LaunchSpec
  target: LaunchSpec
  recoveryPolicy: CutoverRecoveryPolicy
  browserHandoff: BrowserHandoffPolicy
  previousSupervisorPid: number
  previousSupervisorStartToken: string
  previousOwnership: CutoverProcessOwnership
  transition?: TransitionReference
  initiator?: string
  now: number
}): LaunchCutoverReceipt {
  if (!isLaunchSpec(input.previous) || !isLaunchSpec(input.target)) throw new Error('invalid launch specification')
  if (input.id === '') throw new Error('cutover id is required')
  if (!Number.isInteger(input.previousSupervisorPid) || input.previousSupervisorPid <= 0) throw new Error('invalid previous supervisor pid')
  if (input.previousSupervisorStartToken === '') throw new Error('previous supervisor start identity is required')
  for (const [label, value] of Object.entries({
    previousChildPid: input.previousOwnership.childPid,
    previousListenerPid: input.previousOwnership.listenerPid,
  })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid ${label}`)
  }
  if (input.previousOwnership.childStartToken === '' || input.previousOwnership.listenerStartToken === '') {
    throw new Error('previous child/listener start identity is required')
  }
  if (input.previous.port !== input.target.port) {
    throw new Error('online cutover requires previous and target to use the same port')
  }
  if (input.transition !== undefined) {
    if (!isTransitionReference(input.transition)) throw new Error('invalid transition reference')
    if (input.previous.home !== input.target.home) {
      throw new Error('filesystem transition requires previous and target to share one home')
    }
  }
  // A terminal transaction normally clears these. Remove any abandoned
  // marker before creating a new ID so precedence is scoped to this cutover.
  for (const role of ['cutoverRestorePrevious', 'cutoverAbort', 'cutoverControl'] as const) {
    rmSync(stateFile(stateDir, role), { force: true })
  }
  rmSync(stateFile(stateDir, 'browserHandoffRequest'), { force: true })
  rmSync(stateFile(stateDir, 'browserHandoffAck'), { force: true })
  const receipt: LaunchCutoverReceipt = {
    version: 1,
    id: input.id,
    phase: 'prepared',
    preparedAt: input.now,
    updatedAt: input.now,
    ...(input.initiator !== undefined && input.initiator !== '' ? { initiator: input.initiator } : {}),
    previous: summarizeLaunchSpec(input.previous),
    target: summarizeLaunchSpec(input.target),
    ...(input.transition === undefined ? {} : {
      transition: {
        planSha256: input.transition.planSha256,
        operationCount: input.transition.operationCount,
        phase: 'pending' as const,
      },
    }),
    supervisor: {
      previousPid: input.previousSupervisorPid,
      previousStartToken: input.previousSupervisorStartToken,
    },
    child: { previousPid: input.previousOwnership.childPid },
    ownership: { previous: input.previousOwnership },
    authentication: {
      browserHandoff: input.browserHandoff === 'required' ? 'pending' : 'off',
    },
    browserHandoff: {
      required: input.browserHandoff === 'required',
      status: input.browserHandoff === 'required' ? 'pending' : 'off',
    },
    ...(input.target.preflight?.candidateProbeSha256 === undefined ? {} : {
      preflight: {
        surface: input.target.preflight.surface,
        runnerExecutable: input.target.preflight.runnerExecutable,
        runnerRuntimeArgs: input.target.preflight.runnerRuntimeArgs,
        runnerPath: input.target.preflight.runnerPath,
        runnerSha256: input.target.preflight.runnerSha256,
        installAnchor: input.target.preflight.installAnchor,
        installAnchorSha256: input.target.preflight.installAnchorSha256,
        hostPackageVersion: input.target.preflight.hostPackageVersion,
        targetCommandSha256: input.target.preflight.targetCommandSha256,
        candidateProbeSha256: input.target.preflight.candidateProbeSha256,
        candidateProbeProvenance: 'caller-supplied' as const,
        candidateProbe: 'pass' as const,
        composition: 'pass' as const,
      },
    }),
    attempts: [],
    failureCount: { target: 0, previous: 0 },
    recovery: { policy: input.recoveryPolicy, result: 'pending' },
    events: [{ at: input.now, kind: 'prepared' }],
  }
  atomicWriteJson(stateFile(stateDir, 'launchCutover'), receipt)
  atomicWriteJson(stateFile(stateDir, 'launchSpec'), {
    version: 1,
    mode: 'cutover',
    cutoverId: input.id,
    selected: 'target',
    previous: input.previous,
    target: input.target,
    ...(input.transition === undefined ? {} : { transition: input.transition }),
  } satisfies CutoverLaunchState)
  return receipt
}

function updateRestartRecord(stateDir: string, receipt: LaunchCutoverReceipt, outcome: 'target-ready' | 'restored' | 'awaiting-user' | 'prepare-failed'): void {
  const error = outcome === 'restored'
    ? 'launch cutover failed; the previous complete launch specification was restored'
    : outcome === 'awaiting-user'
      ? 'launch cutover failed; recovery policy requires waiting for user action'
      : outcome === 'prepare-failed'
        ? 'launch cutover was not started; the previous launch specification remains active'
        : undefined
  atomicWriteJson(stateFile(stateDir, 'lastRestart'), {
    exitAt: Date.now(),
    ...(receipt.initiator !== undefined ? { initiator: receipt.initiator } : {}),
    ...(receipt.child.previousPid !== undefined ? { pid: receipt.child.previousPid } : {}),
    ...(error !== undefined ? { error } : {}),
    cutover: {
      id: receipt.id,
      outcome,
      receipt: stateFile(stateDir, 'launchCutover'),
    },
  })
}

function requireReceipt(stateDir: string, id: string): LaunchCutoverReceipt {
  const receipt = readCutoverReceipt(stateDir)
  if (receipt === null || receipt.id !== id) throw new Error(`cutover receipt ${id} is not active`)
  return receipt
}

function appendEvent(receipt: LaunchCutoverReceipt, kind: string, detail: string | undefined, now: number): void {
  receipt.updatedAt = now
  receipt.events = [...receipt.events, { at: now, kind, ...(detail !== undefined && detail !== '' ? { detail } : {}) }].slice(-100)
}

/**
 * Apply one watchdog event. Arguments are deliberately credential-free; the
 * launch URL itself never crosses this boundary or lands in the receipt.
 */
export function recordCutoverEvent(stateDir: string, id: string, kind: string, args: readonly string[], now: number): LaunchCutoverReceipt {
  const receipt = requireReceipt(stateDir, id)
  const numberAt = (index: number, label: string): number => {
    const value = Number(args[index])
    if (!Number.isInteger(value) || value < 0) throw new Error(`${kind}: invalid ${label}`)
    return value
  }
  const pidAt = (index: number, label: string): number => {
    const value = numberAt(index, label)
    if (value === 0) throw new Error(`${kind}: invalid ${label}`)
    return value
  }
  let terminal: 'target-ready' | 'restored' | 'awaiting-user' | 'prepare-failed' | undefined
  let stableSpec: LaunchSpec | undefined
  switch (kind) {
    case 'driver-started':
      receipt.phase = 'supervisor-starting'
      receipt.supervisor.targetDriverPid = pidAt(0, 'driver pid')
      if (args[1] === undefined || args[1] === '') {
        throw new Error('driver-started: driver start identity is required')
      }
      receipt.supervisor.targetDriverStartToken = args[1]
      break
    case 'supervisor-ready':
      receipt.phase = 'supervisor-ready'
      receipt.supervisor.targetPid = pidAt(0, 'supervisor pid')
      if (args[1] === undefined || args[1] === '') {
        throw new Error('supervisor-ready: supervisor start identity is required')
      }
      receipt.supervisor.targetStartToken = args[1]
      break
    case 'previous-supervisor-retired': {
      const outcome = args[0]
      if (outcome !== 'yielded' && outcome !== 'identity-gone' && outcome !== 'forced') {
        throw new Error('previous-supervisor-retired: invalid outcome')
      }
      receipt.supervisor.previousRetirement = outcome
      break
    }
    case 'child-started': {
      const role = args[0]
      if (role !== 'target' && role !== 'previous') throw new Error('child-started: invalid role')
      const attempt = numberAt(1, 'attempt')
      const childPid = pidAt(2, 'child pid')
      const childStartToken = args[3]
      if (childStartToken === undefined || childStartToken === '') throw new Error('child-started: child start identity is required')
      if (role === 'target' && receipt.transition !== undefined && receipt.transition.phase !== 'applied') {
        throw new Error('child-started: target transition has not been applied')
      }
      if (role === 'previous' && receipt.transition !== undefined && receipt.transition.phase !== 'rolled-back') {
        throw new Error('child-started: previous transition has not been rolled back')
      }
      receipt.phase = role === 'target' ? 'target-starting' : 'restoring'
      if (role === 'target') receipt.child.targetPid = childPid
      else receipt.child.restoredPid = childPid
      // Authentication, handoff, readiness, and canary belong to this exact
      // process identity. A retry must never inherit a previous process's
      // accepted launch URL or terminal proof.
      receipt.authentication = {
        browserHandoff: receipt.authentication.browserHandoff === 'off' ? 'off' : 'pending',
      }
      receipt.browserHandoff = {
        required: receipt.browserHandoff.required,
        status: receipt.browserHandoff.required ? 'pending' : 'off',
      }
      rmSync(stateFile(stateDir, 'browserHandoffAck'), { force: true })
      delete receipt.readiness
      delete receipt.canary
      if (role === 'target') receipt.targetValidation = {}
      else receipt.recovery.validation = {}
      receipt.attempts.push({ role, number: attempt, childPid, childStartToken, startedAt: now })
      break
    }
    case 'ownership-stable': {
      const role = args[0]
      if (role !== 'target' && role !== 'previous') throw new Error('ownership-stable: invalid role')
      const ownership: CutoverProcessOwnership = {
        childPid: pidAt(1, 'child pid'),
        childStartToken: args[2] ?? '',
        listenerPid: pidAt(3, 'listener pid'),
        listenerStartToken: args[4] ?? '',
      }
      if (ownership.childStartToken === '' || ownership.listenerStartToken === '') {
        throw new Error('ownership-stable: child/listener start identity is required')
      }
      const stableWindowMs = numberAt(5, 'stable window')
      const retryCount = numberAt(6, 'retry count')
      if (stableWindowMs < 1 || retryCount !== 0) throw new Error('ownership-stable: stable window must be positive and retry count must be zero')
      const attempt = [...receipt.attempts].reverse().find(candidate => candidate.role === role && candidate.outcome === undefined)
      if (attempt === undefined || attempt.childPid !== ownership.childPid
        || attempt.childStartToken !== ownership.childStartToken) {
        throw new Error(`ownership-stable: ${role} identity does not match the active attempt`)
      }
      if (role === 'target') receipt.ownership.target = ownership
      else receipt.ownership.restored = ownership
      receipt.readiness = {
        role, childPid: ownership.childPid, listenerPid: ownership.listenerPid,
        stableWindowMs, retryCount,
      }
      if (role === 'target') {
        receipt.targetValidation ??= {}
        receipt.targetValidation.readiness = receipt.readiness
      } else {
        receipt.recovery.validation ??= {}
        receipt.recovery.validation.readiness = receipt.readiness
      }
      break
    }
    case 'transport':
      receipt.authentication.transportStatus = numberAt(0, 'HTTP status')
      break
    case 'launch-url':
      receipt.authentication.launchUrlObserved = true
      break
    case 'auth-exchange':
      receipt.authentication.exchangeStatus = numberAt(0, 'HTTP status')
      break
    case 'authenticated':
      receipt.authentication.authenticatedStatus = numberAt(0, 'HTTP status')
      break
    case 'browser-handoff': {
      const outcome = args[0]
      if (outcome !== 'acknowledged' && outcome !== 'off' && outcome !== 'failed') throw new Error('browser-handoff: invalid outcome')
      if (outcome === 'acknowledged') {
        const channel = args[1]
        const authentication = args[2]
        const authority = args[3]
        if ((channel !== 'original-tab' && channel !== 'fallback-tab')
          || (authentication !== 'existing-cookie' && authentication !== 'launch-url')
          || authority === undefined || authority === '') {
          throw new Error('browser-handoff: invalid acknowledgement evidence')
        }
        if (receipt.readiness === undefined) throw new Error('browser-handoff: server readiness is not proven')
        if (receipt.readiness.role === 'target' && receipt.targetValidation?.canary?.outcome !== 'pass') {
          throw new Error('browser-handoff: target canary has not passed')
        }
        if (receipt.readiness.role === 'previous' && receipt.recovery.validation?.canary === undefined) {
          throw new Error('browser-handoff: restored-previous canary has not settled')
        }
        receipt.browserHandoff = {
          required: true,
          status: 'acknowledged',
          channel,
          authentication,
          authority,
          acknowledgedAt: now,
        }
      } else {
        receipt.browserHandoff = { required: outcome !== 'off', status: outcome }
      }
      receipt.authentication.browserHandoff = receipt.browserHandoff.status
      break
    }
    case 'browser-fallback-opened':
      if (!receipt.browserHandoff.required) throw new Error('browser-fallback-opened: handoff is disabled')
      if (receipt.readiness?.role === 'target' && receipt.targetValidation?.canary?.outcome !== 'pass') {
        throw new Error('browser-fallback-opened: target canary has not passed')
      }
      if (receipt.readiness?.role === 'previous' && receipt.recovery.validation?.canary === undefined) {
        throw new Error('browser-fallback-opened: restored-previous canary has not settled')
      }
      receipt.browserHandoff = { required: true, status: 'fallback-opened' }
      receipt.authentication.browserHandoff = 'fallback-opened'
      break
    case 'control-requested': {
      const action = args[0]
      if (action !== 'abort' && action !== 'restore-previous') throw new Error('control-requested: invalid action')
      receipt.recovery.detail = action === 'restore-previous'
        ? 'operator explicitly requested restoration of the previous complete launch specification'
        : `operator aborted the cutover; applying pre-approved ${receipt.recovery.policy} policy`
      break
    }
    case 'attempt-failed': {
      const role = args[0]
      if (role !== 'target' && role !== 'previous') throw new Error('attempt-failed: invalid role')
      const attempt = numberAt(1, 'attempt')
      const detail = args.slice(2).join(' ')
      const found = [...receipt.attempts].reverse().find(candidate => candidate.role === role && candidate.number === attempt)
      if (found !== undefined) {
        found.outcome = 'failed'
        if (detail !== '') found.detail = detail
      }
      receipt.failureCount ??= { target: 0, previous: 0 }
      receipt.failureCount[role] += 1
      receipt.phase = role === 'target' ? 'target-retrying' : 'restoring'
      receipt.recovery.detail = detail
      break
    }
    case 'restoring':
      if (receipt.transition !== undefined && receipt.transition.phase !== 'rolled-back') {
        throw new Error('restoring: filesystem transition has not been rolled back')
      }
      receipt.phase = 'restoring'
      receipt.recovery.detail = args.join(' ')
      // Authentication belongs to one concrete launch attempt. Do not let a
      // rejected target's launch URL/handoff satisfy (or block) the restored
      // previous child. Attempts retain the target failure history; this
      // summary is reset to describe the selected recovery side.
      receipt.authentication = {
        browserHandoff: receipt.authentication.browserHandoff === 'off' ? 'off' : 'pending',
      }
      receipt.browserHandoff = {
        required: receipt.browserHandoff.required,
        status: receipt.browserHandoff.required ? 'pending' : 'off',
      }
      rmSync(stateFile(stateDir, 'browserHandoffAck'), { force: true })
      delete receipt.readiness
      delete receipt.canary
      receipt.recovery.validation = {}
      {
        const state = readLaunchState(stateDir)
        if (state?.mode !== 'cutover' || state.cutoverId !== id) throw new Error('restoring: cutover launch state is missing')
        atomicWriteJson(stateFile(stateDir, 'launchSpec'), { ...state, selected: 'previous' } satisfies CutoverLaunchState)
      }
      break
    case 'transition': {
      if (receipt.transition === undefined) throw new Error('transition: cutover has no transition plan')
      const outcome = args[0]
      const planSha256 = args[1]
      if (planSha256 !== receipt.transition.planSha256) throw new Error('transition: plan digest does not match')
      if (outcome === 'applied') {
        if (receipt.transition.phase === 'rolled-back') throw new Error('transition: a rolled-back plan cannot be applied')
        receipt.transition = { ...receipt.transition, phase: 'applied' }
      } else if (outcome === 'rolled-back') {
        receipt.transition = { ...receipt.transition, phase: 'rolled-back' }
      } else if (outcome === 'apply-failed' || outcome === 'rollback-failed') {
        receipt.transition = {
          ...receipt.transition,
          phase: 'failed',
          failureOperation: outcome === 'apply-failed' ? 'apply' : 'rollback',
          ...(args.length > 2 ? { detail: args.slice(2).join(' ') } : {}),
        }
      } else {
        throw new Error('transition: invalid outcome')
      }
      break
    }
    case 'canary': {
      // New writers name the role. Legacy two-word events are still accepted
      // and attributed to the current proven readiness role during rollout.
      const explicitRole = args[0] === 'target' || args[0] === 'previous' ? args[0] : undefined
      const role = explicitRole ?? receipt.readiness?.role
      const outcomeIndex = explicitRole === undefined ? 0 : 1
      const outcome = args[outcomeIndex]
      if ((role !== 'target' && role !== 'previous')
        || (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'skipped')) {
        throw new Error('canary: invalid role or outcome')
      }
      if (role === 'target' && outcome === 'skipped') throw new Error('canary: target canary cannot be skipped')
      const detail = args.slice(outcomeIndex + 1).join(' ')
      const canary: { outcome: 'pass' | 'fail' | 'skipped'; detail?: string } = {
        outcome,
        ...(detail === '' ? {} : { detail }),
      }
      if (role === 'target') {
        receipt.targetValidation ??= {}
        receipt.targetValidation.canary = canary as { outcome: 'pass' | 'fail'; detail?: string }
        // Compatibility view for a successful target receipt. Recovery clears
        // it so target failure cannot masquerade as previous readiness.
        receipt.canary = canary as { outcome: 'pass' | 'fail'; detail?: string }
      } else {
        receipt.recovery.validation ??= {}
        receipt.recovery.validation.canary = canary
        delete receipt.canary
      }
      break
    }
    case 'ready': {
      const role = args[0]
      if (role !== 'target' && role !== 'previous') throw new Error('ready: invalid role')
      const state = readLaunchState(stateDir)
      if (state?.mode !== 'cutover' || state.cutoverId !== id) throw new Error('ready: cutover launch state is missing')
      const ownership = role === 'target' ? receipt.ownership?.target : receipt.ownership?.restored
      if (ownership === undefined || receipt.readiness?.role !== role
        || receipt.readiness.childPid !== ownership.childPid
        || receipt.readiness.listenerPid !== ownership.listenerPid
        || receipt.readiness.retryCount !== 0) {
        throw new Error(`ready: ${role} child/listener ownership was not stable and proven`)
      }
      const found = [...receipt.attempts].reverse().find(candidate => candidate.role === role && candidate.outcome === undefined)
      if (found === undefined || found.childPid !== ownership.childPid
        || found.childStartToken !== ownership.childStartToken) {
        throw new Error(`ready: ${role} ownership does not match the active attempt`)
      }
      if (role === 'target' && receipt.targetValidation?.canary?.outcome !== 'pass') {
        throw new Error('ready: target canary has not passed')
      }
      if (role === 'previous' && receipt.recovery.validation?.canary === undefined) {
        throw new Error('ready: restored-previous canary has not settled')
      }
      if (role === 'target' && receipt.transition !== undefined && receipt.transition.phase !== 'applied') {
        throw new Error('ready: target transition is not applied')
      }
      if (role === 'previous' && receipt.transition !== undefined && receipt.transition.phase !== 'rolled-back') {
        throw new Error('ready: previous transition is not rolled back')
      }
      if (receipt.authentication.launchUrlObserved === true && receipt.browserHandoff.required
        && receipt.browserHandoff.status !== 'acknowledged') {
        throw new Error('ready: authenticated launch URL has no browser acknowledgement')
      }
      found.outcome = 'ready'
      if (role === 'target') {
        receipt.phase = 'ready'
        receipt.recovery.result = 'not-needed'
        terminal = 'target-ready'
      } else {
        receipt.phase = 'restored'
        receipt.recovery.result = 'restored'
        terminal = 'restored'
      }
      if (receipt.authentication.browserHandoff === 'pending'
        && receipt.authentication.launchUrlObserved !== true) {
        receipt.authentication.browserHandoff = 'not-required'
        receipt.browserHandoff = { required: receipt.browserHandoff.required, status: 'not-required' }
      }
      // Keep the full pair until AFTER the terminal receipt rename releases
      // the wake gate. Compacting state first would make cutoverBlocksWake see
      // "stable" for a few disk operations before the report/receipt existed.
      stableSpec = state[role]
      atomicWriteJson(stateFile(stateDir, 'instanceLaunch'), {
        command: state[role].command,
        source: 'supervisor',
        supervised: true,
        port: state[role].port,
        recordedAt: now,
      })
      break
    }
    case 'awaiting-user':
      receipt.phase = 'awaiting-user'
      receipt.recovery.result = 'waiting-for-user'
      receipt.recovery.detail = args.join(' ')
      terminal = 'awaiting-user'
      break
    case 'prepare-failed': {
      const state = readLaunchState(stateDir)
      if (state?.mode === 'cutover' && state.cutoverId === id) {
        stableSpec = state.previous
      }
      receipt.phase = 'prepare-failed'
      receipt.recovery.result = 'prepare-failed'
      receipt.recovery.detail = args.join(' ')
      terminal = 'prepare-failed'
      break
    }
    default:
      throw new Error(`unknown cutover event ${kind}`)
  }
  appendEvent(receipt, kind, args.join(' '), now)
  // Write the report outcome before releasing the wake gate in the terminal
  // receipt rename: the restarted plugin must never observe "ready" with only
  // the exit agent's older, context-free record.
  if (terminal !== undefined) updateRestartRecord(stateDir, receipt, terminal)
  atomicWriteJson(stateFile(stateDir, 'launchCutover'), receipt)
  if (terminal !== undefined) clearCutoverControl(stateDir, id)
  if (terminal !== undefined) {
    // Keep hashed per-tab registrations after a successful terminal event so
    // slower registered tabs can still recover through this exact final
    // listener. A new cutover removes the registry before arming its own tabs.
    if (terminal !== 'target-ready' && terminal !== 'restored') {
      rmSync(stateFile(stateDir, 'browserHandoffRequest'), { force: true })
    }
    rmSync(stateFile(stateDir, 'browserHandoffAck'), { force: true })
  }
  if (stableSpec !== undefined) {
    atomicWriteJson(stateFile(stateDir, 'launchSpec'), { version: 1, mode: 'stable', active: stableSpec } satisfies StableLaunchState)
  }
  return receipt
}

/** A restarted instance must not wake/report while the watchdog is still proving the cutover. */
export function cutoverBlocksWake(stateDir: string): boolean {
  const state = readLaunchState(stateDir)
  // The receipt is intentionally written before the selected-state commit.
  // A crash in that gap leaves an orphan prepared receipt but the previous
  // stable spec authoritative; it must not gate every later cold start.
  if (state?.mode !== 'cutover') return false
  const receipt = readCutoverReceipt(stateDir)
  // Once launch state says cutover, a missing/mismatched receipt is corruption:
  // fail closed rather than waking a session against an unproved process.
  if (receipt === null || receipt.id !== state.cutoverId) return true
  const terminal: readonly CutoverPhase[] = ['ready', 'restored', 'awaiting-user', 'prepare-failed']
  return !terminal.includes(receipt.phase)
}

/** The active transaction's full specs plus its redacted policy receipt. */
export function activeCutover(stateDir: string): { state: CutoverLaunchState; receipt: LaunchCutoverReceipt } | null {
  const state = readLaunchState(stateDir)
  const receipt = readCutoverReceipt(stateDir)
  if (state?.mode !== 'cutover' || receipt === null || receipt.id !== state.cutoverId) return null
  // A crash in the tiny receipt-terminal → state-compaction gap is safe to
  // treat as ordinary selected-spec startup; only awaiting-user intentionally
  // retains a terminal cutover state.
  if (receipt.phase === 'ready' || receipt.phase === 'restored' || receipt.phase === 'prepare-failed') return null
  return { state, receipt }
}
