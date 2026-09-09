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

  it('shows the neutral disconnected overlay only after sustained failure', async () => {
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
      expect(overlay?.textContent).toContain('waiting for the service to recover')
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
