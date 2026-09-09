/**
 * Explicit test-only process/event registration seam. Production execution is
 * inert unless a test runner supplies all ANKH_GUARD_TEST_* ownership values.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processGroupId, processIdentity, type ProcessIdentity } from './processes.ts'

export const TEST_RUN_DIR_ENV = 'ANKH_GUARD_TEST_RUN_DIR'
export const TEST_RUN_TOKEN_ENV = 'ANKH_GUARD_TEST_RUN_TOKEN'
export const TEST_PROCESS_ROLE_ENV = 'ANKH_GUARD_TEST_PROCESS_ROLE'
export const TEST_PROCESS_PORT_ENV = 'ANKH_GUARD_TEST_PROCESS_PORT'
export const TEST_PROCESS_TEMP_ROOT_ENV = 'ANKH_GUARD_TEST_PROCESS_TEMP_ROOT'
export const TEST_REGISTER_BIN_ENV = 'ANKH_GUARD_TEST_REGISTER_BIN'
export const TEST_SLEEP_SCALE_ENV = 'ANKH_GUARD_TEST_SLEEP_SCALE'

export type TestObservationSource =
  | 'child-self'
  | 'parent-observer'
  | 'node-exit-callback'
  | 'node-close-callback'
  | 'ps-sampler'

export interface TestProcessLeaseRecord {
  version: 1
  runToken: string
  role: string
  pid: number
  pgid: number
  startToken: string
  groupRoot: boolean
  registeredAt: number
  source: 'child-self' | 'parent-observer'
  tempRoot?: string
  port?: number
}

export interface TestLifecycleEvent {
  version: 1
  runToken: string
  source: TestObservationSource
  role: string
  event: string
  pid: number
  pgid?: number
  startToken?: string
  wallTimeMs: number
  monotonicNs: string
  detail?: Record<string, string | number | boolean | null>
}

interface RegisterOptions {
  env?: NodeJS.ProcessEnv
  identity?: ProcessIdentity
  source?: 'child-self' | 'parent-observer'
  tempRoot?: string
  port?: number
}

function testCoordinates(env: NodeJS.ProcessEnv): { runDir: string; runToken: string } | null {
  const runDir = env[TEST_RUN_DIR_ENV]
  const runToken = env[TEST_RUN_TOKEN_ENV]
  if (runDir === undefined || runDir === '' || runToken === undefined || !/^[a-f0-9-]{16,}$/.test(runToken)) return null
  return { runDir, runToken }
}

function safeRole(value: string): string {
  const role = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80)
  return role === '' ? 'unknown' : role
}

export function appendTestLifecycleEventForProcess(
  subjectPid: number,
  roleValue: string,
  event: string,
  detail?: Record<string, string | number | boolean | null>,
  source: TestObservationSource = 'child-self',
  env: NodeJS.ProcessEnv = process.env,
): void {
  const coordinates = testCoordinates(env)
  if (coordinates === null) return
  const role = safeRole(roleValue)
  const identity = processIdentity(subjectPid)
  const pgid = processGroupId(subjectPid)
  const record: TestLifecycleEvent = {
    version: 1,
    runToken: coordinates.runToken,
    source,
    role,
    event: safeRole(event),
    pid: subjectPid,
    ...(pgid === null ? {} : { pgid }),
    ...(identity === null ? {} : { startToken: identity.startToken }),
    wallTimeMs: Date.now(),
    monotonicNs: process.hrtime.bigint().toString(),
    ...(detail === undefined ? {} : { detail }),
  }
  try {
    const dir = join(coordinates.runDir, 'events')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(join(dir, `${subjectPid}-${source}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch {
    // Diagnostics must never change the lifecycle under test.
  }
}

/** Record one credential-free event in this process's append-only event file. */
export function appendTestLifecycleEvent(
  event: string,
  detail?: Record<string, string | number | boolean | null>,
  source: TestObservationSource = 'child-self',
  env: NodeJS.ProcessEnv = process.env,
): void {
  appendTestLifecycleEventForProcess(process.pid, env[TEST_PROCESS_ROLE_ENV] ?? 'unknown', event, detail, source, env)
}

/**
 * Atomically publish an immutable PID/PGID/start-identity lease. The same PID
 * may be observed by its parent and then self-register; the first complete
 * record wins because both describe the same kernel start identity.
 */
export function registerTestProcess(pid: number, role: string, options: RegisterOptions = {}): TestProcessLeaseRecord | null {
  const env = options.env ?? process.env
  const coordinates = testCoordinates(env)
  if (coordinates === null) return null
  const identity = options.identity ?? processIdentity(pid)
  const pgid = processGroupId(pid)
  if (identity === null || pgid === null) return null
  const portText = env[TEST_PROCESS_PORT_ENV]
  const envPort = portText === undefined ? undefined : Number(portText)
  const port = options.port ?? (Number.isInteger(envPort) && (envPort ?? 0) > 0 ? envPort : undefined)
  const tempRoot = options.tempRoot ?? env[TEST_PROCESS_TEMP_ROOT_ENV]
  const record: TestProcessLeaseRecord = {
    version: 1,
    runToken: coordinates.runToken,
    role: safeRole(role),
    pid,
    pgid,
    startToken: identity.startToken,
    groupRoot: pgid === pid,
    registeredAt: Date.now(),
    source: options.source ?? (pid === process.pid ? 'child-self' : 'parent-observer'),
    ...(tempRoot === undefined || tempRoot === '' ? {} : { tempRoot }),
    ...(port === undefined ? {} : { port }),
  }
  try {
    const dir = join(coordinates.runDir, 'processes')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const identityHash = createHash('sha256').update(identity.startToken).digest('hex').slice(0, 16)
    writeFileSync(join(dir, `${pid}-${identityHash}.json`), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null
  }
  return record
}

/** Self-register only when an explicit test role accompanies the run lease. */
export function registerCurrentTestProcess(env: NodeJS.ProcessEnv = process.env): TestProcessLeaseRecord | null {
  const role = env[TEST_PROCESS_ROLE_ENV]
  if (role === undefined || role === '') return null
  const record = registerTestProcess(process.pid, role, { env, source: 'child-self' })
  if (record !== null) appendTestLifecycleEvent('process-registered', { pgid: record.pgid }, 'child-self', env)
  return record
}
