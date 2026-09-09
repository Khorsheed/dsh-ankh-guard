/**
 * Browser half of the original-tab launch-cutover handoff, plus the
 * boot-generation reload loop: polls carry the last-seen boot id, a stale id
 * with no cutover in flight reloads the tab once, and a sustained disconnection
 * (not a transient blip) raises a neutral overlay.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

const ROUTE = '/_ankh-guard/browser-handoff'
const CAPABILITY_KEY = 'ankh-guard.browser-handoff-capability.v1'
const PENDING_KEY = 'ankh-guard.browser-handoff-pending.v1'
const BOOT_ID_KEY = 'ankh-guard.browser-handoff-boot-id.v1'
const FALLBACK_HASH_KEY = 'ankh-guard-handoff'
const ACTIVE_RETRY_MS = 250
const ERROR_RETRY_MIN_MS = 1_000
const ERROR_RETRY_MAX_MS = 30_000
/** Sustained-failure threshold for the disconnected overlay; transient blips never show it. */
const DISCONNECTED_OVERLAY_MS = 5_000

type HandoffChannel = 'original-tab' | 'fallback-tab'
type HandoffAuthentication = 'existing-cookie' | 'launch-url'

interface PendingHandoff {
  version: 1
  cutoverId: string
  channel: HandoffChannel
  authentication: HandoffAuthentication
  capability?: string
  /** Same-origin, credential-free location to restore after authentication. */
  returnPath?: string
}

interface PollResponse {
  state?: string
  action?: string
  cutoverId?: string
  authentication?: string
  launchUrl?: string
  /** The serving process's boot id, present on every 200 poll response. */
  bootId?: string
}

/** No Cordis services are needed; this is a same-origin browser lifecycle observer. */
export const inject: readonly string[] = []

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function freshCapability(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}

function capability(): string {
  const existing = sessionStorage.getItem(CAPABILITY_KEY)
  if (existing !== null && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing
  const created = freshCapability()
  sessionStorage.setItem(CAPABILITY_KEY, created)
  return created
}

function readPending(): PendingHandoff | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as Partial<PendingHandoff> | null
    if (value?.version !== 1 || typeof value.cutoverId !== 'string'
      || (value.channel !== 'original-tab' && value.channel !== 'fallback-tab')
      || (value.authentication !== 'existing-cookie' && value.authentication !== 'launch-url')) return null
    if (value.channel === 'original-tab' && typeof value.capability !== 'string') return null
    if (value.returnPath !== undefined && !isSafeReturnPath(value.returnPath)) return null
    return value as PendingHandoff
  } catch {
    return null
  }
}

/** Deliberately discard query and fragment because either may hold credentials. */
export function safeReturnPath(href: string, origin: string): string | undefined {
  try {
    const url = new URL(href)
    if (url.origin !== origin || url.pathname === '' || url.pathname.startsWith('//')
      || url.pathname.includes('\\')) return undefined
    return url.pathname
  } catch {
    return undefined
  }
}

function isSafeReturnPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    && !value.includes('\\') && !value.includes('?') && !value.includes('#')
}

function writePending(value: PendingHandoff): void {
  // Deliberately excludes launchUrl: bearer URLs never enter browser storage.
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(value))
}

export function fallbackCutoverId(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const id = params.get(FALLBACK_HASH_KEY)
  return id !== null && /^[A-Za-z0-9._-]{1,160}$/.test(id) ? id : null
}

function consumeFallbackFragment(): PendingHandoff | null {
  const cutoverId = fallbackCutoverId(location.hash)
  if (cutoverId === null) return null
  const url = new URL(location.href)
  url.hash = ''
  history.replaceState(history.state, '', url.href)
  const pending: PendingHandoff = {
    version: 1,
    cutoverId,
    channel: 'fallback-tab',
    authentication: 'launch-url',
  }
  writePending(pending)
  return pending
}

function waitingOverlay(kind: 'restarting' | 'disconnected' = 'restarting'): HTMLElement {
  const existing = document.getElementById('ankh-guard-browser-handoff')
  if (existing !== null) return existing
  const zh = navigator.language.toLowerCase().startsWith('zh')
  const element = document.createElement('div')
  element.id = 'ankh-guard-browser-handoff'
  element.setAttribute('role', 'status')
  element.setAttribute('aria-live', 'polite')
  // 'disconnected' covers failures without a known restart in flight (a bare
  // exit may never come back) — neutral copy, no auto-recovery promise.
  element.textContent = kind === 'disconnected'
    ? (zh ? '连接已断开,等待服务恢复。' : 'Connection lost; waiting for the service to recover.')
    : (zh ? 'dsh 正在重启；此标签页会自动恢复。' : 'dsh is restarting; this tab will recover automatically.')
  element.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647', 'display:grid', 'place-items:center',
    'padding:24px', 'background:rgba(15,18,24,.92)', 'color:#fff',
    'font:500 16px/1.5 system-ui,sans-serif', 'text-align:center',
  ].join(';')
  document.documentElement.append(element)
  return element
}

async function post(body: unknown): Promise<Response> {
  return fetch(ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function acknowledge(pending: PendingHandoff): Promise<boolean> {
  const response = await post({
    version: 1,
    operation: 'ack',
    cutoverId: pending.cutoverId,
    channel: pending.channel,
    authentication: pending.authentication,
    ...(pending.capability !== undefined ? { capability: pending.capability } : {}),
  })
  return response.status === 204
}

/** Install the polling/reload loop for this tab's lifetime. */
export function apply(_ctx: ClientContext): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = consumeFallbackFragment() ?? readPending()
  let cap: string | undefined
  let errorRetryMs = ERROR_RETRY_MIN_MS
  let firstFailureAt: number | undefined

  // Fullscreen notice only for SUSTAINED disconnection (restart window, bare
  // exit): transient network blips and the backoff cadence never trip it.
  const noteDisconnected = (): void => {
    firstFailureAt ??= Date.now()
    if (Date.now() - firstFailureAt >= DISCONNECTED_OVERLAY_MS) waitingOverlay('disconnected')
  }

  const schedule = (delayMs = 0): void => {
    if (!disposed) timer = setTimeout(() => { void tick() }, delayMs)
  }
  const tick = async (): Promise<void> => {
    if (disposed) return
    try {
      if (pending !== null) {
        waitingOverlay()
        if (await acknowledge(pending)) {
          const returnPath = pending.returnPath
          const originalTab = pending.channel === 'original-tab'
          sessionStorage.removeItem(PENDING_KEY)
          sessionStorage.removeItem(CAPABILITY_KEY)
          document.getElementById('ankh-guard-browser-handoff')?.remove()
          pending = null
          if (originalTab && returnPath !== undefined
            && safeReturnPath(location.href, location.origin) !== returnPath) {
            location.replace(returnPath)
            return
          }
        }
        errorRetryMs = ERROR_RETRY_MIN_MS
        firstFailureAt = undefined
        schedule(ACTIVE_RETRY_MS)
        return
      }
      const tabCapability = cap ??= capability()
      const knownBootId = sessionStorage.getItem(BOOT_ID_KEY)
      const response = await post({
        version: 1, operation: 'poll', capability: tabCapability,
        ...(knownBootId === null ? {} : { knownBootId }),
      })
      if (!response.ok) {
        noteDisconnected()
        schedule(errorRetryMs)
        errorRetryMs = Math.min(errorRetryMs * 2, ERROR_RETRY_MAX_MS)
        return
      }
      errorRetryMs = ERROR_RETRY_MIN_MS
      firstFailureAt = undefined
      const result = await response.json() as PollResponse
      // Learn the serving boot id before acting on it — storing the successor's
      // id ahead of the reload is what makes the generation check one-shot.
      if (typeof result.bootId === 'string') sessionStorage.setItem(BOOT_ID_KEY, result.bootId)
      if (result.state === 'idle') {
        document.getElementById('ankh-guard-browser-handoff')?.remove()
        // The server holds idle polls, providing event-like wakeup without a
        // permanent fixed-frequency request loop.
        schedule()
        return
      }
      if (result.state === 'waiting') waitingOverlay()
      // Boot-generation reload (no cutoverId): the process this tab knew is
      // gone. No registration/ack dance — the stored id already advanced.
      if (result.state === 'ready' && result.action === 'reload' && typeof result.cutoverId !== 'string') {
        location.reload()
        return
      }
      if (result.state !== 'ready' || typeof result.cutoverId !== 'string') {
        schedule(ACTIVE_RETRY_MS)
        return
      }
      if (result.action === 'reload' && result.authentication === 'existing-cookie') {
        const returnPath = safeReturnPath(location.href, location.origin)
        const nextPending: PendingHandoff = {
          version: 1, cutoverId: result.cutoverId, channel: 'original-tab',
          authentication: 'existing-cookie', capability: tabCapability,
          ...(returnPath === undefined ? {} : { returnPath }),
        }
        pending = nextPending
        writePending(nextPending)
        waitingOverlay()
        location.reload()
        return
      }
      if (result.action === 'replace' && result.authentication === 'launch-url'
        && typeof result.launchUrl === 'string') {
        const launch = new URL(result.launchUrl)
        if (launch.origin !== location.origin || launch.pathname !== '/' || launch.search === ''
          || launch.username !== '' || launch.password !== '' || launch.hash !== '') {
          schedule(ACTIVE_RETRY_MS)
          return
        }
        const returnPath = safeReturnPath(location.href, location.origin)
        const nextPending: PendingHandoff = {
          version: 1, cutoverId: result.cutoverId, channel: 'original-tab',
          authentication: 'launch-url', capability: tabCapability,
          ...(returnPath === undefined ? {} : { returnPath }),
        }
        pending = nextPending
        writePending(nextPending)
        waitingOverlay()
        // The bearer remains a local variable for the shortest possible time.
        location.replace(launch.href)
        return
      }
    } catch {
      // The expected restart interval rejects fetches; keep the old page and retry.
      noteDisconnected()
      schedule(errorRetryMs)
      errorRetryMs = Math.min(errorRetryMs * 2, ERROR_RETRY_MAX_MS)
      return
    }
    schedule(ACTIVE_RETRY_MS)
  }
  void tick()
  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
