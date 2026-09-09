/** requestRestart: input validation, supervision dispatch, and the structured refusal verdict. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requestRestart } from '../src/restart-request.ts'
import { stateFile } from '../src/state-files.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ankh-restart-request-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function writeLaunch(dir: string, port = 39999): void {
  writeFileSync(stateFile(dir, 'instanceLaunch'), `${JSON.stringify({
    command: `dsh web --port ${port}`, source: 'instance', port, recordedAt: Date.now(),
  })}\n`)
}

const request = { start: 'dsh web --profile novel --port 39999 --no-open', profile: 'novel', initiator: 'session-1' }

describe('requestRestart', () => {
  it('refuses malformed requests before touching any state', async () => {
    const dir = stateDir()
    for (const bad of [
      { ...request, start: ' ' },
      { ...request, profile: '' },
      { ...request, initiator: '' },
    ]) {
      const result = await requestRestart(bad, { stateDir: dir, repoDir: dir })
      expect(result).toMatchObject({ accepted: false, stage: 'usage' })
    }
    // An empty initiator above all: the report would route away from its owner.
    const anonymous = await requestRestart({ ...request, initiator: ' ' }, { stateDir: dir, repoDir: dir })
    expect(anonymous.accepted === false && anonymous.reason).toContain('initiator')
  })

  it("refuses when the guard does not know this instance's port", async () => {
    const dir = stateDir()
    const result = await requestRestart(request, { stateDir: dir, repoDir: dir })
    expect(result).toMatchObject({ accepted: false, stage: 'usage' })
    expect(result.accepted === false && result.reason).toContain('launch record')
  })

  it('dispatches an unsupervised instance to the restart verb and surfaces the credential refusal', async () => {
    const dir = stateDir()
    writeLaunch(dir)
    const result = await requestRestart(request, { stateDir: dir, repoDir: dir })
    expect(result).toMatchObject({ accepted: false, stage: 'credential' })
    expect(result.accepted === false && result.detail).toContain('restart refused')
  })

  it('dispatches a supervised instance to reconfigure instead of fighting the watchdog respawn', async () => {
    const dir = stateDir()
    writeLaunch(dir)
    // A live pidfile owner: this test process itself.
    writeFileSync(stateFile(dir, 'watchdogPid'), String(process.pid))
    const result = await requestRestart(request, { stateDir: dir, repoDir: dir })
    expect(result.accepted).toBe(false)
    expect(result.accepted === false && result.detail).toContain('reconfigure refused')
  })
})
