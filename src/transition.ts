/**
 * Reversible filesystem transitions for launch cutovers.
 *
 * A transition plan names home-relative paths that the next host cannot read.
 * The guard moves those paths into a cutover-scoped quarantine only after the
 * previous process has stopped. If the target is rejected, target-created
 * replacements are retained separately before the previous bytes are restored.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeTempArtifactOwner } from './temp-artifact.ts'

const MAX_OPERATIONS = 64
const CUTOVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/

/** One reversible filesystem operation approved before a cutover. */
export interface TransitionOperation {
  kind: 'quarantine'
  /** Path relative to the shared previous/target dsh home. */
  path: string
  /** State that both isolated preflight and live apply must observe. */
  expect: 'present' | 'absent'
}

/** Caller-authored transition plan. Unknown operation kinds fail closed. */
export interface TransitionPlan {
  schemaVersion: 1
  /** Canonical dsh home containing every operation path. */
  home: string
  operations: TransitionOperation[]
}

/** Immutable reference carried by the durable launch state and receipt. */
export interface TransitionReference {
  version: 1
  planPath: string
  planSha256: string
  operationCount: number
}

type ApplyState = 'pending' | 'moving' | 'absent' | 'quarantined'
type RollbackState = 'pending' | 'moving-target' | 'target-retained' | 'target-absent' | 'restoring' | 'restored'
export type TransitionPhase = 'prepared' | 'applying' | 'applied' | 'rolling-back' | 'rolled-back' | 'failed'

interface TransitionEntryState {
  path: string
  original: 'present' | 'absent'
  apply: ApplyState
  rollback: RollbackState
}

/** Crash-recovery journal for one transition. */
export interface TransitionRecord {
  version: 1
  cutoverId: string
  planSha256: string
  phase: TransitionPhase
  entries: TransitionEntryState[]
  updatedAt: number
  failure?: { operation: 'apply' | 'rollback'; detail: string }
}

/** Result returned after an idempotent transition operation. */
export interface TransitionResult {
  phase: 'applied' | 'rolled-back'
  changed: string[]
  unchanged: string[]
}

interface LoadedTransition {
  plan: TransitionPlan
  record: TransitionRecord
  root: string
  stateFile: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} requires exactly: ${wanted.join(', ')}`)
  }
}

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`)
  let canonical: string
  try { canonical = realpathSync(path) } catch { throw new Error(`${label} does not exist: ${path}`) }
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory: ${path}`)
  return canonical
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function normalizeRelativePath(path: unknown): string {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.includes('\\') || path.includes('\0')) {
    throw new Error('transition operation path must be a non-empty home-relative POSIX path')
  }
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`transition operation path contains an empty or traversal segment: ${path}`)
  }
  return parts.join(sep)
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)
}

function assertPathHasNoSymlink(home: string, path: string): void {
  let current = home
  for (const part of path.split(sep)) {
    current = join(current, part)
    if (!pathExists(current)) return
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`transition path crosses a symbolic link: ${path}`)
    if (current !== join(home, path) && !stat.isDirectory()) {
      throw new Error(`transition path has a non-directory ancestor: ${path}`)
    }
  }
}

function assertOperationScope(plan: TransitionPlan, stateDir?: string): void {
  const paths = plan.operations.map(operation => operation.path)
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index]!
    assertPathHasNoSymlink(plan.home, path)
    for (const other of paths.slice(index + 1)) {
      if (overlaps(path, other)) throw new Error(`transition paths may not overlap: ${path} and ${other}`)
    }
  }
  if (stateDir === undefined) return
  const canonicalState = canonicalDirectory(stateDir, 'transition state directory')
  const stateRelative = relative(plan.home, canonicalState)
  if (stateRelative === '') {
    throw new Error('transition state directory must not equal the transition home')
  }
  if (!stateRelative.startsWith(`..${sep}`) && stateRelative !== '..' && !isAbsolute(stateRelative)) {
    for (const path of paths) {
      if (overlaps(path, stateRelative)) {
        throw new Error(`transition path overlaps the guard state directory: ${path}`)
      }
    }
  }
}

/**
 * Validate and normalize an untrusted transition plan.
 * @param raw - Parsed JSON plan.
 * @param expectedHome - Home shared by the previous and target launch specs.
 * @param stateDir - Guard state directory, which no operation may move.
 * @returns A canonical plan safe for durable preparation.
 */
export function validateTransitionPlan(raw: unknown, expectedHome: string, stateDir?: string): TransitionPlan {
  if (!isObject(raw)) throw new Error('transition plan must be an object')
  exactKeys(raw, ['schemaVersion', 'home', 'operations'], 'transition plan')
  if (raw.schemaVersion !== 1) throw new Error('transition plan requires schemaVersion: 1')
  if (typeof raw.home !== 'string') throw new Error('transition plan home must be a string')
  const home = canonicalDirectory(raw.home, 'transition plan home')
  const expected = canonicalDirectory(expectedHome, 'cutover home')
  if (home !== expected) throw new Error('transition plan home must equal the cutover home')
  if (!Array.isArray(raw.operations) || raw.operations.length === 0 || raw.operations.length > MAX_OPERATIONS) {
    throw new Error(`transition plan requires 1-${MAX_OPERATIONS} operations`)
  }
  const seen = new Set<string>()
  const operations = raw.operations.map((operation, index): TransitionOperation => {
    if (!isObject(operation)) throw new Error(`transition operation ${index} must be an object`)
    exactKeys(operation, ['expect', 'kind', 'path'], `transition operation ${index}`)
    if (operation.kind !== 'quarantine') throw new Error(`transition operation ${index} has unsupported kind`)
    if (operation.expect !== 'present' && operation.expect !== 'absent') {
      throw new Error(`transition operation ${index} requires expect: present or absent`)
    }
    const path = normalizeRelativePath(operation.path)
    if (seen.has(path)) throw new Error(`transition operation path is duplicated: ${path}`)
    seen.add(path)
    return { kind: 'quarantine', path, expect: operation.expect }
  })
  const plan: TransitionPlan = { schemaVersion: 1, home, operations }
  assertOperationScope(plan, stateDir)
  return plan
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function atomicWrite(file: string, bytes: Buffer): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
  try {
    renameSync(temporary, file)
    try { chmodSync(file, 0o600) } catch { /* best effort on non-POSIX filesystems */ }
  } finally {
    rmSync(temporary, { force: true })
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  atomicWrite(file, jsonBytes(value))
}

function transitionRoot(stateDir: string, cutoverId: string): string {
  if (!CUTOVER_ID_PATTERN.test(cutoverId)) throw new Error('transition cutover id is invalid')
  return join(canonicalDirectory(stateDir, 'transition state directory'), 'launch-transitions', cutoverId)
}

function expectedPlanPath(stateDir: string, cutoverId: string): string {
  return join(transitionRoot(stateDir, cutoverId), 'plan.json')
}

/**
 * Persist the immutable plan and an empty crash-recovery journal before the previous host stops.
 * @param raw - Validated or untrusted plan JSON.
 * @param expectedHome - Shared launch home.
 * @param stateDir - Guard state directory.
 * @param cutoverId - Unique launch cutover identifier.
 * @returns Reference stored in the launch state and redacted receipt.
 */
export function prepareTransition(
  raw: unknown, expectedHome: string, stateDir: string, cutoverId: string,
): TransitionReference {
  const plan = validateTransitionPlan(raw, expectedHome, stateDir)
  const root = transitionRoot(stateDir, cutoverId)
  if (pathExists(root)) throw new Error(`transition directory already exists for cutover ${cutoverId}`)
  if (statSync(plan.home).dev !== statSync(canonicalDirectory(stateDir, 'transition state directory')).dev) {
    throw new Error('transition home and state directory must be on the same filesystem')
  }
  for (const operation of plan.operations) {
    const source = join(plan.home, operation.path)
    if (pathExists(source) !== (operation.expect === 'present')) {
      throw new Error(`transition source ${operation.path} is ${pathExists(source) ? 'present' : 'absent'}, expected ${operation.expect}`)
    }
    if (pathExists(source) && lstatSync(source).dev !== statSync(canonicalDirectory(stateDir, 'transition state directory')).dev) {
      throw new Error(`transition source is on a different filesystem: ${operation.path}`)
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const planPath = join(root, 'plan.json')
  const bytes = jsonBytes(plan)
  atomicWrite(planPath, bytes)
  const planSha256 = sha256(bytes)
  const record: TransitionRecord = {
    version: 1,
    cutoverId,
    planSha256,
    phase: 'prepared',
    entries: plan.operations.map(operation => ({
      path: operation.path,
      original: operation.expect,
      apply: 'pending',
      rollback: 'pending',
    })),
    updatedAt: Date.now(),
  }
  atomicWriteJson(join(root, 'state.json'), record)
  return { version: 1, planPath, planSha256, operationCount: plan.operations.length }
}

function parseRecord(raw: unknown, cutoverId: string, reference: TransitionReference, plan: TransitionPlan): TransitionRecord {
  if (!isObject(raw) || raw.version !== 1 || raw.cutoverId !== cutoverId
    || raw.planSha256 !== reference.planSha256 || typeof raw.updatedAt !== 'number'
    || !['prepared', 'applying', 'applied', 'rolling-back', 'rolled-back', 'failed'].includes(String(raw.phase))
    || !Array.isArray(raw.entries) || raw.entries.length !== plan.operations.length) {
    throw new Error('transition state is malformed or does not match its plan')
  }
  const entries = raw.entries as unknown[]
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!isObject(entry) || entry.path !== plan.operations[index]?.path
      || !['present', 'absent'].includes(String(entry.original))
      || !['pending', 'moving', 'absent', 'quarantined'].includes(String(entry.apply))
      || !['pending', 'moving-target', 'target-retained', 'target-absent', 'restoring', 'restored'].includes(String(entry.rollback))) {
      throw new Error(`transition state entry ${index} is malformed`)
    }
  }
  return raw as unknown as TransitionRecord
}

function loadTransition(
  reference: TransitionReference, expectedHome: string, stateDir: string, cutoverId: string,
): LoadedTransition {
  if (reference.version !== 1 || !/^[a-f0-9]{64}$/.test(reference.planSha256)
    || !Number.isInteger(reference.operationCount) || reference.operationCount < 1) {
    throw new Error('transition reference is malformed')
  }
  const planPath = expectedPlanPath(stateDir, cutoverId)
  if (resolve(reference.planPath) !== planPath) throw new Error('transition plan path is outside its cutover directory')
  const bytes = readFileSync(planPath)
  if (sha256(bytes) !== reference.planSha256) throw new Error('transition plan changed after preparation')
  let rawPlan: unknown
  try { rawPlan = JSON.parse(bytes.toString('utf8')) as unknown } catch { throw new Error('transition plan is not valid JSON') }
  const plan = validateTransitionPlan(rawPlan, expectedHome, stateDir)
  if (plan.operations.length !== reference.operationCount) throw new Error('transition operation count changed after preparation')
  const root = dirname(planPath)
  const stateFile = join(root, 'state.json')
  let rawRecord: unknown
  try { rawRecord = JSON.parse(readFileSync(stateFile, 'utf8')) as unknown } catch { throw new Error('transition state is unreadable') }
  return { plan, record: parseRecord(rawRecord, cutoverId, reference, plan), root, stateFile }
}

function writeRecord(loaded: LoadedTransition): void {
  loaded.record.updatedAt = Date.now()
  atomicWriteJson(loaded.stateFile, loaded.record)
}

function previousPath(root: string, path: string): string {
  return join(root, 'previous', path)
}

function rejectedTargetPath(root: string, path: string): string {
  return join(root, 'rejected-target', path)
}

function markFailure(loaded: LoadedTransition, operation: 'apply' | 'rollback', error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error)
  loaded.record.phase = 'failed'
  loaded.record.failure = { operation, detail }
  try { writeRecord(loaded) } catch { /* preserve the original filesystem failure */ }
  throw new Error(`transition ${operation} failed: ${detail}`)
}

function reconcileMovingApply(loaded: LoadedTransition, entry: TransitionEntryState): boolean {
  const source = join(loaded.plan.home, entry.path)
  const retained = previousPath(loaded.root, entry.path)
  const sourceExists = pathExists(source)
  const retainedExists = pathExists(retained)
  if (!sourceExists && retainedExists) {
    entry.original = 'present'
    entry.apply = 'quarantined'
    writeRecord(loaded)
    return true
  }
  if (sourceExists && !retainedExists) {
    entry.apply = 'pending'
    writeRecord(loaded)
    return false
  }
  throw new Error(`cannot reconcile interrupted quarantine for ${entry.path}`)
}

/**
 * Apply a prepared transition after the previous host has stopped.
 * @param reference - Immutable reference from the launch state.
 * @param expectedHome - Shared launch home.
 * @param stateDir - Guard state directory.
 * @param cutoverId - Active cutover identifier.
 * @returns Idempotent apply result.
 */
export function applyTransition(
  reference: TransitionReference, expectedHome: string, stateDir: string, cutoverId: string,
): TransitionResult {
  const loaded = loadTransition(reference, expectedHome, stateDir, cutoverId)
  if (loaded.record.phase === 'rolled-back') throw new Error('a rolled-back transition cannot be applied again')
  if (loaded.record.phase === 'applied') {
    return { phase: 'applied', changed: [], unchanged: loaded.record.entries.map(entry => entry.path) }
  }
  const changed: string[] = []
  const unchanged: string[] = []
  loaded.record.phase = 'applying'
  delete loaded.record.failure
  writeRecord(loaded)
  try {
    for (const entry of loaded.record.entries) {
      assertPathHasNoSymlink(loaded.plan.home, entry.path)
      if (entry.apply === 'quarantined' || entry.apply === 'absent') {
        unchanged.push(entry.path)
        continue
      }
      if (entry.apply === 'moving' && reconcileMovingApply(loaded, entry)) {
        unchanged.push(entry.path)
        continue
      }
      const source = join(loaded.plan.home, entry.path)
      const retained = previousPath(loaded.root, entry.path)
      const sourceExists = pathExists(source)
      if (sourceExists !== (entry.original === 'present')) {
        throw new Error(`transition source changed after preparation: ${entry.path}`)
      }
      if (!sourceExists) {
        if (pathExists(retained)) throw new Error(`unexpected retained source for absent path ${entry.path}`)
        entry.apply = 'absent'
        writeRecord(loaded)
        unchanged.push(entry.path)
        continue
      }
      if (lstatSync(source).isSymbolicLink()) throw new Error(`transition source is a symbolic link: ${entry.path}`)
      if (pathExists(retained)) throw new Error(`transition quarantine destination already exists: ${entry.path}`)
      entry.apply = 'moving'
      writeRecord(loaded)
      mkdirSync(dirname(retained), { recursive: true, mode: 0o700 })
      renameSync(source, retained)
      entry.apply = 'quarantined'
      writeRecord(loaded)
      changed.push(entry.path)
    }
    loaded.record.phase = 'applied'
    writeRecord(loaded)
    return { phase: 'applied', changed, unchanged }
  } catch (error) {
    return markFailure(loaded, 'apply', error)
  }
}

function finishTargetRetention(loaded: LoadedTransition, entry: TransitionEntryState): void {
  const source = join(loaded.plan.home, entry.path)
  const target = rejectedTargetPath(loaded.root, entry.path)
  const sourceExists = pathExists(source)
  const targetExists = pathExists(target)
  if (entry.rollback === 'moving-target') {
    if (!sourceExists && targetExists) {
      entry.rollback = 'target-retained'
      writeRecord(loaded)
      return
    }
    if (!sourceExists || targetExists) {
      throw new Error(`cannot reconcile rejected target output for ${entry.path}`)
    }
  }
  if (sourceExists) {
    if (targetExists) throw new Error(`rejected target quarantine already exists for ${entry.path}`)
    entry.rollback = 'moving-target'
    writeRecord(loaded)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    renameSync(source, target)
    entry.rollback = 'target-retained'
  } else {
    entry.rollback = targetExists ? 'target-retained' : 'target-absent'
  }
  writeRecord(loaded)
}

function finishPreviousRestore(loaded: LoadedTransition, entry: TransitionEntryState): void {
  if (entry.original === 'absent') {
    entry.rollback = 'restored'
    writeRecord(loaded)
    return
  }
  if (entry.original !== 'present') throw new Error(`transition original state is unknown for ${entry.path}`)
  const source = join(loaded.plan.home, entry.path)
  const retained = previousPath(loaded.root, entry.path)
  const sourceExists = pathExists(source)
  const retainedExists = pathExists(retained)
  if (entry.rollback === 'restoring') {
    if (sourceExists && !retainedExists) {
      entry.rollback = 'restored'
      writeRecord(loaded)
      return
    }
    if (sourceExists || !retainedExists) {
      throw new Error(`cannot reconcile previous-state restore for ${entry.path}`)
    }
  }
  if (sourceExists || !retainedExists) throw new Error(`previous-state quarantine is incomplete for ${entry.path}`)
  entry.rollback = 'restoring'
  writeRecord(loaded)
  mkdirSync(dirname(source), { recursive: true })
  renameSync(retained, source)
  entry.rollback = 'restored'
  writeRecord(loaded)
}

/**
 * Roll back an applied or partially applied transition before previous starts.
 * Target-created replacements are retained for diagnosis rather than deleted.
 * @param reference - Immutable reference from the launch state.
 * @param expectedHome - Shared launch home.
 * @param stateDir - Guard state directory.
 * @param cutoverId - Active cutover identifier.
 * @returns Idempotent rollback result.
 */
export function rollbackTransition(
  reference: TransitionReference, expectedHome: string, stateDir: string, cutoverId: string,
): TransitionResult {
  const loaded = loadTransition(reference, expectedHome, stateDir, cutoverId)
  if (loaded.record.phase === 'rolled-back') {
    return { phase: 'rolled-back', changed: [], unchanged: loaded.record.entries.map(entry => entry.path) }
  }
  const changed: string[] = []
  const unchanged: string[] = []
  loaded.record.phase = 'rolling-back'
  delete loaded.record.failure
  writeRecord(loaded)
  try {
    for (const entry of [...loaded.record.entries].reverse()) {
      if (entry.rollback === 'restored') {
        unchanged.push(entry.path)
        continue
      }
      if (entry.apply === 'moving') reconcileMovingApply(loaded, entry)
      if (entry.apply === 'pending') {
        entry.rollback = 'restored'
        writeRecord(loaded)
        unchanged.push(entry.path)
        continue
      }
      assertPathHasNoSymlink(loaded.plan.home, entry.path)
      if (entry.rollback !== 'restoring') finishTargetRetention(loaded, entry)
      finishPreviousRestore(loaded, entry)
      changed.push(entry.path)
    }
    loaded.record.phase = 'rolled-back'
    writeRecord(loaded)
    return { phase: 'rolled-back', changed, unchanged }
  } catch (error) {
    return markFailure(loaded, 'rollback', error)
  }
}

/**
 * Read and verify a transition record through its immutable reference.
 * @param reference - Reference stored in launch state.
 * @param expectedHome - Shared launch home.
 * @param stateDir - Guard state directory.
 * @param cutoverId - Cutover identifier.
 * @returns Verified crash-recovery journal.
 */
export function readTransitionRecord(
  reference: TransitionReference, expectedHome: string, stateDir: string, cutoverId: string,
): TransitionRecord {
  return loadTransition(reference, expectedHome, stateDir, cutoverId).record
}

function snapshotCopyError(source: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ELOOP') return new Error(`preflight snapshot refused an unresolvable symbolic-link cycle at ${source}`)
  return new Error(`preflight snapshot could not safely copy ${source}: ${String(error)}`)
}

interface SnapshotLink {
  source: string
  destination: string
}

interface SnapshotDirectoryMetadata {
  destination: string
  mode: number
  atime: Date
  mtime: Date
}

interface SnapshotCopyContext {
  externalRoot: string
  /** Canonical path of the source home root; only its direct children are skippable. */
  rootCanonical: string
  destinations: Map<string, string>
  pendingLinks: SnapshotLink[]
  directories: SnapshotDirectoryMetadata[]
  /** Runtime entries (sockets, FIFOs) dropped instead of copied — counted for the caller's log line. */
  skippedRuntimeEntries: number
}

/**
 * Top-level home entries that never join a preflight snapshot: scratch is
 * ephemeral by definition, and copying it can push prepare+canary past the
 * credential's freshness window (observed: a 24 GB scratch expired the
 * credential mid-cutover, the target canary then failed and restored).
 */
const SNAPSHOT_SKIPPED_TOP_LEVEL: ReadonlySet<string> = new Set(['scratch'])

function canonicalSnapshotSource(source: string): string {
  try {
    return realpathSync(source)
  } catch (error) {
    throw snapshotCopyError(source, error)
  }
}

function createContainedSnapshotLink(destination: string, target: string, directory: boolean): void {
  const targetFromLink = relative(dirname(destination), target) || '.'
  symlinkSync(targetFromLink, destination, directory ? 'dir' : 'file')
}

/** Copy physical entries once; source symlinks become deferred graph edges. */
function copySnapshotNode(source: string, destination: string, context: SnapshotCopyContext): void {
  let linkMetadata: ReturnType<typeof lstatSync>
  try {
    linkMetadata = lstatSync(source)
  } catch (error) {
    throw snapshotCopyError(source, error)
  }

  if (linkMetadata.isSymbolicLink()) {
    context.pendingLinks.push({ source, destination })
    return
  }

  // Sockets and FIFOs have no copyable content — a live instance's own
  // runtime endpoints (member-bridge.sock et al.) are recreated by whichever
  // process boots on the snapshot. Device nodes and anything more exotic
  // still fail closed.
  if (linkMetadata.isSocket() || linkMetadata.isFIFO()) {
    context.skippedRuntimeEntries++
    return
  }

  if (!linkMetadata.isDirectory() && !linkMetadata.isFile()) {
    throw new Error(`preflight snapshot refused a special filesystem entry at ${source}`)
  }

  const canonical = canonicalSnapshotSource(source)
  const existing = context.destinations.get(canonical)
  if (existing !== undefined) {
    createContainedSnapshotLink(destination, existing, linkMetadata.isDirectory())
    return
  }
  context.destinations.set(canonical, destination)

  if (linkMetadata.isDirectory()) {
    mkdirSync(destination, { mode: 0o700 })
    context.directories.push({
      destination,
      mode: linkMetadata.mode & 0o7777,
      atime: linkMetadata.atime,
      mtime: linkMetadata.mtime,
    })
    try {
      for (const name of readdirSync(canonical)) {
        if (canonical === context.rootCanonical && SNAPSHOT_SKIPPED_TOP_LEVEL.has(name)) continue
        copySnapshotNode(join(canonical, name), join(destination, name), context)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('preflight snapshot ')) throw error
      throw snapshotCopyError(source, error)
    }
    return
  }

  try {
    copyFileSync(canonical, destination, constants.COPYFILE_FICLONE)
    chmodSync(destination, linkMetadata.mode & 0o7777)
    utimesSync(destination, linkMetadata.atime, linkMetadata.mtime)
  } catch (error) {
    throw snapshotCopyError(source, error)
  }
}

/**
 * Preserve Node's ancestor node_modules lookup for an external package while
 * avoiding one copy per package link. Other external targets are materialized
 * individually and still deduplicated by canonical path.
 */
function externalMaterializationAnchor(target: string): { source: string; destination: string } {
  const parsed = resolve(target).split(sep)
  const nodeModulesIndex = parsed.indexOf('node_modules')
  if (nodeModulesIndex >= 0) {
    const prefix = parsed.slice(0, nodeModulesIndex + 1).join(sep) || sep
    return { source: prefix, destination: 'node_modules' }
  }
  return { source: target, destination: basename(target) || 'target' }
}

function resolveSnapshotLinks(context: SnapshotCopyContext): void {
  for (let index = 0; index < context.pendingLinks.length; index++) {
    const link = context.pendingLinks[index]!
    const target = canonicalSnapshotSource(link.source)
    let metadata: ReturnType<typeof statSync>
    try {
      metadata = statSync(target)
    } catch (error) {
      throw snapshotCopyError(link.source, error)
    }
    // A link to a socket/FIFO is dropped with the same rule as the entry
    // itself; a link to a device node or anything more exotic still refuses.
    if (metadata.isSocket() || metadata.isFIFO()) {
      context.skippedRuntimeEntries++
      continue
    }
    if (!metadata.isDirectory() && !metadata.isFile()) {
      throw new Error(`preflight snapshot refused a link to a special filesystem entry at ${link.source}`)
    }

    let mapped = context.destinations.get(target)
    if (mapped === undefined) {
      const anchor = externalMaterializationAnchor(target)
      const canonicalAnchor = canonicalSnapshotSource(anchor.source)
      mapped = context.destinations.get(target)
      if (mapped === undefined) {
        mkdirSync(context.externalRoot, { recursive: true, mode: 0o700 })
        const anchorDestination = join(
          context.externalRoot,
          sha256(Buffer.from(canonicalAnchor)),
          anchor.destination,
        )
        mkdirSync(dirname(anchorDestination), { recursive: true, mode: 0o700 })
        copySnapshotNode(canonicalAnchor, anchorDestination, context)
        mapped = context.destinations.get(target)
      }
    }
    if (mapped === undefined) {
      throw new Error(`preflight snapshot could not map symbolic-link target for ${link.source}`)
    }
    createContainedSnapshotLink(link.destination, mapped, metadata.isDirectory())
  }
}

function pathIsWithin(root: string, path: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))
}

/** Prove every retained link resolves to a writable target inside the snapshot. */
function assertSnapshotLinksContained(path: string, canonicalRoot: string): void {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink()) {
    const target = canonicalSnapshotSource(path)
    if (!pathIsWithin(canonicalRoot, target)) {
      throw new Error(`preflight snapshot retained a writable link escape at ${path}`)
    }
    const targetMetadata = statSync(target)
    if (!targetMetadata.isDirectory() && !targetMetadata.isFile()) {
      throw new Error(`preflight snapshot retained a link to a special filesystem entry at ${path}`)
    }
    return
  }
  if (metadata.isDirectory()) {
    for (const name of readdirSync(path)) assertSnapshotLinksContained(join(path, name), canonicalRoot)
    return
  }
  if (!metadata.isFile()) throw new Error(`preflight snapshot retained a special filesystem entry at ${path}`)
}

function finalizeSnapshotDirectories(context: SnapshotCopyContext): void {
  for (const directory of [...context.directories].reverse()) {
    chmodSync(directory.destination, directory.mode)
    utimesSync(directory.destination, directory.atime, directory.mtime)
  }
}

/**
 * Clone a live home while retaining a contained package-link graph. Internal
 * links are rebuilt against copied nodes; external targets are deduplicated in
 * a snapshot-owned materialization area. No retained link resolves outside the
 * snapshot root, so writes through pnpm/Cordis links cannot reach live bytes.
 * Runtime entries without copyable content (sockets, FIFOs — and links to
 * them) are skipped and counted, never copied; the top-level scratch/ tree is
 * excluded for size. Device nodes still fail closed.
 * @param sourceHome - Live dsh home to read.
 * @returns Isolated home, an idempotent cleanup callback, and the count of skipped runtime entries.
 */
export function createPreflightSnapshot(sourceHome: string): { home: string; root: string; skippedRuntimeEntries: number; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'ankh-transition-preflight-'))
  const home = join(root, 'home')
  try {
    writeTempArtifactOwner(root, 'preflight-snapshot')
    const source = canonicalDirectory(sourceHome, 'preflight source home')
    const context: SnapshotCopyContext = {
      externalRoot: join(root, 'materialized'),
      rootCanonical: source,
      destinations: new Map(),
      pendingLinks: [],
      directories: [],
      skippedRuntimeEntries: 0,
    }
    copySnapshotNode(source, home, context)
    resolveSnapshotLinks(context)
    assertSnapshotLinksContained(root, realpathSync(root))
    finalizeSnapshotDirectories(context)
    return { home, root, skippedRuntimeEntries: context.skippedRuntimeEntries, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export function createTransitionPreflightSnapshot(plan: TransitionPlan): { home: string; cleanup(): void } {
  const snapshot = createPreflightSnapshot(plan.home)
  try {
    const stateDir = join(snapshot.root, 'guard-state')
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const rebound: TransitionPlan = { ...plan, home: snapshot.home }
    const reference = prepareTransition(rebound, snapshot.home, stateDir, 'preflight')
    applyTransition(reference, snapshot.home, stateDir, 'preflight')
    return { home: snapshot.home, cleanup: snapshot.cleanup }
  } catch (error) {
    snapshot.cleanup()
    throw error
  }
}
