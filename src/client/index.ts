/**
 * Browser half of the original-tab launch-cutover handoff, plus the
 * boot-generation reload loop: polls carry the last-seen boot id, a stale id
 * with no cutover in flight reloads the tab once, and a sustained disconnection
 * (not a transient blip) raises a non-blocking connection notice.
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
/** Sustained-failure threshold for the connection notice; transient blips never show it. */
const DISCONNECTED_NOTICE_MS = 5_000
// Server idle polls hold for 25s; bound a stalled browser request beyond that.
const REQUEST_TIMEOUT_MS = 35_000

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

function waitingOverlay(kind: 'restarting' | 'disconnected' = 'restarting', retry?: () => void): HTMLElement {
  const existing = document.getElementById('ankh-guard-browser-handoff')
  // A confirmed restart cannot be downgraded by a subsequent transport failure.
  if (existing?.dataset.kind === 'restarting' && kind === 'disconnected') return existing
  const element = existing ?? document.createElement('div')
  const zh = navigator.language.toLowerCase().startsWith('zh')
  element.id = 'ankh-guard-browser-handoff'
  element.dataset.kind = kind
  element.setAttribute('role', 'status')
  element.setAttribute('aria-live', 'polite')
  element.textContent = kind === 'disconnected'
    ? (zh ? '连接暂时中断，正在重试…' : 'Connection interrupted; retrying…')
    : (zh ? 'dsh 正在重启；此标签页会自动恢复。' : 'dsh is restarting; this tab will recover automatically.')
  element.style.cssText = kind === 'restarting' ? [
    'position:fixed', 'inset:0', 'z-index:2147483647', 'display:grid', 'place-items:center',
    'padding:24px', 'background:rgba(15,18,24,.92)', 'color:#fff',
    'font:500 16px/1.5 system-ui,sans-serif', 'text-align:center',
  ].join(';') : [
    'position:fixed', 'top:calc(env(safe-area-inset-top,0px) + 12px)', 'left:12px', 'right:12px',
    'max-width:520px', 'margin:0 auto', 'box-sizing:border-box', 'z-index:2147483647',
    'display:flex', 'align-items:center', 'justify-content:space-between', 'gap:12px',
    'padding:12px 16px', 'border:1px solid var(--dsw-alias-border-l2,#8885)', 'border-radius:16px',
    'background:var(--dsw-alias-bg-base,#fff)', 'color:var(--dsw-alias-label-primary,#181a20)',
    'box-shadow:0 4px 24px #0002', 'font:400 15px/1.5 system-ui,sans-serif',
  ].join(';')
  if (kind === 'disconnected' && retry) {
    const button = document.createElement('button')
    button.textContent = zh ? '重试' : 'Retry'
    button.style.cssText = 'flex:none;border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#4d6bfe);font:inherit;min-height:36px;cursor:pointer'
    button.onclick = retry
    element.append(button)
  }
  // Official theme tokens live on body, so the notice must inherit from it.
  if (!existing) (document.body ?? document.documentElement).append(element)
  return element
}

async function post(body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(ROUTE, {
    method: 'POST',
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function acknowledge(pending: PendingHandoff, signal: AbortSignal): Promise<boolean> {
  const response = await post({
    version: 1,
    operation: 'ack',
    cutoverId: pending.cutoverId,
    channel: pending.channel,
    authentication: pending.authentication,
    ...(pending.capability !== undefined ? { capability: pending.capability } : {}),
  }, signal)
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
  let request: AbortController | undefined
  let lastWakeAt = -Infinity
  const foreground = () => document.visibilityState !== 'hidden' && navigator.onLine !== false
  const clearConnectionNotice = () => {
    const notice = document.getElementById('ankh-guard-browser-handoff')
    if (notice?.dataset.kind === 'disconnected') notice.remove()
  }
  const pause = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const previous = request; request = undefined; previous?.abort()
    firstFailureAt = undefined; errorRetryMs = ERROR_RETRY_MIN_MS
    clearConnectionNotice()
  }
  const wake = () => {
    if (disposed || !foreground() || Date.now() - lastWakeAt < 500) return
    lastWakeAt = Date.now()
    pause()
    schedule()
  }
  const visibility = () => {
    if (!foreground()) { lastWakeAt = -Infinity; pause() } else wake()
  }
  const page = (event: PageTransitionEvent) => { if (event.persisted) wake() }

  // Only visible failures count. Ordinary outages never block the page.
  const noteDisconnected = (): void => {
    firstFailureAt ??= Date.now()
    if (Date.now() - firstFailureAt >= DISCONNECTED_NOTICE_MS) waitingOverlay('disconnected', wake)
  }

  const schedule = (delayMs = 0): void => {
    if (timer !== undefined) clearTimeout(timer)
    if (!disposed && foreground()) timer = setTimeout(() => { timer = undefined; void tick() }, delayMs)
  }
  const tick = async (): Promise<void> => {
    if (disposed || !foreground() || request) return
    const current = new AbortController(); request = current
    const stale = () => disposed || request !== current || !foreground()
    const deadline = setTimeout(() => current.abort(), REQUEST_TIMEOUT_MS)
    try {
      if (pending !== null) {
        waitingOverlay()
        const acknowledged = await acknowledge(pending, current.signal)
        if (stale()) return
        if (acknowledged) {
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
      }, current.signal)
      if (stale()) return
      if (!response.ok) {
        noteDisconnected()
        schedule(errorRetryMs)
        errorRetryMs = Math.min(errorRetryMs * 2, ERROR_RETRY_MAX_MS)
        return
      }
      errorRetryMs = ERROR_RETRY_MIN_MS
      firstFailureAt = undefined
      const result = await response.json() as PollResponse
      if (stale()) return
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
      if (stale()) return
      // The expected restart interval rejects fetches; keep the old page and retry.
      noteDisconnected()
      schedule(errorRetryMs)
      errorRetryMs = Math.min(errorRetryMs * 2, ERROR_RETRY_MAX_MS)
      return
    } finally {
      clearTimeout(deadline)
      if (request === current) request = undefined
    }
    schedule(ACTIVE_RETRY_MS)
  }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('online', wake)
  window.addEventListener('offline', visibility)
  window.addEventListener('pageshow', page)
  window.addEventListener('dsh-mobile-foreground', wake)
  void tick()
  return () => {
    disposed = true
    pause()
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('online', wake)
    window.removeEventListener('offline', visibility)
    window.removeEventListener('pageshow', page)
    window.removeEventListener('dsh-mobile-foreground', wake)
    document.getElementById('ankh-guard-browser-handoff')?.remove()
  }
}
