// @vitest-environment jsdom
/** Browser loop: in-place replacement/reload and authenticated page acknowledgement. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

const CAPABILITY_KEY = 'ankh-guard.browser-handoff-capability.v1'
const PENDING_KEY = 'ankh-guard.browser-handoff-pending.v1'
const BOOT_ID_KEY = 'ankh-guard.browser-handoff-boot-id.v1'

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  })
}

describe('browser handoff client lifecycle', () => {
  beforeEach(() => {
    sessionStorage.clear()
    document.documentElement.innerHTML = '<head></head><body></body>'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('keeps the final launch URL out of storage and replaces the original tab', async () => {
    const replace = vi.fn()
    vi.stubGlobal('location', {
      hash: '',
      href: 'http://127.0.0.1:3080/session/one',
      origin: 'http://127.0.0.1:3080',
      reload: vi.fn(),
      replace,
    })
    const launchUrl = 'http://127.0.0.1:3080/?token=final-process-only'
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      state: 'ready',
      action: 'replace',
      cutoverId: 'cutover-client-replace',
      authentication: 'launch-url',
      launchUrl,
    })))

    const dispose = apply({} as never)
    await vi.waitFor(() => { expect(replace).toHaveBeenCalledWith(launchUrl) })
    expect(sessionStorage.getItem(PENDING_KEY)).toContain('cutover-client-replace')
    expect(sessionStorage.getItem(PENDING_KEY)).toContain('/session/one')
    const stored = Array.from({ length: sessionStorage.length }, (_, index) => (
      sessionStorage.getItem(sessionStorage.key(index) ?? '') ?? ''
    )).join('\n')
    expect(stored).not.toContain('final-process-only')
    expect(document.getElementById('ankh-guard-browser-handoff')).not.toBeNull()
    dispose()

    replace.mockClear()
    vi.stubGlobal('location', {
      hash: '',
      href: 'http://127.0.0.1:3080/',
      origin: 'http://127.0.0.1:3080',
      reload: vi.fn(),
      replace,
    })
    vi.stubGlobal('fetch', vi.fn(async () => response(204)))
    const authenticatedDispose = apply({} as never)
    await vi.waitFor(() => { expect(replace).toHaveBeenCalledWith('/session/one') })
    expect(sessionStorage.length).toBe(0)
    authenticatedDispose()
  })

  it('reloads with an existing cookie and acknowledges only after the new page loads', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', {
      hash: '',
      href: 'http://127.0.0.1:3080/session/one',
      origin: 'http://127.0.0.1:3080',
      reload,
      replace: vi.fn(),
    })
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(200, {
      state: 'ready',
      action: 'reload',
      cutoverId: 'cutover-client-reload',
      authentication: 'existing-cookie',
    }))
    vi.stubGlobal('fetch', fetch)

    const firstDispose = apply({} as never)
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    firstDispose()
    const pending = sessionStorage.getItem(PENDING_KEY)
    expect(pending).toContain('existing-cookie')
    expect(pending).toContain(sessionStorage.getItem(CAPABILITY_KEY))

    fetch.mockImplementation(async () => response(204))
    const secondDispose = apply({} as never)
    await vi.waitFor(() => { expect(sessionStorage.getItem(PENDING_KEY)).toBeNull() })
    expect(sessionStorage.getItem(CAPABILITY_KEY)).toBeNull()
    expect(document.getElementById('ankh-guard-browser-handoff')).toBeNull()
    const ack = JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>
    expect(ack).toMatchObject({
      operation: 'ack',
      cutoverId: 'cutover-client-reload',
      channel: 'original-tab',
      authentication: 'existing-cookie',
    })
    secondDispose()
  })

  it('consumes the fallback fragment and acknowledges from the authenticated fallback page', async () => {
    const replaceState = vi.fn()
    vi.stubGlobal('location', {
      hash: '#ankh-guard-handoff=cutover-fallback-page',
      href: 'http://127.0.0.1:3080/#ankh-guard-handoff=cutover-fallback-page',
      origin: 'http://127.0.0.1:3080',
      reload: vi.fn(),
      replace: vi.fn(),
    })
    vi.stubGlobal('history', { state: null, replaceState })
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(204))
    vi.stubGlobal('fetch', fetch)

    const dispose = apply({} as never)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(sessionStorage.getItem(PENDING_KEY)).toBeNull() })
    const ack = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(ack).toMatchObject({
      operation: 'ack',
      cutoverId: 'cutover-fallback-page',
      channel: 'fallback-tab',
      authentication: 'launch-url',
    })
    expect(ack).not.toHaveProperty('capability')
    expect(replaceState).toHaveBeenCalledOnce()
    expect(sessionStorage.length).toBe(0)
    dispose()
  })

  it('dismisses a stale waiting overlay after a public or restored cutover settles', async () => {
    vi.stubGlobal('location', {
      hash: '',
      href: 'http://127.0.0.1:3080/session/one',
      origin: 'http://127.0.0.1:3080',
      reload: vi.fn(),
      replace: vi.fn(),
    })
    const overlay = document.createElement('div')
    overlay.id = 'ankh-guard-browser-handoff'
    document.documentElement.append(overlay)
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { state: 'idle' })))

    const dispose = apply({} as never)
    await vi.waitFor(() => {
      expect(document.getElementById('ankh-guard-browser-handoff')).toBeNull()
    })
    dispose()
  })

  it('learns the serving boot id from idle and carries it on the next poll', async () => {
    vi.stubGlobal('location', {
      hash: '',
      href: 'http://127.0.0.1:3080/',
      origin: 'http://127.0.0.1:3080',
      reload: vi.fn(),
      replace: vi.fn(),
    })
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return response(200, { state: 'idle', bootId: '100:a' })
    }))

    const dispose = apply({} as never)
    await vi.waitFor(() => { expect(bodies.length).toBeGreaterThanOrEqual(2) })
    expect(bodies[0]).not.toHaveProperty('knownBootId')
    expect(sessionStorage.getItem(BOOT_ID_KEY)).toBe('100:a')
    expect(bodies[1]?.knownBootId).toBe('100:a')
    dispose()
  })

  it('reloads once on a boot-generation change without the cutover ack dance', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', {
      hash: '',
      href: 'http://127.0.0.1:3080/session/one',
      origin: 'http://127.0.0.1:3080',
      reload,
      replace: vi.fn(),
    })
    sessionStorage.setItem(BOOT_ID_KEY, '100:old')
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return response(200, {
        state: 'ready', action: 'reload', authentication: 'existing-cookie', bootId: '200:new',
      })
    }))

    const dispose = apply({} as never)
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    expect(bodies[0]?.knownBootId).toBe('100:old')
    // The successor's id is stored BEFORE the reload — the next page polls as
    // a current tab, which is what makes the generation reload one-shot.
    expect(sessionStorage.getItem(BOOT_ID_KEY)).toBe('200:new')
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull()
    dispose()
  })

  it('holds a stale tab while the successor composition is still mounting', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', {
      hash: '',
      href: 'http://127.0.0.1:3080/session/one',
      origin: 'http://127.0.0.1:3080',
      reload,
      replace: vi.fn(),
    })
    sessionStorage.setItem(BOOT_ID_KEY, '100:old')
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      // The successor's Web-server seat answers before its rows mount: a hold
      // that deliberately carries no boot id.
      if (bodies.length === 1) return response(200, { state: 'waiting' })
      return response(200, {
        state: 'ready', action: 'reload', authentication: 'existing-cookie', bootId: '200:new',
      })
    }))

    const dispose = apply({} as never)
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    // The held poll neither reloads nor teaches the successor's id — the tab
    // re-asks with the same stale id until readiness lands, then reloads.
    expect(bodies[1]?.knownBootId).toBe('100:old')
    expect(reload).toHaveBeenCalledOnce()
    dispose()
  })

  it('shows a non-blocking retry notice only after sustained visible failure', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('location', {
        hash: '',
        href: 'http://127.0.0.1:3080/',
        origin: 'http://127.0.0.1:3080',
        reload: vi.fn(),
        replace: vi.fn(),
      })
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused') }))

      const dispose = apply({} as never)
      // 1s + 2s of backoff: three failures, 3s elapsed — under the 5s threshold.
      await vi.advanceTimersByTimeAsync(3_000)
      expect(document.getElementById('ankh-guard-browser-handoff')).toBeNull()
      // Next retry lands at 7s elapsed — sustained, so the neutral copy shows.
      await vi.advanceTimersByTimeAsync(5_000)
      const overlay = document.getElementById('ankh-guard-browser-handoff')
      expect(overlay).not.toBeNull()
      expect(overlay?.textContent).toContain('Connection interrupted')
      expect(overlay?.style.inset).not.toBe('0')
      expect(overlay?.querySelector('button')?.textContent).toBe('Retry')
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('foreground recovery of the handoff observer', () => {
  let visible: DocumentVisibilityState, dispose: (() => void) | undefined
  const reload = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers(); sessionStorage.clear(); document.documentElement.innerHTML = '<head></head><body></body>'
    visible = 'visible'; reload.mockClear()
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible)
    vi.stubGlobal('location', { hash: '', href: 'http://localhost/', origin: 'http://localhost', reload, replace: vi.fn() })
  })
  afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  const visibility = (value: DocumentVisibilityState) => { visible = value; document.dispatchEvent(new Event('visibilitychange')) }
  it('ignores background time, restarts promptly and coalesces native/visibility wakeups', async () => {
    const fetch = vi.fn(async () => { throw new Error('offline') }); vi.stubGlobal('fetch', fetch)
    dispose = apply({} as never)
    await vi.advanceTimersByTimeAsync(8000)
    expect(document.getElementById('ankh-guard-browser-handoff')?.dataset.kind).toBe('disconnected')
    visibility('hidden'); const before = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(before)
    expect(document.getElementById('ankh-guard-browser-handoff')).toBeNull()
    visibility('visible'); window.dispatchEvent(new Event('dsh-mobile-foreground'))
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(before + 1)
    expect(document.getElementById('ankh-guard-browser-handoff')).toBeNull()
    await vi.advanceTimersByTimeAsync(7000)
    const banner = document.getElementById('ankh-guard-browser-handoff')!
    expect(banner.dataset.kind).toBe('disconnected')
    const attempts = fetch.mock.calls.length
    banner.querySelector('button')!.click(); await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(attempts + 1)
    expect(document.getElementById('ankh-guard-browser-handoff')).toBeNull()
  })
  it('aborts suspended polls and ignores late generation results rather than reloading', async () => {
    const polls: { signal: AbortSignal; resolve: (response: Response) => void }[] = []
    vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise<Response>(resolve => polls.push({ signal: init.signal, resolve }))))
    dispose = apply({} as never)
    visibility('hidden'); expect(polls[0]!.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60000)
    visibility('visible'); await vi.advanceTimersByTimeAsync(1)
    expect(polls).toHaveLength(2)
    polls[0]!.resolve(response(200, { state: 'ready', action: 'reload', bootId: 'stale' }))
    await vi.advanceTimersByTimeAsync(1)
    expect(reload).not.toHaveBeenCalled(); expect(sessionStorage.getItem(BOOT_ID_KEY)).toBeNull()
    dispose(); expect(polls[1]!.signal.aborted).toBe(true)
    polls[1]!.resolve(response(200, { state: 'ready', action: 'reload', bootId: 'disposed' }))
    await vi.advanceTimersByTimeAsync(1); expect(reload).not.toHaveBeenCalled()
  })
  it('bounds hung requests and retains a full overlay only for confirmed restarts', async () => {
    const fetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    vi.stubGlobal('fetch', fetch); dispose = apply({} as never)
    await vi.advanceTimersByTimeAsync(36000); expect(fetch).toHaveBeenCalledTimes(2)
    dispose(); dispose = undefined
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async () => { if (++attempt === 1) return response(200, { state: 'waiting' }); throw new Error('offline') }))
    dispose = apply({} as never); await vi.advanceTimersByTimeAsync(9000)
    const overlay = document.getElementById('ankh-guard-browser-handoff')!
    expect(overlay.dataset.kind).toBe('restarting'); expect(overlay.querySelector('button')).toBeNull()
    visibility('hidden'); visibility('visible'); await vi.advanceTimersByTimeAsync(1)
    expect(overlay.dataset.kind).toBe('restarting')
  })
  it('retries on network restoration without waiting out the old backoff', async () => {
    let online = true; vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
    const fetch = vi.fn(async () => { throw new Error('offline') }); vi.stubGlobal('fetch', fetch)
    dispose = apply({} as never); await vi.advanceTimersByTimeAsync(16000)
    online = false; window.dispatchEvent(new Event('offline')); const before = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000); expect(fetch).toHaveBeenCalledTimes(before)
    online = true; window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(before + 1)
  })
})
