/**
 * Browser handoff bridge for launch cutovers.
 *
 * Old authenticated pages register random per-tab capabilities while the
 * previous process is still the proven listener. Only SHA-256 digests are
 * durable. After the successor proves one stable listener and passes canary,
 * every registered tab may ask the final process for either a plain reload
 * (its cookie is still valid) or that process's authenticated URL. The URL
 * exists only in the response object and the browser's location.replace call:
 * it never enters a state file, receipt, or log.
 *
 * Alongside the cutover channel, a boot-generation channel covers ordinary
 * restarts (unsupervised `restart`/`schedule-exit`, watchdog crash respawns):
 * the serving process's own pid + start token is its boot id, a polling tab
 * carries the boot id it last saw, and a stale id with no active cutover
 * means the process it knew is gone — answer ready/reload. A cutover receipt
 * always wins over the generation check: during a cutover the old tab's known
 * id is already stale, and the receipt protocol owns the pacing.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { activeCutover, readCutoverReceipt, type CutoverProcessOwnership, type LaunchRole } from './launch-spec.ts'
import { processIdentity, processIdentityMatches, type ProcessIdentity } from './processes.ts'
import { stateFile } from './state-files.ts'

export const BROWSER_HANDOFF_ROUTE = '/_ankh-guard/browser-handoff'

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_BODY_BYTES = 4096
const MAX_REGISTRATIONS = 64
const DEFAULT_LONG_POLL_MS = 25_000
const DEFAULT_LONG_POLL_INTERVAL_MS = 200

export type BrowserHandoffChannel = 'original-tab' | 'fallback-tab'
export type BrowserHandoffAuthentication = 'existing-cookie' | 'launch-url'

export interface BrowserHandoffRegistration {
  authority: string
  capabilitySha256: string
  armedAt: number
  acknowledgedAt?: number
}

export interface BrowserHandoffRequest {
  version: 2
  cutoverId: string
  registrations: BrowserHandoffRegistration[]
}

export interface BrowserHandoffAcknowledgement {
  version: 1
  cutoverId: string
  role: LaunchRole
  authority: string
  listenerPid: number
  listenerStartToken: string
  channel: BrowserHandoffChannel
  authentication: BrowserHandoffAuthentication
  acknowledgedAt: number
}

interface PollMessage {
  version: 1
  operation: 'poll'
  capability: string
  /** The boot id this tab last learned, when it has one (boot-generation channel). */
  knownBootId?: string
}

interface AcknowledgeMessage {
  version: 1
  operation: 'ack'
  cutoverId: string
  channel: BrowserHandoffChannel
  authentication: BrowserHandoffAuthentication
  capability?: string
}

type BrowserMessage = PollMessage | AcknowledgeMessage

interface WebServerSlice {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface ConnectionSlice {
  requestRejection?(request: IncomingMessage): 401 | 403 | undefined
  authenticatedUrl?(baseUrl: string): string
}

interface BrowserHandoffDependencies {
  stateDir: string
  pid?: number
  now?: () => number
  identityMatches?: typeof processIdentityMatches
  /** Boot-id source for the generation channel; production default is the serving process itself. */
  identityProvider?: (pid: number) => ProcessIdentity | null
  connection?: ConnectionSlice
  /** Resolve lazily because WebServer can activate before the optional connection service. */
  connectionProvider?: () => ConnectionSlice | undefined
  /** Test seams; production defaults turn idle polling into a held request. */
  longPollMs?: number
  longPollIntervalMs?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCapability(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_PATTERN.test(value)
}

function capabilitySha256(capability: string): string {
  return createHash('sha256').update(capability).digest('hex')
}

function parseMessage(value: unknown): BrowserMessage | null {
  if (!isObject(value) || value.version !== 1) return null
  if (value.operation === 'poll' && isCapability(value.capability)) {
    // Opaque to the server; length-capped so a poll cannot carry bulk data.
    const knownBootId = typeof value.knownBootId === 'string' && value.knownBootId.length <= 256
      ? value.knownBootId
      : undefined
    return { version: 1, operation: 'poll', capability: value.capability, ...(knownBootId === undefined ? {} : { knownBootId }) }
  }
  if (value.operation !== 'ack' || typeof value.cutoverId !== 'string' || value.cutoverId === '') return null
  if (value.channel !== 'original-tab' && value.channel !== 'fallback-tab') return null
  if (value.authentication !== 'existing-cookie' && value.authentication !== 'launch-url') return null
  if (value.channel === 'original-tab' && !isCapability(value.capability)) return null
  return {
    version: 1,
    operation: 'ack',
    cutoverId: value.cutoverId,
    channel: value.channel,
    authentication: value.authentication,
    ...(typeof value.capability === 'string' ? { capability: value.capability } : {}),
  }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null }
}

function createJsonOnce(file: string, value: unknown): boolean {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    // Publishing a complete hard link is both atomic for readers and
    // first-writer-wins across competing tabs/processes.
    linkSync(tmp, file)
    try { chmodSync(file, 0o600) } catch { /* best effort on non-POSIX filesystems */ }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    unlinkSync(tmp)
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    renameSync(tmp, file)
    try { chmodSync(file, 0o600) } catch { /* best effort on non-POSIX filesystems */ }
  } finally {
    try { unlinkSync(tmp) } catch { /* rename already consumed the temporary file */ }
  }
}

function validRegistration(value: unknown): value is BrowserHandoffRegistration {
  return isObject(value) && typeof value.authority === 'string' && value.authority !== ''
    && typeof value.capabilitySha256 === 'string' && /^[a-f0-9]{64}$/.test(value.capabilitySha256)
    && typeof value.armedAt === 'number' && Number.isFinite(value.armedAt)
    && (value.acknowledgedAt === undefined
      || (typeof value.acknowledgedAt === 'number' && Number.isFinite(value.acknowledgedAt)))
}

export function readBrowserHandoffRequest(stateDir: string): BrowserHandoffRequest | null {
  const request = readJson<Partial<BrowserHandoffRequest>>(stateFile(stateDir, 'browserHandoffRequest'))
  if (request?.version !== 2 || typeof request.cutoverId !== 'string'
    || !Array.isArray(request.registrations) || request.registrations.length === 0
    || request.registrations.length > MAX_REGISTRATIONS
    || !request.registrations.every(validRegistration)) return null
  return request as BrowserHandoffRequest
}

function registerBrowserTab(
  stateDir: string,
  cutoverId: string,
  registration: BrowserHandoffRegistration,
): BrowserHandoffRequest | null {
  const existing = readBrowserHandoffRequest(stateDir)
  const registrations = existing?.cutoverId === cutoverId ? [...existing.registrations] : []
  if (!registrations.some(item => item.authority === registration.authority
    && item.capabilitySha256 === registration.capabilitySha256)) {
    if (registrations.length >= MAX_REGISTRATIONS) return null
    registrations.push(registration)
  }
  const request: BrowserHandoffRequest = { version: 2, cutoverId, registrations }
  writeJsonAtomic(stateFile(stateDir, 'browserHandoffRequest'), request)
  return request
}

function registrationMatches(
  request: BrowserHandoffRequest | null,
  cutoverId: string,
  authority: string,
  digest: string,
): boolean {
  return request?.cutoverId === cutoverId && request.registrations.some(item => (
    item.authority === authority && item.capabilitySha256 === digest
  ))
}

function matchingRegistration(
  request: BrowserHandoffRequest | null,
  cutoverId: string,
  authority: string,
  digest: string,
): BrowserHandoffRegistration | undefined {
  if (request?.cutoverId !== cutoverId) return undefined
  return request.registrations.find(item => (
    item.authority === authority && item.capabilitySha256 === digest
  ))
}

function acknowledgeBrowserTab(
  stateDir: string,
  cutoverId: string,
  authority: string,
  digest: string,
  acknowledgedAt: number,
): boolean {
  const request = readBrowserHandoffRequest(stateDir)
  const registration = matchingRegistration(request, cutoverId, authority, digest)
  if (request === null || registration === undefined) return false
  registration.acknowledgedAt = acknowledgedAt
  writeJsonAtomic(stateFile(stateDir, 'browserHandoffRequest'), request)
  return true
}

export function readBrowserHandoffAcknowledgement(stateDir: string): BrowserHandoffAcknowledgement | null {
  const ack = readJson<Partial<BrowserHandoffAcknowledgement>>(stateFile(stateDir, 'browserHandoffAck'))
  if (ack?.version !== 1 || typeof ack.cutoverId !== 'string'
    || (ack.role !== 'target' && ack.role !== 'previous')
    || typeof ack.authority !== 'string' || ack.authority === ''
    || !Number.isInteger(ack.listenerPid) || (ack.listenerPid ?? 0) <= 0
    || typeof ack.listenerStartToken !== 'string' || ack.listenerStartToken === ''
    || (ack.channel !== 'original-tab' && ack.channel !== 'fallback-tab')
    || (ack.authentication !== 'existing-cookie' && ack.authentication !== 'launch-url')
    || typeof ack.acknowledgedAt !== 'number') return null
  return ack as BrowserHandoffAcknowledgement
}

function authorityOf(req: IncomingMessage): { authority: string; origin: string } | null {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string' || typeof origin !== 'string') return null
  try {
    const parsed = new URL(origin)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host !== host || parsed.origin !== origin) return null
    return { authority: parsed.host, origin: parsed.origin }
  } catch {
    return null
  }
}

function ownershipMatches(
  ownership: CutoverProcessOwnership | undefined,
  pid: number,
  identityMatches: typeof processIdentityMatches,
): ownership is CutoverProcessOwnership {
  return ownership !== undefined && ownership.listenerPid === pid
    && identityMatches({ pid, startToken: ownership.listenerStartToken })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(`${JSON.stringify(body)}\n`)
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function currentReadyOwnership(
  stateDir: string,
  pid: number,
  identityMatches: typeof processIdentityMatches,
): { cutoverId: string; role: LaunchRole; ownership: CutoverProcessOwnership; protected: boolean } | null {
  const receipt = readCutoverReceipt(stateDir)
  if (receipt === null || receipt.phase === 'awaiting-user' || receipt.readiness?.retryCount !== 0) return null
  const role = receipt.readiness.role
  const ownership = role === 'target' ? receipt.ownership.target : receipt.ownership.restored
  const canarySettled = role === 'target'
    ? receipt.targetValidation?.canary?.outcome === 'pass'
    : receipt.recovery.validation?.canary !== undefined
  if (!ownershipMatches(ownership, pid, identityMatches)
    || !canarySettled
    || receipt.readiness.listenerPid !== ownership.listenerPid
    || receipt.readiness.childPid !== ownership.childPid) return null
  return {
    cutoverId: receipt.id,
    role,
    ownership,
    protected: receipt.authentication.launchUrlObserved === true,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForPollState(
  ready: () => boolean,
  waitMs: number,
  intervalMs: number,
): Promise<void> {
  if (ready() || waitMs <= 0) return
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())))
    if (ready()) return
  }
}

function authenticationState(
  connection: ConnectionSlice | undefined, req: IncomingMessage,
): 'authenticated' | 'unauthenticated' | 'forbidden' | 'legacy-public' {
  if (connection?.requestRejection === undefined) return 'legacy-public'
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return 'authenticated'
  return rejection === 403 ? 'forbidden' : 'unauthenticated'
}

/** Create the exact HTTP handler; dependencies are injectable for deterministic protocol tests. */
export function createBrowserHandoffHandler(dependencies: BrowserHandoffDependencies) {
  const pid = dependencies.pid ?? process.pid
  const now = dependencies.now ?? Date.now
  const identityMatches = dependencies.identityMatches ?? processIdentityMatches
  const identityProvider = dependencies.identityProvider ?? processIdentity
  const longPollMs = dependencies.longPollMs ?? DEFAULT_LONG_POLL_MS
  const longPollIntervalMs = dependencies.longPollIntervalMs ?? DEFAULT_LONG_POLL_INTERVAL_MS
  // Cached: a process's boot id never changes over its lifetime, and the
  // platform lookup (ps/python3) must not run per held poll.
  let bootIdCache: string | null | undefined
  const thisBootId = (): string | undefined => {
    if (bootIdCache === undefined) {
      const identity = identityProvider(pid)
      bootIdCache = identity === null ? null : `${String(identity.pid)}:${identity.startToken}`
    }
    return bootIdCache ?? undefined
  }
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const connection = dependencies.connectionProvider?.() ?? dependencies.connection
    if (req.method !== 'POST' || req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      json(res, 404, { state: 'unavailable' })
      return
    }
    const requestAuthority = authorityOf(req)
    if (requestAuthority === null) {
      json(res, 403, { state: 'forbidden' })
      return
    }
    let message: BrowserMessage | null
    try { message = parseMessage(await bodyOf(req)) } catch { message = null }
    if (message === null) {
      json(res, 400, { state: 'invalid' })
      return
    }

    if (message.operation === 'poll') {
      const digest = capabilitySha256(message.capability)
      // The serving process's boot id rides every poll response so a tab can
      // learn it. Computed once: a process's identity never changes while it
      // lives. Unavailable identity (ps blocked) disables the generation
      // channel — polls degrade to the pre-generation flow, like an old client.
      const bootId = thisBootId()
      const respond = (status: number, body: Record<string, unknown>): void => {
        json(res, status, bootId === undefined ? body : { ...body, bootId })
      }
      // Boot-generation channel: a stale known id with NO active cutover means
      // the process this tab knew is gone (ordinary restart or crash respawn).
      // Short-circuits before the held-poll wait — this process's boot id
      // cannot change under it. During a cutover the receipt protocol owns the
      // pacing: the old tab's known id is already stale, and answering here
      // would race the registration/ack dance.
      if (bootId !== undefined && message.knownBootId !== undefined && message.knownBootId !== bootId
        && activeCutover(dependencies.stateDir) === null) {
        respond(200, { state: 'ready', action: 'reload', authentication: 'existing-cookie' })
        return
      }
      const pollHasState = (): boolean => {
        const active = activeCutover(dependencies.stateDir)
        if (active !== null) {
          if (active.receipt.phase === 'awaiting-user'
            || active.receipt.browserHandoff.status === 'off') return true
          if (ownershipMatches(active.receipt.ownership.previous, pid, identityMatches)) {
            return !registrationMatches(
              readBrowserHandoffRequest(dependencies.stateDir), active.receipt.id,
              requestAuthority.authority, digest,
            )
          }
          return currentReadyOwnership(dependencies.stateDir, pid, identityMatches) !== null
        }
        const ready = currentReadyOwnership(dependencies.stateDir, pid, identityMatches)
        const registration = readBrowserHandoffRequest(dependencies.stateDir)
        return ready !== null && matchingRegistration(
          registration, ready.cutoverId, requestAuthority.authority, digest,
        )?.acknowledgedAt === undefined
      }
      await waitForPollState(pollHasState, longPollMs, longPollIntervalMs)
      const active = activeCutover(dependencies.stateDir)
      const ready = currentReadyOwnership(dependencies.stateDir, pid, identityMatches)
      const registration = readBrowserHandoffRequest(dependencies.stateDir)
      const registered = ready === null ? undefined : matchingRegistration(
        registration, ready.cutoverId, requestAuthority.authority, digest,
      )
      if (registered?.acknowledgedAt !== undefined
        || (active === null && (ready === null || registered === undefined))
        || active?.receipt.phase === 'awaiting-user'
        || active?.receipt.browserHandoff.status === 'off') {
        respond(200, { state: 'idle' })
        return
      }
      const previous = active?.receipt.ownership.previous
      if (active !== null && ownershipMatches(previous, pid, identityMatches)) {
        const oldAuthentication = authenticationState(connection, req)
        if (oldAuthentication === 'unauthenticated' || oldAuthentication === 'forbidden') {
          json(res, 401, { state: 'unauthorized' })
          return
        }
        const registration: BrowserHandoffRegistration = {
          authority: requestAuthority.authority,
          capabilitySha256: digest,
          armedAt: now(),
        }
        const selected = registerBrowserTab(dependencies.stateDir, active.receipt.id, registration)
        respond(200, registrationMatches(
          selected, active.receipt.id, requestAuthority.authority, digest,
        )
          ? { state: 'waiting', cutoverId: active.receipt.id }
          : { state: 'standby', cutoverId: active.receipt.id })
        return
      }

      if (ready === null || (active !== null && ready.cutoverId !== active.receipt.id)
        || !registrationMatches(
          registration, ready?.cutoverId ?? '', requestAuthority.authority, digest,
        )) {
        respond(200, active === null
          ? { state: 'idle' }
          : { state: 'waiting', cutoverId: active.receipt.id })
        return
      }
      // A protected listener may expose the route before its optional
      // connection service settles. Do not misclassify that startup window as
      // a public/valid-cookie host and strand the original tab on a bare 401.
      if (ready.protected && connection?.requestRejection === undefined) {
        respond(200, { state: 'waiting', cutoverId: ready.cutoverId })
        return
      }
      const cookieState = authenticationState(connection, req)
      if (cookieState === 'forbidden') {
        json(res, 403, { state: 'forbidden' })
        return
      }
      if (cookieState !== 'unauthenticated') {
        respond(200, {
          state: 'ready', action: 'reload', cutoverId: ready.cutoverId,
          role: ready.role, authentication: 'existing-cookie',
        })
        return
      }
      if (connection?.authenticatedUrl === undefined) {
        respond(200, { state: 'waiting', cutoverId: ready.cutoverId })
        return
      }
      let launchUrl: string
      try {
        launchUrl = connection.authenticatedUrl(requestAuthority.origin)
      } catch {
        json(res, 500, { state: 'unavailable' })
        return
      }
      let safe = false
      try {
        const parsed = new URL(launchUrl)
        safe = parsed.origin === requestAuthority.origin && parsed.pathname === '/'
          && parsed.username === '' && parsed.password === '' && parsed.search !== '' && parsed.hash === ''
      } catch { /* unsafe provider output */ }
      if (!safe) {
        json(res, 500, { state: 'unavailable' })
        return
      }
      respond(200, {
        state: 'ready', action: 'replace', cutoverId: ready.cutoverId,
        role: ready.role, authentication: 'launch-url', launchUrl,
      })
      return
    }

    const receipt = readCutoverReceipt(dependencies.stateDir)
    if (receipt === null || receipt.id !== message.cutoverId) {
      json(res, 409, { state: 'stale' })
      return
    }
    const ready = currentReadyOwnership(dependencies.stateDir, pid, identityMatches)
    if (ready === null || ready.cutoverId !== message.cutoverId) {
      json(res, 409, { state: 'waiting' })
      return
    }
    if (ready.protected && connection?.requestRejection === undefined) {
      json(res, 409, { state: 'waiting' })
      return
    }
    const ackAuthentication = authenticationState(connection, req)
    if (ackAuthentication === 'unauthenticated' || ackAuthentication === 'forbidden') {
      json(res, ackAuthentication === 'forbidden' ? 403 : 401, {
        state: ackAuthentication === 'forbidden' ? 'forbidden' : 'unauthorized',
      })
      return
    }
    const acknowledgedAt = now()
    if (message.channel === 'original-tab') {
      const registration = readBrowserHandoffRequest(dependencies.stateDir)
      if (message.capability === undefined || !registrationMatches(
        registration, message.cutoverId, requestAuthority.authority,
        capabilitySha256(message.capability),
      )) {
        json(res, 403, { state: 'forbidden' })
        return
      }
      if (!acknowledgeBrowserTab(
        dependencies.stateDir, message.cutoverId, requestAuthority.authority,
        capabilitySha256(message.capability), acknowledgedAt,
      )) {
        json(res, 409, { state: 'conflict' })
        return
      }
    }
    const acknowledgement: BrowserHandoffAcknowledgement = {
      version: 1,
      cutoverId: message.cutoverId,
      role: ready.role,
      authority: requestAuthority.authority,
      listenerPid: ready.ownership.listenerPid,
      listenerStartToken: ready.ownership.listenerStartToken,
      channel: message.channel,
      authentication: message.authentication,
      acknowledgedAt,
    }
    const ackFile = stateFile(dependencies.stateDir, 'browserHandoffAck')
    if (!createJsonOnce(ackFile, acknowledgement)) {
      const existing = readBrowserHandoffAcknowledgement(dependencies.stateDir)
      if (existing?.cutoverId !== acknowledgement.cutoverId
        || existing.listenerPid !== acknowledgement.listenerPid
        || existing.listenerStartToken !== acknowledgement.listenerStartToken) {
        json(res, 409, { state: 'conflict' })
        return
      }
    }
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  }
}

/** Register the optional Web-profile bridge; headless/TUI compositions simply never activate it. */
export function registerBrowserHandoff(ctx: Context, stateDir: string): void {
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer') as WebServerSlice | undefined
    if (webServer === undefined) return
    const handler = createBrowserHandoffHandler({
      stateDir,
      connectionProvider: () => webCtx.get('connection') as ConnectionSlice | undefined,
    })
    webCtx.effect(() => webServer.register({ kind: 'exact', path: BROWSER_HANDOFF_ROUTE, handler }), 'ankh-guard: browser handoff route')
  })
}
