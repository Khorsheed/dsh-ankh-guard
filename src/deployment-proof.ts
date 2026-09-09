/**
 * Reusable evidence for a pure, same-launch restart.
 *
 * A green credential is deliberately short lived: it authorizes one stop
 * close to the observed build/test run. Once that stop has completed
 * readiness and canary, however, the exact deployed inputs are known-good.
 * This module fingerprints those inputs so a later pure restart can reuse the
 * expensive proof without turning "same git HEAD" into a weak proxy for
 * "same deployment".
 */
import { createHash, type Hash } from 'node:crypto'
import {
  existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { currentHead, isWorkingTreeClean } from './git.ts'
import { commandSha256, type LaunchSpec } from './launch-spec.ts'
import {
  loadState, setProvenDeployment, verifyCredential,
  type GuardCredential, type ProvenDeployment, type VerifyResult,
} from './state.ts'

export interface RestartAuthorization {
  version: 1
  kind: 'fresh-credential' | 'proven-deployment'
  revision: string
  evidenceSha256: string
}

export interface RestartEvidenceResult extends VerifyResult {
  authorization?: RestartAuthorization
}

const PROFILE_FILES = [
  'cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
] as const
const HOST_RUNTIME_FILES = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json',
] as const
const SKIPPED_PACKAGE_DIRS = new Set(['.git', 'coverage', 'node_modules'])

function hashChunk(hash: Hash, kind: string, logicalPath: string, value: string | Buffer = ''): void {
  hash.update(kind)
  hash.update('\0')
  hash.update(logicalPath)
  hash.update('\0')
  hash.update(value)
  hash.update('\0')
}

/**
 * Hash a runtime tree, following links so a linked package cannot drift
 * outside the fingerprint. Real-directory de-duplication permits legal link
 * cycles without recursion loops. Special/dangling/unreadable nodes fail
 * closed.
 */
function hashRuntimePath(
  hash: Hash,
  absolutePath: string,
  logicalPath: string,
  seenDirectories: Set<string>,
  packageRoot = false,
): void {
  const info = lstatSync(absolutePath)
  if (info.isSymbolicLink()) {
    const targetText = readlinkSync(absolutePath)
    hashChunk(hash, 'link', logicalPath, targetText)
    let target: string
    try {
      target = realpathSync(absolutePath)
    } catch (error) {
      throw new Error(`deployment fingerprint refused dangling link ${logicalPath}: ${String(error)}`)
    }
    hashRuntimePath(hash, target, `${logicalPath}/@target`, seenDirectories, packageRoot)
    return
  }
  if (info.isFile()) {
    hashChunk(hash, 'file', logicalPath, readFileSync(absolutePath))
    return
  }
  if (!info.isDirectory()) {
    throw new Error(`deployment fingerprint refused special file ${logicalPath}`)
  }
  const realDirectory = realpathSync(absolutePath)
  if (seenDirectories.has(realDirectory)) {
    hashChunk(hash, 'cycle', logicalPath)
    return
  }
  seenDirectories.add(realDirectory)
  hashChunk(hash, 'dir', logicalPath)
  for (const name of readdirSync(absolutePath).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
    if (packageRoot && SKIPPED_PACKAGE_DIRS.has(name)) {
      hashChunk(hash, 'excluded-dir', `${logicalPath}/${name}`)
      continue
    }
    hashRuntimePath(hash, join(absolutePath, name), `${logicalPath}/${name}`, seenDirectories, packageRoot)
  }
}

function hashOptionalPath(hash: Hash, root: string, relativePath: string): void {
  const absolutePath = join(root, relativePath)
  if (!existsSync(absolutePath)) {
    hashChunk(hash, 'absent', relativePath)
    return
  }
  hashRuntimePath(hash, absolutePath, relativePath, new Set())
}

function dependencyInstallPath(profileDir: string, dependency: string): string {
  return join(profileDir, 'node_modules', ...dependency.split('/'))
}

function fileDependencyPath(profileDir: string, specifier: string): string | undefined {
  if (!specifier.startsWith('file:')) return undefined
  const pathname = specifier.slice('file:'.length)
  return isAbsolute(pathname) ? pathname : resolve(profileDir, pathname)
}

/** Hash profile inputs, installed direct packages, and file: source archives. */
function profileRuntimeSha256(spec: LaunchSpec): string {
  const profileDir = join(spec.home, 'profiles', spec.profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`deployment fingerprint requires ${manifestPath}`)
  let manifest: { dependencies?: Record<string, string> }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch (error) {
    throw new Error(`deployment fingerprint could not parse profile package.json: ${String(error)}`)
  }
  const hash = createHash('sha256')
  for (const file of PROFILE_FILES) hashOptionalPath(hash, profileDir, file)
  const dependencies = Object.entries(manifest.dependencies ?? {})
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
  for (const [name, source] of dependencies) {
    const installed = dependencyInstallPath(profileDir, name)
    if (!existsSync(installed)) throw new Error(`deployment fingerprint requires installed profile dependency ${name}`)
    hashRuntimePath(hash, installed, `installed/${name}`, new Set(), true)
    const archive = fileDependencyPath(profileDir, source)
    if (archive !== undefined) {
      if (!existsSync(archive)) throw new Error(`deployment fingerprint requires file dependency archive for ${name}`)
      hashRuntimePath(hash, archive, `source-archive/${name}`, new Set())
    }
  }
  return hash.digest('hex')
}

/**
 * Hash the host install metadata and any explicitly bound built execution
 * surface. Source surfaces are content-bound by the clean harness git tree.
 */
function hostRuntimeSha256(spec: LaunchSpec): string {
  const hash = createHash('sha256')
  for (const file of HOST_RUNTIME_FILES) hashOptionalPath(hash, spec.harnessRoot, file)
  if (spec.preflight !== undefined) {
    hashRuntimePath(hash, spec.preflight.runnerPath, 'preflight/runner', new Set())
    hashRuntimePath(hash, spec.preflight.installAnchor, 'preflight/install-anchor', new Set())
    if (spec.preflight.surface === 'built') {
      hashRuntimePath(hash, dirname(spec.preflight.installAnchor), 'preflight/built-host-package', new Set(), true)
    }
  }
  return hash.digest('hex')
}

function cleanRevision(root: string, role: string): string {
  const revision = currentHead(root)
  if (revision === null) throw new Error(`deployment fingerprint requires ${role} to be a git repository`)
  if (!isWorkingTreeClean(root)) throw new Error(`deployment fingerprint requires a clean ${role}`)
  return revision
}

export function captureDeploymentFingerprint(spec: LaunchSpec): ProvenDeployment['fingerprint'] {
  if (spec.preflight === undefined) {
    throw new Error('deployment fingerprint requires an explicit source/built preflight execution binding')
  }
  if (spec.preflight.targetCommandSha256 !== commandSha256(spec.command)) {
    throw new Error('deployment fingerprint refused a preflight binding for a different launch command')
  }
  if (fileSha256(spec.preflight.runnerPath) !== spec.preflight.runnerSha256) {
    throw new Error('deployment fingerprint refused a changed preflight runner')
  }
  if (fileSha256(spec.preflight.installAnchor) !== spec.preflight.installAnchorSha256) {
    throw new Error('deployment fingerprint refused a changed preflight install anchor')
  }
  const credentialRevision = cleanRevision(spec.credentialRepo, 'credential repository')
  const harnessRevision = cleanRevision(spec.harnessRoot, 'harness root')
  return {
    version: 1,
    credentialRevision,
    harnessRevision,
    launchSpecSha256: commandSha256(JSON.stringify(spec)),
    profileSha256: profileRuntimeSha256(spec),
    hostRuntimeSha256: hostRuntimeSha256(spec),
  }
}

export function deploymentFingerprintSha256(fingerprint: ProvenDeployment['fingerprint']): string {
  return commandSha256(JSON.stringify(fingerprint))
}

function credentialCommandSha256(credential: GuardCredential): string {
  return commandSha256(credential.command)
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function proofCredentialMatches(proof: ProvenDeployment, credential: GuardCredential | undefined): boolean {
  return credential !== undefined
    && credential.revision === proof.credential.revision
    && credential.recordedAt === proof.credential.recordedAt
    && credential.scope === proof.credential.scope
    && credentialCommandSha256(credential) === proof.credential.commandSha256
}

export function verifyProvenDeployment(stateDir: string, spec: LaunchSpec): RestartEvidenceResult {
  const state = loadState(stateDir)
  const proof = state.provenDeployment
  if (proof === undefined) return { ok: false, reason: 'no proven deployment recorded by a completed restart canary' }
  if (!proofCredentialMatches(proof, state.credential)) {
    return { ok: false, reason: 'proven deployment no longer matches the recorded build/test credential' }
  }
  let current: ProvenDeployment['fingerprint']
  try {
    current = captureDeploymentFingerprint(spec)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const currentSha256 = deploymentFingerprintSha256(current)
  if (currentSha256 !== proof.fingerprintSha256 || JSON.stringify(current) !== JSON.stringify(proof.fingerprint)) {
    return {
      ok: false,
      reason: `proven deployment fingerprint changed (${proof.fingerprintSha256.slice(0, 16)} -> ${currentSha256.slice(0, 16)}) — rebuild, test, and record again`,
    }
  }
  return {
    ok: true,
    reason: `proven deployment valid (${proof.credential.scope} @ ${proof.credential.revision}, fingerprint ${proof.fingerprintSha256.slice(0, 16)})`,
    authorization: {
      version: 1,
      kind: 'proven-deployment',
      revision: proof.credential.revision,
      evidenceSha256: proof.fingerprintSha256,
    },
  }
}

/** Fresh evidence wins; an exact prior deployment is the same-launch fallback. */
export function verifyRestartEvidence(
  stateDir: string,
  spec: LaunchSpec,
  maxAgeMinutes: number,
  now = Date.now(),
): RestartEvidenceResult {
  const state = loadState(stateDir)
  const credential = state.credential
  const fresh = verifyCredential(
    state, currentHead(spec.credentialRepo), now, maxAgeMinutes, isWorkingTreeClean(spec.credentialRepo),
  )
  if (fresh.ok && credential !== undefined) {
    return {
      ...fresh,
      authorization: {
        version: 1,
        kind: 'fresh-credential',
        revision: credential.revision,
        evidenceSha256: credentialCommandSha256(credential),
      },
    }
  }
  const proven = verifyProvenDeployment(stateDir, spec)
  if (proven.ok) return proven
  return { ok: false, reason: `${fresh.reason}; pure-restart reuse unavailable: ${proven.reason}` }
}

/** Revalidate the exact evidence selected before the scheduled stop. */
export function verifyRestartAuthorization(
  stateDir: string,
  spec: LaunchSpec,
  authorization: RestartAuthorization,
): RestartEvidenceResult {
  const state = loadState(stateDir)
  if (authorization.kind === 'proven-deployment') {
    const proven = verifyProvenDeployment(stateDir, spec)
    if (!proven.ok || proven.authorization?.evidenceSha256 !== authorization.evidenceSha256) {
      return { ok: false, reason: `scheduled proven-deployment authorization changed: ${proven.reason}` }
    }
    return proven
  }
  const credential = state.credential
  if (credential === undefined
    || credential.revision !== authorization.revision
    || credentialCommandSha256(credential) !== authorization.evidenceSha256) {
    return { ok: false, reason: 'scheduled credential authorization no longer matches durable state' }
  }
  if (currentHead(spec.credentialRepo) !== credential.revision || !isWorkingTreeClean(spec.credentialRepo)) {
    return { ok: false, reason: 'scheduled credential authorization no longer matches a clean repository HEAD' }
  }
  return { ok: true, reason: `scheduled fresh credential still matches ${credential.revision}`, authorization }
}

/**
 * Promote a fresh credential after the boot's readiness/canary boundary. A
 * proof-authorized pure restart retains the existing proof unchanged.
 */
export function proveCurrentDeployment(
  stateDir: string,
  spec: LaunchSpec,
  authorization: RestartAuthorization,
  now = Date.now(),
): RestartEvidenceResult {
  const authorized = verifyRestartAuthorization(stateDir, spec, authorization)
  if (!authorized.ok) return authorized
  if (authorization.kind === 'proven-deployment') {
    return { ...authorized, reason: `${authorized.reason}; existing deployment proof retained` }
  }
  const state = loadState(stateDir)
  const credential = state.credential
  if (credential === undefined) return { ok: false, reason: 'credential disappeared before deployment proof was recorded' }
  let fingerprint: ProvenDeployment['fingerprint']
  try {
    fingerprint = captureDeploymentFingerprint(spec)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (fingerprint.credentialRevision !== credential.revision) {
    return { ok: false, reason: 'deployment fingerprint revision differs from the credential revision' }
  }
  const fingerprintSha256 = deploymentFingerprintSha256(fingerprint)
  const proof: ProvenDeployment = {
    version: 1,
    provenAt: now,
    credential: {
      revision: credential.revision,
      recordedAt: credential.recordedAt,
      scope: credential.scope,
      commandSha256: credentialCommandSha256(credential),
    },
    fingerprint,
    fingerprintSha256,
  }
  setProvenDeployment(stateDir, proof, now)
  return {
    ok: true,
    reason: `recorded proven deployment ${fingerprintSha256.slice(0, 16)} for ${credential.revision}`,
    authorization: {
      version: 1,
      kind: 'proven-deployment',
      revision: credential.revision,
      evidenceSha256: fingerprintSha256,
    },
  }
}
