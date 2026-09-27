/** Original-tab browser handoff protocol: hashed registration, final-process URL, and real page acknowledgement. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBrowserHandoffHandler, readBrowserHandoffAcknowledgement,
  readBrowserHandoffRequest,
} from '../src/browser-handoff.ts'
import { fallbackCutoverId } from '../src/client/index.ts'
import { prepareLaunchCutover, recordCutoverEvent, type LaunchSpec } from '../src/launch-spec.ts'
import { STATE_FILES } from '../src/state-files.ts'

const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ankh-browser-handoff-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function spec(root: string, command: string): LaunchSpec {
  return {
    version: 1,
    command,
    port: 3080,
    home: join(root, 'home'),
    credentialRepo: join(root, 'repo'),
    harnessRoot: join(root, 'harness'),
    profile: 'web',
  }
}

function prepare(dir: string, id: string): void {
  prepareLaunchCutover(dir, {
    id,
    previous: spec(dir, 'previous'),
    target: spec(dir, 'target'),
    recoveryPolicy: 'restore-previous',
    browserHandoff: 'required',
    previousSupervisorPid: 101,
    previousSupervisorStartToken: 'supervisor-101',
    previousOwnership: {
      childPid: 102,
      childStartToken: 'child-102',
      listenerPid: 103,
      listenerStartToken: 'listener-103',
    },
    now: 1000,
  })
}

async function withHandler(
  initial: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  run: (setHandler: (next: typeof initial) => void, origin: string) => Promise<void>,
): Promise<void> {
  let handler = initial
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing test listener')
  cleanups.push(() => { server.close() })
  await run(next => { handler = next }, `http://127.0.0.1:${String(address.port)}`)
}

async function post(origin: string, body: unknown, cookie?: string, originHeader = origin): Promise<Response> {
  return fetch(`${origin}/_ankh-guard/browser-handoff`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: originHeader,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })
}

describe('browser handoff host bridge', () => {
  it('hands the final process URL only to the armed original tab and persists acknowledgement without secrets', async () => {
    const dir = stateDir()
    const id = 'cutover-browser-1'
    const capability = 'A'.repeat(43)
    prepare(dir, id)
    const identityMatches = (): boolean => true
    const oldHandler = createBrowserHandoffHandler({ stateDir: dir, pid: 103, now: () => 1100, identityMatches, identityProvider: () => null })

    await withHandler(oldHandler, async (setHandler, origin) => {
      const arm = await post(origin, { version: 1, operation: 'poll', capability })
      expect(await arm.json()).toEqual({ state: 'waiting', cutoverId: id })
      expect(readBrowserHandoffRequest(dir)).toMatchObject({
        cutoverId: id,
        registrations: [{ authority: new URL(origin).host }],
      })
      const requestBytes = readFileSync(join(dir, STATE_FILES.browserHandoffRequest), 'utf8')
      expect(requestBytes).not.toContain(capability)

      recordCutoverEvent(dir, id, 'child-started', ['target', '1', '203', 'child-203'], 1200)
      recordCutoverEvent(dir, id, 'transport', ['401'], 1201)
      recordCutoverEvent(dir, id, 'launch-url', [], 1202)
      recordCutoverEvent(dir, id, 'auth-exchange', ['303'], 1203)
      recordCutoverEvent(dir, id, 'authenticated', ['200'], 1204)
      recordCutoverEvent(
        dir, id, 'ownership-stable',
        ['target', '203', 'child-203', '204', 'listener-204', '3000', '0'], 1205,
      )
      recordCutoverEvent(dir, id, 'canary', ['pass'], 1206)
      const targetHandler = createBrowserHandoffHandler({
        stateDir: dir,
        pid: 204,
        now: () => 1300,
        identityMatches,
        identityProvider: () => null,
        connection: {
          requestRejection: request => request.headers.cookie === 'dsh=valid' ? undefined : 401,
          authenticatedUrl: base => `${base}/?token=process-only`,
        },
      })
      setHandler(targetHandler)

      const wrong = await post(origin, { version: 1, operation: 'poll', capability: 'B'.repeat(43) })
      expect(await wrong.json()).toEqual({ state: 'waiting', cutoverId: id })
      const claim = await post(origin, { version: 1, operation: 'poll', capability })
      expect(await claim.json()).toEqual({
        state: 'ready', action: 'replace', cutoverId: id, role: 'target',
        authentication: 'launch-url', launchUrl: `${origin}/?token=process-only`,
      })
      expect(requestBytes).not.toContain('process-only')

      const ackBody = {
        version: 1,
        operation: 'ack',
        cutoverId: id,
        channel: 'original-tab',
        authentication: 'launch-url',
        capability,
      }
      expect((await post(origin, ackBody)).status).toBe(401)
      expect((await post(origin, ackBody, 'dsh=valid')).status).toBe(204)
      const ack = readBrowserHandoffAcknowledgement(dir)
      expect(ack).toMatchObject({
        cutoverId: id, role: 'target', listenerPid: 204, listenerStartToken: 'listener-204',
        channel: 'original-tab', authentication: 'launch-url', authority: new URL(origin).host,
      })
      const ackBytes = readFileSync(join(dir, STATE_FILES.browserHandoffAck), 'utf8')
      expect(ackBytes).not.toContain(capability)
      expect(ackBytes).not.toContain('process-only')
      expect(await (await post(origin, { version: 1, operation: 'poll', capability }, 'dsh=valid')).json()).toEqual({
        state: 'idle',
      })
    })
  })

  it('reuses a valid cookie without disclosing a launch URL and rejects a foreign Origin', async () => {
    const dir = stateDir()
    const id = 'cutover-browser-cookie'
    const capability = 'C'.repeat(43)
    prepare(dir, id)
    const identityMatches = (): boolean => true
    const oldHandler = createBrowserHandoffHandler({ stateDir: dir, pid: 103, identityMatches, identityProvider: () => null })
    await withHandler(oldHandler, async (setHandler, origin) => {
      expect((await post(
        origin, { version: 1, operation: 'poll', capability }, undefined, 'http://foreign.invalid',
      )).status).toBe(403)
      await post(origin, { version: 1, operation: 'poll', capability })
      recordCutoverEvent(dir, id, 'child-started', ['target', '1', '303', 'child-303'], 2000)
      recordCutoverEvent(
        dir, id, 'ownership-stable',
        ['target', '303', 'child-303', '304', 'listener-304', '3000', '0'], 2001,
      )
      let connection: {
        requestRejection: (request: IncomingMessage) => 401 | undefined
        authenticatedUrl: () => string
      } | undefined
      setHandler(createBrowserHandoffHandler({
        stateDir: dir,
        pid: 304,
        identityMatches,
        identityProvider: () => null,
        connectionProvider: () => connection,
      }))
      // A protected final route can beat its optional connection service to
      // activation. It must wait, not misclassify the missing service as a
      // valid public cookie and reload the original page into a naked 401.
      recordCutoverEvent(dir, id, 'launch-url', [], 2002)
      const settlingPoll = post(origin, { version: 1, operation: 'poll', capability })
      await new Promise(resolve => setTimeout(resolve, 20))
      connection = {
        requestRejection: request => request.headers.cookie === 'dsh=valid' ? undefined : 401,
        authenticatedUrl: () => { throw new Error('valid-cookie flow must not ask for a launch URL') },
      }
      recordCutoverEvent(dir, id, 'canary', ['pass'], 2003)
      expect(await (await settlingPoll).json()).toEqual({ state: 'waiting', cutoverId: id })
      const response = await post(origin, { version: 1, operation: 'poll', capability }, 'dsh=valid')
      expect(await response.json()).toEqual({
        state: 'ready', action: 'reload', cutoverId: id, role: 'target', authentication: 'existing-cookie',
      })
      recordCutoverEvent(dir, id, 'awaiting-user', ['operator intervention required'], 2004)
      expect(await (await post(origin, { version: 1, operation: 'poll', capability })).json()).toEqual({ state: 'idle' })
    })
  })

  it('accepts a fallback-page acknowledgement only after final-process authentication', async () => {
    const dir = stateDir()
    const id = 'cutover-browser-fallback'
    prepare(dir, id)
    recordCutoverEvent(dir, id, 'child-started', ['target', '1', '403', 'child-403'], 3000)
    recordCutoverEvent(dir, id, 'transport', ['401'], 3001)
    recordCutoverEvent(dir, id, 'launch-url', [], 3002)
    recordCutoverEvent(
      dir, id, 'ownership-stable',
      ['target', '403', 'child-403', '404', 'listener-404', '3000', '0'], 3003,
    )
    recordCutoverEvent(dir, id, 'canary', ['pass'], 3004)
    await withHandler(createBrowserHandoffHandler({
      stateDir: dir,
      pid: 404,
      identityMatches: () => true,
      identityProvider: () => null,
      connection: { requestRejection: request => request.headers.cookie === 'dsh=valid' ? undefined : 401 },
    }), async (_setHandler, origin) => {
      const ack = {
        version: 1,
        operation: 'ack',
        cutoverId: id,
        channel: 'fallback-tab',
        authentication: 'launch-url',
      }
      expect((await post(origin, ack)).status).toBe(401)
      expect((await post(origin, ack, 'dsh=valid')).status).toBe(204)
      expect(readBrowserHandoffAcknowledgement(dir)).toMatchObject({
        cutoverId: id,
        role: 'target',
        listenerPid: 404,
        listenerStartToken: 'listener-404',
        channel: 'fallback-tab',
        authentication: 'launch-url',
        authority: new URL(origin).host,
      })
    })
  })

  it('registers every responsive original tab and wakes an idle long poll when cutover starts', async () => {
    const dir = stateDir()
    const id = 'cutover-browser-tabs'
    const firstCapability = 'D'.repeat(43)
    const secondCapability = 'E'.repeat(43)
    const identityMatches = (): boolean => true
    await withHandler(createBrowserHandoffHandler({
      stateDir: dir, pid: 103, identityMatches, identityProvider: () => null, longPollMs: 250, longPollIntervalMs: 5,
    }), async (setHandler, origin) => {
      const firstPoll = post(origin, { version: 1, operation: 'poll', capability: firstCapability })
      await new Promise(resolve => setTimeout(resolve, 20))
      prepare(dir, id)
      expect(await (await firstPoll).json()).toEqual({ state: 'waiting', cutoverId: id })
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability: secondCapability,
      })).json()).toEqual({ state: 'waiting', cutoverId: id })
      const registration = readBrowserHandoffRequest(dir)
      expect(registration?.registrations).toHaveLength(2)
      expect(readFileSync(join(dir, STATE_FILES.browserHandoffRequest), 'utf8')).not.toContain(firstCapability)
      expect(readFileSync(join(dir, STATE_FILES.browserHandoffRequest), 'utf8')).not.toContain(secondCapability)

      recordCutoverEvent(dir, id, 'child-started', ['target', '1', '503', 'child-503'], 4000)
      recordCutoverEvent(
        dir, id, 'ownership-stable',
        ['target', '503', 'child-503', '504', 'listener-504', '3000', '0'], 4001,
      )
      recordCutoverEvent(dir, id, 'canary', ['pass'], 4002)
      setHandler(createBrowserHandoffHandler({
        stateDir: dir, pid: 504, identityMatches, identityProvider: () => null, longPollMs: 0,
      }))
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability: firstCapability,
      })).json()).toMatchObject({ state: 'ready', action: 'reload', cutoverId: id })
      expect((await post(origin, {
        version: 1, operation: 'ack', cutoverId: id, channel: 'original-tab',
        authentication: 'existing-cookie', capability: firstCapability,
      })).status).toBe(204)
      recordCutoverEvent(
        dir, id, 'browser-handoff',
        ['acknowledged', 'original-tab', 'existing-cookie', new URL(origin).host], 4003,
      )
      recordCutoverEvent(dir, id, 'ready', ['target'], 4004)

      // Terminal readiness is gated by one real page ACK, but a slower second
      // registered tab remains eligible to recover after state compaction.
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability: secondCapability,
      })).json()).toMatchObject({ state: 'ready', action: 'reload', cutoverId: id })
      expect((await post(origin, {
        version: 1, operation: 'ack', cutoverId: id, channel: 'original-tab',
        authentication: 'existing-cookie', capability: secondCapability,
      })).status).toBe(204)
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability: secondCapability,
      })).json()).toEqual({ state: 'idle' })
      expect(readBrowserHandoffRequest(dir)?.registrations.every(item => (
        item.acknowledgedAt !== undefined
      ))).toBe(true)
    })
  })
})

describe('browser handoff boot-generation channel', () => {
  it('teaches the boot id on idle and reloads a stale tab when no cutover is active', async () => {
    const dir = stateDir()
    const capability = 'G'.repeat(43)
    await withHandler(createBrowserHandoffHandler({
      stateDir: dir, pid: 103, identityMatches: () => true, longPollMs: 0,
      identityProvider: pid => ({ pid, startToken: 'token-A' }),
    }), async (_setHandler, origin) => {
      // First contact: no known id, learn the serving boot id from the idle response.
      expect(await (await post(origin, { version: 1, operation: 'poll', capability })).json())
        .toEqual({ state: 'idle', bootId: '103:token-A' })
      // A current id stays idle.
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability, knownBootId: '103:token-A',
      })).json()).toEqual({ state: 'idle', bootId: '103:token-A' })
      // A stale id means the process this tab knew is gone: reload once.
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability, knownBootId: '999:stale',
      })).json()).toEqual({
        state: 'ready', action: 'reload', authentication: 'existing-cookie', bootId: '103:token-A',
      })
    })
  })

  it('defers to the receipt channel during a cutover and stays one-shot after it settles', async () => {
    const dir = stateDir()
    const id = 'cutover-generation-defer'
    const capability = 'H'.repeat(43)
    prepare(dir, id)
    const identityMatches = (): boolean => true
    const oldHandler = createBrowserHandoffHandler({
      stateDir: dir, pid: 103, identityMatches,
      identityProvider: pid => ({ pid, startToken: 'token-A' }),
    })
    await withHandler(oldHandler, async (setHandler, origin) => {
      // Stale known id + ACTIVE cutover: the receipt protocol owns the pacing —
      // the generation branch must not short-circuit the registration dance.
      const arm = await post(origin, { version: 1, operation: 'poll', capability, knownBootId: '999:stale' })
      expect(await arm.json()).toEqual({ state: 'waiting', cutoverId: id, bootId: '103:token-A' })

      recordCutoverEvent(dir, id, 'child-started', ['target', '1', '203', 'child-203'], 1200)
      recordCutoverEvent(
        dir, id, 'ownership-stable',
        ['target', '203', 'child-203', '204', 'listener-204', '3000', '0'], 1201,
      )
      recordCutoverEvent(dir, id, 'canary', ['pass'], 1202)
      setHandler(createBrowserHandoffHandler({
        stateDir: dir, pid: 204, identityMatches, longPollMs: 0,
        identityProvider: pid => ({ pid, startToken: 'token-B' }),
      }))
      // The successor's ready teaches ITS boot id — the tab stores it before reloading.
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability, knownBootId: '103:token-A',
      })).json()).toEqual({
        state: 'ready', action: 'reload', cutoverId: id, role: 'target',
        authentication: 'existing-cookie', bootId: '204:token-B',
      })
      expect((await post(origin, {
        version: 1, operation: 'ack', cutoverId: id, channel: 'original-tab',
        authentication: 'existing-cookie', capability,
      })).status).toBe(204)
      recordCutoverEvent(
        dir, id, 'browser-handoff',
        ['acknowledged', 'original-tab', 'existing-cookie', new URL(origin).host], 1203,
      )
      recordCutoverEvent(dir, id, 'ready', ['target'], 1204)

      // One-shot: the acked tab learned the successor's id, so the settled
      // receipt must not trigger a second (generation) reload.
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability, knownBootId: '204:token-B',
      })).json()).toEqual({ state: 'idle', bootId: '204:token-B' })
    })
  })

  it('holds the generation reload until the successor composition has settled', async () => {
    const dir = stateDir()
    const capability = 'J'.repeat(43)
    let ready = false
    await withHandler(createBrowserHandoffHandler({
      stateDir: dir, pid: 103, identityMatches: () => true, longPollMs: 0,
      identityProvider: pid => ({ pid, startToken: 'token-A' }),
      applicationReady: () => ready,
    }), async (_setHandler, origin) => {
      // The successor answers on the shared Web-server seat while sibling rows
      // are still mounting. Hold — and deliberately do NOT teach the boot id:
      // the tab must keep its stale id so the one-shot check survives.
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability, knownBootId: '999:stale',
      })).json()).toEqual({ state: 'waiting' })
      // The same stale poll reloads once the tree settles.
      ready = true
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability, knownBootId: '999:stale',
      })).json()).toEqual({
        state: 'ready', action: 'reload', authentication: 'existing-cookie', bootId: '103:token-A',
      })
    })
  })

  it('degrades to the pre-generation flow when the serving identity is unavailable', async () => {
    const dir = stateDir()
    await withHandler(createBrowserHandoffHandler({
      stateDir: dir, pid: 103, identityMatches: () => true, longPollMs: 0,
      identityProvider: () => null,
    }), async (_setHandler, origin) => {
      expect(await (await post(origin, {
        version: 1, operation: 'poll', capability: 'I'.repeat(43), knownBootId: '999:stale',
      })).json()).toEqual({ state: 'idle' })
    })
  })
})

describe('browser handoff client wire', () => {
  it('accepts only bounded fallback transaction fragments', () => {
    expect(fallbackCutoverId('#ankh-guard-handoff=123-456')).toBe('123-456')
    expect(fallbackCutoverId('#ankh-guard-handoff=https%3A%2F%2Fsecret.invalid')).toBeNull()
    expect(fallbackCutoverId('#other=value')).toBeNull()
  })
})
