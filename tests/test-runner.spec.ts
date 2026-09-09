import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessTestResult } from '../scripts/test-result.mjs'

const task = { name: 'supervise-fixture', expected: 12 }
const exited = { code: 0, signal: null }
const report = (overrides = {}) => ({
  success: true, numPassedTests: 12, numFailedTests: 0, numPendingTests: 128,
  numTodoTests: 0, numTotalTests: 140, numFailedTestSuites: 0, testResults: [], ...overrides,
})

describe('lane structured results', () => {
  it('counts a complete filtered shard without treating deliberate skips as missing', () => {
    expect(assessTestResult(task, report(), exited)).toMatchObject({
      ok: true, passed: 12, skipped: 128, failed: 0, missingPassing: 0,
    })
  })

  it('keeps eleven passes AND the named failure instead of losing the entire shard', () => {
    // This real Vitest summary shape was invisible to the old passing-only regex.
    expect(/Tests\s+(\d+) passed/.exec('Tests 1 failed | 11 passed | 128 skipped (140)')).toBeNull()
    const result = assessTestResult(task, report({
      success: false, numPassedTests: 11, numFailedTests: 1, numFailedTestSuites: 1,
      testResults: [{ name: 'fixture.spec.ts', assertionResults: [
        { status: 'failed', fullName: 'supervise transfers ownership', failureMessages: ['expected ready'] },
      ] }],
    }), { code: 1, signal: null })
    expect(result).toMatchObject({ ok: false, passed: 11, failed: 1, missingPassing: 1, code: 1 })
    expect(result.failures[0]).toMatchObject({ test: 'supervise transfers ownership', messages: ['expected ready'] })
  })

  it('fails closed on missing reports, signals, spawn errors, suite errors and incomplete inventories', () => {
    expect(assessTestResult(task, null, { code: null, signal: 'SIGKILL' }).reasons)
      .toEqual(['missing-or-invalid-report', 'process-signal', 'nonzero-exit'])
    expect(assessTestResult(task, null, { code: -2, signal: null, spawnError: new Error('ENOENT') }).reasons)
      .toContain('spawn-error')
    expect(assessTestResult(task, report({ numFailedTestSuites: 1 }), exited).reasons)
      .toContain('test-or-suite-failure')
    expect(assessTestResult(task, report({ numPassedTests: 11, numPendingTests: 129 }), exited).missingPassing).toBe(1)
    expect(assessTestResult(task, report({ numTotalTests: 139 }), exited).reasons).toContain('inconsistent-report')
  })
})

it('admits separate processes in handshake order, times out busy, then acquires after release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ankh-admission-spec-'))
  const children: ChildProcess[] = []
  const completions: Promise<unknown>[] = []
  const moduleUrl = new URL('../scripts/test-resource.mjs', import.meta.url).href
  const start = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { acquireTestResource } from ${JSON.stringify(moduleUrl)};
      let release;
      process.on('message', async command => {
        try {
          if (command === 'release') { release(); process.send('released'); }
          else {
            release = await acquireTestResource('fixture', {
              root: ${JSON.stringify(root)}, timeoutMs: command === 'busy' ? 0 : 2000,
              report() {},
            });
            process.send('acquired');
          }
        } catch (error) { process.send(error.message); }
      });
      process.on('disconnect', () => process.exit(0));
      process.send('ready');
    `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    children.push(child)
    // These IPC-only children have no captured output to drain. Wait for their
    // actual exit; inherited descriptors can keep a `close` observation open.
    completions.push(new Promise(resolve => child.once('exit', resolve)))
    return child
  }
  const message = (child: ChildProcess, command?: string) => new Promise<unknown>((resolve, reject) => {
    const deadline = setTimeout(() => { cleanup(); reject(new Error('IPC handshake deadline exceeded')) }, 10_000)
    const onMessage = (value: unknown) => { cleanup(); resolve(value) }
    const onExit = () => { cleanup(); reject(new Error('child exited before ACK')) }
    const cleanup = () => { clearTimeout(deadline); child.off('message', onMessage); child.off('exit', onExit) }
    child.once('message', onMessage)
    child.once('exit', onExit)
    if (command) child.send(command)
  })
  try {
    const a = start()
    expect(await message(a)).toBe('ready')
    const b = start()
    expect(await message(b)).toBe('ready')
    expect(await message(a, 'acquire')).toBe('acquired')
    expect(await message(b, 'busy')).toMatch(/test admission timed out/)
    expect(await message(a, 'release')).toBe('released')
    expect(await message(b, 'acquire')).toBe('acquired')
    expect(await message(b, 'release')).toBe('released')
  } finally {
    for (const child of children) if (child.connected) child.disconnect()
    await Promise.all(completions)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
