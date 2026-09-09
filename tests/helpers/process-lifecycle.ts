import { execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  findPidsOnPort, processGroupId, processIdentity, processIdentityMatches,
  signalProcessIdentity, type ProcessIdentity,
} from '../../src/processes.ts'
import {
  appendTestLifecycleEvent, appendTestLifecycleEventForProcess, registerTestProcess,
  TEST_PROCESS_PORT_ENV, TEST_PROCESS_ROLE_ENV, TEST_PROCESS_TEMP_ROOT_ENV,
  TEST_REGISTER_BIN_ENV, TEST_RUN_DIR_ENV, TEST_RUN_TOKEN_ENV, TEST_SLEEP_SCALE_ENV,
  type TestLifecycleEvent, type TestProcessLeaseRecord,
} from '../../src/test-seam.ts'
import {
  TEMP_ARTIFACT_OWNER_FILE, type TempArtifactOwnerRecord,
} from '../../src/temp-artifact.ts'

const LEASE_SCHEMA_VERSION = 1
const DEFAULT_LIVE_REPORT_AGE_MS = 60 * 60_000
export const DEFAULT_AUTOMATIC_RECLAIM_AGE_MS = 24 * 60 * 60_000
const OWNED_TEMP_ROOT = /^(?:ankh|guard)-[a-z0-9._-]+-[A-Za-z0-9]{6}$/i

interface RunRecord {
  version: 1
  runToken: string
  createdAt: number
  owner: ProcessIdentity
  cwd: string
}

interface PortLeaseRecord {
  version: 1
  runToken: string
  port: number
  createdAt: number
  owner: ProcessIdentity
  runDir: string
}

export interface MachineLeaseFinding<T> {
  record: T
  file: string
  ageMs: number
  run?: RunRecord
}

export interface MachineLeaseReport {
  root: string
  reclaimable: Array<MachineLeaseFinding<TestProcessLeaseRecord | PortLeaseRecord>>
  overAgeLive: Array<MachineLeaseFinding<TestProcessLeaseRecord | PortLeaseRecord>>
  activeLive: Array<MachineLeaseFinding<TestProcessLeaseRecord | PortLeaseRecord>>
  unreadable: Array<{ file: string; error: string }>
}

export interface MachineLeaseReclaimResult {
  root: string
  minimumAgeMs: number
  lock: 'acquired' | 'busy'
  removedRuns: string[]
  removedPortLeases: string[]
  removedTempRoots: string[]
  skipped: Array<{ path: string; reason: string }>
  errors: Array<{ path: string; error: string }>
}

/** Internal-only filesystem scope used to isolate destructive reclaim specs. */
export interface MachineLeaseReclaimScope {
  root: string
  tempBase: string
}

interface ReclaimLockRecord {
  version: 1
  createdAt: number
  owner: ProcessIdentity
}

function leaseRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown'
  return join(tmpdir(), `dsh-ankh-guard-test-leases-${uid}`)
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe test lease directory: ${path}`)
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`test lease directory is not owned by uid ${process.getuid()}: ${path}`)
  }
  chmodSync(path, 0o700)
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function validIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ProcessIdentity>
  return Number.isInteger(candidate.pid) && (candidate.pid ?? 0) > 0
    && typeof candidate.startToken === 'string' && candidate.startToken !== ''
}

function validRunRecord(value: unknown, expectedToken?: string): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RunRecord>
  return candidate.version === 1
    && typeof candidate.runToken === 'string' && /^[a-f0-9-]{16,}$/.test(candidate.runToken)
    && (expectedToken === undefined || candidate.runToken === expectedToken)
    && typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) && candidate.createdAt >= 0
    && typeof candidate.cwd === 'string'
    && validIdentity(candidate.owner)
}

function validPortLeaseRecord(value: unknown): value is PortLeaseRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PortLeaseRecord>
  return candidate.version === 1
    && typeof candidate.runToken === 'string' && /^[a-f0-9-]{16,}$/.test(candidate.runToken)
    && Number.isInteger(candidate.port) && (candidate.port ?? 0) > 0
    && typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) && candidate.createdAt >= 0
    && typeof candidate.runDir === 'string' && isAbsolute(candidate.runDir)
    && validIdentity(candidate.owner)
}

function validProcessLeaseRecord(value: unknown, expectedToken?: string): value is TestProcessLeaseRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<TestProcessLeaseRecord>
  return candidate.version === 1
    && typeof candidate.runToken === 'string' && /^[a-f0-9-]{16,}$/.test(candidate.runToken)
    && (expectedToken === undefined || candidate.runToken === expectedToken)
    && validIdentity(candidate)
    && Number.isInteger(candidate.pgid) && (candidate.pgid ?? 0) > 0
    && typeof candidate.registeredAt === 'number' && Number.isFinite(candidate.registeredAt) && candidate.registeredAt >= 0
    && typeof candidate.role === 'string' && candidate.role !== ''
    && typeof candidate.groupRoot === 'boolean'
    && (candidate.source === 'child-self' || candidate.source === 'parent-observer')
    && (candidate.tempRoot === undefined || (typeof candidate.tempRoot === 'string' && isAbsolute(candidate.tempRoot)))
    && (candidate.port === undefined || (Number.isInteger(candidate.port) && (candidate.port ?? 0) > 0))
}

function validTempArtifactOwner(value: unknown): value is TempArtifactOwnerRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<TempArtifactOwnerRecord>
  return candidate.version === 1 && candidate.kind === 'preflight-snapshot'
    && typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) && candidate.createdAt >= 0
    && validIdentity(candidate.owner)
}

function atomicRemove(path: string, suffix: string): boolean {
  const quarantine = `${path}.reclaim-${suffix}`
  try {
    renameSync(path, quarantine)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  rmSync(quarantine, { recursive: true, force: true })
  return true
}

function acquireReclaimLock(root: string): { release(): void } | null {
  ensurePrivateDirectory(root)
  const file = join(root, 'reclaim.lock')
  const owner = processIdentity(process.pid)
  if (owner === null) return null
  const mine: ReclaimLockRecord = { version: 1, createdAt: Date.now(), owner }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${JSON.stringify(mine)}\n`, { flag: 'wx', mode: 0o600 })
      return {
        release: () => {
          try {
            const current = readJson<ReclaimLockRecord>(file)
            if (current.version === 1 && current.owner.pid === owner.pid
              && current.owner.startToken === owner.startToken) unlinkSync(file)
          } catch { /* another completed/stale cleanup already removed it */ }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let incumbent: ReclaimLockRecord
      try {
        incumbent = readJson<ReclaimLockRecord>(file)
        if (incumbent.version !== 1 || !validIdentity(incumbent.owner)) return null
      } catch {
        return null
      }
      if (processIdentityMatches(incumbent.owner)) return null
      try {
        const stale = `${file}.stale-${randomUUID()}`
        renameSync(file, stale)
        unlinkSync(stale)
      } catch { /* another reclaimer won; retry the ordinary claim once */ }
    }
  }
  return null
}

/** Test adapter for deterministically holding the same lock used by reclaim. */
export function acquireReclaimLockForTest(root: string): { release(): void } | null {
  return acquireReclaimLock(root)
}

interface OwnedTempRoot {
  root: string
  present: boolean
}

/** Resolve only direct, mkdtemp-shaped Ankh Guard roots below the selected temp base. */
function safeOwnedTempRoot(path: string, tempBase = tmpdir()): OwnedTempRoot | null {
  if (!isAbsolute(path)) return null
  let canonicalBase: string
  try {
    canonicalBase = realpathSync(tempBase)
  } catch {
    return null
  }
  const rawBase = resolve(tempBase)
  const normalizedPath = resolve(path)
  let selectedBase = rawBase
  let offset = relative(rawBase, normalizedPath)
  if (isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) {
    selectedBase = canonicalBase
    offset = relative(canonicalBase, normalizedPath)
  }
  if (offset === '' || isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) return null
  const first = offset.split(sep)[0]
  if (first === undefined || !OWNED_TEMP_ROOT.test(first)) return null
  const rawRoot = join(selectedBase, first)
  if (!existsSync(rawRoot)) return { root: join(canonicalBase, first), present: false }
  try {
    const info = lstatSync(rawRoot)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null
    const root = realpathSync(rawRoot)
    if (relative(canonicalBase, root) !== first) return null
    return { root, present: true }
  } catch {
    return null
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })
}

function reserveEphemeralPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {})
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve({ server, port: (server.address() as AddressInfo).port })
    })
  })
}

function readProcessRecords(runDir: string): TestProcessLeaseRecord[] {
  return scanProcessRecords(runDir).records
}

function processEvidenceSignature(records: TestProcessLeaseRecord[]): string {
  return JSON.stringify([...records].sort((left, right) => {
    const leftKey = `${left.pid}\0${left.startToken}\0${left.role}`
    const rightKey = `${right.pid}\0${right.startToken}\0${right.role}`
    return leftKey.localeCompare(rightKey)
  }))
}

function scanProcessRecords(runDir: string): {
  records: TestProcessLeaseRecord[]
  unreadable: Array<{ file: string; error: string }>
} {
  const dir = join(runDir, 'processes')
  if (!existsSync(dir)) return { records: [], unreadable: [] }
  const records: TestProcessLeaseRecord[] = []
  const unreadable: Array<{ file: string; error: string }> = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      const record = readJson<TestProcessLeaseRecord>(file)
      if (record.version !== 1 || record.pid <= 0 || record.startToken === '') throw new Error('unsupported process lease')
      records.push(record)
    } catch (error) {
      unreadable.push({ file, error: String(error) })
    }
  }
  return { records: records.sort((left, right) => left.registeredAt - right.registeredAt), unreadable }
}

function readEvents(runDir: string): TestLifecycleEvent[] {
  const dir = join(runDir, 'events')
  if (!existsSync(dir)) return []
  const events: TestLifecycleEvent[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    try {
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (line !== '') events.push(JSON.parse(line) as TestLifecycleEvent)
      }
    } catch { /* the partial file remains available in the preserved run dir */ }
  }
  return events.sort((left, right) => left.wallTimeMs - right.wallTimeMs)
}

function signalRegisteredGroup(record: TestProcessLeaseRecord, signal: NodeJS.Signals): 'signalled' | 'gone' | 'mismatch' {
  try {
    process.kill(record.pid, 'SIGSTOP')
  } catch {
    return 'gone'
  }
  if (!processIdentityMatches(record) || processGroupId(record.pid) !== record.pgid || record.pgid !== record.pid) {
    try { process.kill(record.pid, 'SIGCONT') } catch { /* already gone */ }
    return 'mismatch'
  }
  try {
    process.kill(-record.pgid, signal)
    if (signal !== 'SIGKILL') {
      try { process.kill(-record.pgid, 'SIGCONT') } catch { /* group exited */ }
    }
    return 'signalled'
  } catch {
    try { process.kill(record.pid, 'SIGCONT') } catch { /* already gone */ }
    return processIdentityMatches(record) ? 'mismatch' : 'gone'
  }
}

function signalRecord(record: TestProcessLeaseRecord, signal: NodeJS.Signals): 'signalled' | 'gone' | 'mismatch' {
  if (record.pid === process.pid) return 'mismatch'
  return record.groupRoot
    ? signalRegisteredGroup(record, signal)
    : signalProcessIdentity(record, signal)
}

async function waitForNoMatchingProcesses(runDir: string, timeoutMs: number): Promise<TestProcessLeaseRecord[]> {
  const deadline = performance.now() + timeoutMs
  let live: TestProcessLeaseRecord[] = []
  do {
    live = readProcessRecords(runDir).filter(record => record.pid !== process.pid && processIdentityMatches(record))
    if (live.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 100))
      live = readProcessRecords(runDir).filter(record => record.pid !== process.pid && processIdentityMatches(record))
      if (live.length === 0) return []
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  } while (performance.now() < deadline)
  return live
}

/** One Vitest case's immutable process/port ownership ledger. */
export class TestProcessLifecycle {
  readonly root: string
  readonly runDir: string
  readonly runToken: string
  private readonly previousEnv = new Map<string, string | undefined>()
  private readonly portRecords = new Map<number, string>()
  private preserveEvidence = false

  constructor(private readonly registerBin: string) {
    this.root = leaseRoot()
    this.runToken = randomUUID()
    this.runDir = join(this.root, 'runs', this.runToken)
    ensurePrivateDirectory(this.root)
    ensurePrivateDirectory(join(this.root, 'runs'))
    ensurePrivateDirectory(join(this.root, 'ports'))
    ensurePrivateDirectory(this.runDir)
    const owner = processIdentity(process.pid)
    if (owner === null) throw new Error(`cannot capture test-run owner identity for pid ${process.pid}`)
    const run: RunRecord = { version: LEASE_SCHEMA_VERSION, runToken: this.runToken, createdAt: Date.now(), owner, cwd: process.cwd() }
    writeFileSync(join(this.runDir, 'run.json'), `${JSON.stringify(run)}\n`, { flag: 'wx', mode: 0o600 })
    this.installEnv(TEST_RUN_DIR_ENV, this.runDir)
    this.installEnv(TEST_RUN_TOKEN_ENV, this.runToken)
    this.installEnv(TEST_REGISTER_BIN_ENV, registerBin)
    this.installEnv(TEST_SLEEP_SCALE_ENV, '0.05')
  }

  private installEnv(name: string, value: string): void {
    this.previousEnv.set(name, process.env[name])
    process.env[name] = value
  }

  childEnv(role: string, base: NodeJS.ProcessEnv = process.env, options: { port?: number; tempRoot?: string } = {}): NodeJS.ProcessEnv {
    return {
      ...base,
      [TEST_RUN_DIR_ENV]: this.runDir,
      [TEST_RUN_TOKEN_ENV]: this.runToken,
      [TEST_REGISTER_BIN_ENV]: this.registerBin,
      [TEST_SLEEP_SCALE_ENV]: process.env[TEST_SLEEP_SCALE_ENV] ?? '0.05',
      [TEST_PROCESS_ROLE_ENV]: role,
      ...(options.port === undefined ? {} : { [TEST_PROCESS_PORT_ENV]: String(options.port) }),
      ...(options.tempRoot === undefined ? {} : { [TEST_PROCESS_TEMP_ROOT_ENV]: options.tempRoot }),
    }
  }

  private eventEnv(role: string, options: { port?: number; tempRoot?: string } = {}): NodeJS.ProcessEnv {
    return this.childEnv(role, {}, options)
  }

  track(child: ChildProcess, role: string, options: { port?: number; tempRoot?: string } = {}): TestProcessLeaseRecord | null {
    const pid = child.pid
    if (pid === undefined) throw new Error(`${role} spawn returned no pid`)
    const env = this.eventEnv(role, options)
    const record = registerTestProcess(pid, role, {
      env,
      source: 'parent-observer',
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
    })
    appendTestLifecycleEventForProcess(pid, role, 'child-spawned', { childPid: pid, role }, 'parent-observer', env)
    child.once('exit', (code, signal) => {
      appendTestLifecycleEventForProcess(pid, role, 'child-exit-callback', { childPid: pid, code, signal: signal ?? '' }, 'node-exit-callback', env)
    })
    child.once('close', (code, signal) => {
      appendTestLifecycleEventForProcess(pid, role, 'child-close-callback', { childPid: pid, code, signal: signal ?? '' }, 'node-close-callback', env)
    })
    return record
  }

  /** Signal only the captured start identity for a directly spawned child. */
  signal(child: ChildProcess, signal: NodeJS.Signals): 'signalled' | 'gone' | 'mismatch' {
    const pid = child.pid
    if (pid === undefined) return 'gone'
    const record = readProcessRecords(this.runDir).find(candidate => candidate.pid === pid && processIdentityMatches(candidate))
    if (record === undefined) return 'gone'
    return signalRecord(record, signal)
  }

  /** Freeze/revalidate and signal only one direct child, without widening to its group/tree. */
  signalExact(child: ChildProcess, signal: NodeJS.Signals): 'signalled' | 'gone' | 'mismatch' {
    const pid = child.pid
    if (pid === undefined) return 'gone'
    const record = readProcessRecords(this.runDir).find(candidate => candidate.pid === pid && processIdentityMatches(candidate))
    if (record === undefined) return 'gone'
    try {
      process.kill(pid, 'SIGSTOP')
    } catch {
      return 'gone'
    }
    if (!processIdentityMatches(record)) {
      try { process.kill(pid, 'SIGCONT') } catch { /* already gone */ }
      return 'mismatch'
    }
    try {
      process.kill(pid, signal)
      if (signal !== 'SIGKILL' && signal !== 'SIGSTOP') process.kill(pid, 'SIGCONT')
      return 'signalled'
    } catch {
      try { process.kill(pid, 'SIGCONT') } catch { /* already gone */ }
      return processIdentityMatches(record) ? 'mismatch' : 'gone'
    }
  }

  /**
   * Stop runtime identities explicitly registered for a leased port. The
   * number only indexes this run's ledger; it never discovers or authorizes
   * an arbitrary machine process.
   */
  async stopPortProcesses(port: number): Promise<number> {
    const runtimeRoles = new Set(['instance-wrapper', 'instance-listener', 'crash-page', 'restart-instance-root', 'fixture-port-runtime'])
    const records = readProcessRecords(this.runDir).filter(record =>
      record.port === port && runtimeRoles.has(record.role) && processIdentityMatches(record),
    )
    for (const record of records.reverse()) signalProcessIdentity(record, 'SIGKILL')
    const deadline = performance.now() + 2_000
    while (records.some(processIdentityMatches) && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const survivors = records.filter(processIdentityMatches)
    if (survivors.length > 0) throw new Error(`registered port runtimes survived SIGKILL:\n${this.diagnostics()}`)
    return records.length
  }

  /** Allocate a cross-worktree port lease; the reservation stays bound until the durable lease exists. */
  async acquirePort(): Promise<number> {
    const owner = processIdentity(process.pid)
    if (owner === null) throw new Error(`cannot capture port-lease owner identity for pid ${process.pid}`)
    for (let attempt = 1; attempt <= 64; attempt++) {
      const { server, port } = await reserveEphemeralPort()
      const file = join(this.root, 'ports', `${port}.json`)
      const record: PortLeaseRecord = {
        version: LEASE_SCHEMA_VERSION, runToken: this.runToken, port,
        createdAt: Date.now(), owner, runDir: this.runDir,
      }
      let acquired = false
      try {
        writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
        acquired = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          await closeServer(server)
          throw error
        }
        try {
          const incumbentBytes = readFileSync(file, 'utf8')
          const incumbent = JSON.parse(incumbentBytes) as PortLeaseRecord
          if (!processIdentityMatches(incumbent.owner)) {
            appendTestLifecycleEvent('port-lease-collision', { port, attempt, incumbent: 'dead' }, 'parent-observer', this.eventEnv('port-allocator'))
            const quarantine = `${file}.stale-${this.runToken}`
            try {
              renameSync(file, quarantine)
              unlinkSync(quarantine)
            } catch { /* another allocator won the stale-record race */ }
          } else {
            appendTestLifecycleEvent('port-lease-collision', { port, attempt, incumbent: 'live' }, 'parent-observer', this.eventEnv('port-allocator'))
          }
        } catch {
          appendTestLifecycleEvent('port-lease-collision', { port, attempt, incumbent: 'unreadable' }, 'parent-observer', this.eventEnv('port-allocator'))
          // Unreadable records remain for leak-report diagnosis.
        }
      }
      if (acquired) {
        this.portRecords.set(port, file)
        appendTestLifecycleEvent('port-lease-acquired', { port, attempt }, 'parent-observer', this.eventEnv('port-allocator'))
        await closeServer(server)
        return port
      }
      await closeServer(server)
    }
    throw new Error('could not acquire an isolated loopback port after 64 attempts')
  }

  events(): TestLifecycleEvent[] {
    return readEvents(this.runDir)
  }

  diagnostics(): string {
    const processScan = scanProcessRecords(this.runDir)
    const events = this.events()
    let processTable = ''
    try { processTable = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='], { encoding: 'utf8' }) } catch {}
    const processStates = processScan.records.map(record => ({
      record,
      currentIdentity: processIdentity(record.pid),
      matches: processIdentityMatches(record),
      processRow: processTable.split('\n').find(line => Number(/^\s*(\d+)/.exec(line)?.[1]) === record.pid)?.trim() ?? null,
    }))
    const watchdogLogs = [...new Set(processScan.records.flatMap(record => record.tempRoot === undefined ? [] : [join(record.tempRoot, 'watchdog.log')]))]
      .flatMap(file => {
        try { return [{ file, tail: readFileSync(file, 'utf8').slice(-12_000) }] } catch { return [] }
      })
    return JSON.stringify({
      runToken: this.runToken,
      expectedPorts: [...new Set([...this.portRecords.keys(), ...processScan.records.flatMap(record => record.port === undefined ? [] : [record.port])])],
      processStates,
      unreadableProcessRecords: processScan.unreadable,
      watchdogLogs,
      events,
    }, null, 2)
  }

  retainEvidence(): void {
    this.preserveEvidence = true
  }

  /** TERM → bounded wait → KILL → bounded wait over identities registered so far and during teardown. */
  async stopAll(): Promise<void> {
    const initialRecords = readProcessRecords(this.runDir)
    for (const record of initialRecords.reverse()) {
      if (processIdentityMatches(record)) signalRecord(record, 'SIGTERM')
    }
    let survivors = initialRecords.length === 0 ? [] : await waitForNoMatchingProcesses(this.runDir, 2_000)
    for (const record of survivors.reverse()) signalRecord(record, 'SIGKILL')
    survivors = await waitForNoMatchingProcesses(this.runDir, 2_000)
    if (survivors.length > 0) {
      throw new Error(`registered test processes survived TERM/KILL:\n${this.diagnostics()}`)
    }
    const unreadable = scanProcessRecords(this.runDir).unreadable
    if (unreadable.length > 0) {
      throw new Error(`unreadable process leases prevent complete teardown proof:\n${this.diagnostics()}`)
    }
  }

  async teardown(): Promise<void> {
    let failure: Error | undefined
    try {
      await this.stopAll()
      const ports = new Set<number>([
        ...this.portRecords.keys(),
        ...readProcessRecords(this.runDir).flatMap(record => record.port === undefined ? [] : [record.port]),
      ])
      const occupied = [...ports].map(port => ({ port, pids: findPidsOnPort(port) })).filter(item => item.pids.length > 0)
      if (occupied.length > 0) throw new Error(`registered ports still have listeners: ${JSON.stringify(occupied)}\n${this.diagnostics()}`)
      for (const [port, file] of this.portRecords) {
        try {
          const record = readJson<PortLeaseRecord>(file)
          if (record.runToken === this.runToken && record.port === port) unlinkSync(file)
        } catch { /* retain unreadable/mismatched evidence */ }
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    } finally {
      for (const [name, value] of this.previousEnv) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      if (failure === undefined && !this.preserveEvidence) rmSync(this.runDir, { recursive: true, force: true })
    }
    if (failure !== undefined) throw failure
  }
}

function collectJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    let info
    try { info = lstatSync(path) } catch { continue }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) out.push(...collectJsonFiles(path))
    else if (name.endsWith('.json')) out.push(path)
  }
  return out
}

/** Read-only machine lease audit; it deliberately never sends signals or removes records. */
export function inspectMachineTestLeases(now = Date.now(), liveReportAgeMs = DEFAULT_LIVE_REPORT_AGE_MS): MachineLeaseReport {
  const root = leaseRoot()
  const report: MachineLeaseReport = { root, reclaimable: [], overAgeLive: [], activeLive: [], unreadable: [] }
  if (!existsSync(root)) return report
  const processFiles = collectJsonFiles(join(root, 'runs')).filter(file => basename(file) !== 'run.json')
  for (const file of processFiles) {
    try {
      const record = readJson<TestProcessLeaseRecord>(file)
      if (record.version !== 1 || record.startToken === '') throw new Error('unsupported process lease')
      let run: RunRecord | undefined
      try { run = readJson<RunRecord>(join(dirname(dirname(file)), 'run.json')) } catch { /* reported through the record's path */ }
      const finding = { record, file, ageMs: Math.max(0, now - record.registeredAt), ...(run === undefined ? {} : { run }) }
      if (!processIdentityMatches(record)) report.reclaimable.push(finding)
      else if (finding.ageMs >= liveReportAgeMs) report.overAgeLive.push(finding)
      else report.activeLive.push(finding)
    } catch (error) {
      report.unreadable.push({ file, error: String(error) })
    }
  }
  for (const file of collectJsonFiles(join(root, 'ports'))) {
    try {
      const record = readJson<PortLeaseRecord>(file)
      if (record.version !== 1) throw new Error('unsupported port lease')
      let run: RunRecord | undefined
      try { run = readJson<RunRecord>(join(record.runDir, 'run.json')) } catch { /* reported through the record's path */ }
      const finding = { record, file, ageMs: Math.max(0, now - record.createdAt), ...(run === undefined ? {} : { run }) }
      if (!processIdentityMatches(record.owner)) report.reclaimable.push(finding)
      else if (finding.ageMs >= liveReportAgeMs) report.overAgeLive.push(finding)
      else report.activeLive.push(finding)
    } catch (error) {
      report.unreadable.push({ file, error: String(error) })
    }
  }
  return report
}

/**
 * Remove only fully dead, identity-proven test runs and marked snapshot roots.
 * No PID or port is ever signalled; unreadable, mixed-live, and unsafe paths
 * remain as evidence. A machine-level identity lock serializes worktrees.
 */
export function reclaimMachineTestLeases(
  now = Date.now(),
  minimumAgeMs = 0,
  scope?: MachineLeaseReclaimScope,
): MachineLeaseReclaimResult {
  if (!Number.isFinite(minimumAgeMs) || minimumAgeMs < 0) {
    throw new Error('minimum reclaim age must be a non-negative finite number')
  }
  const root = scope?.root ?? leaseRoot()
  const tempBase = scope?.tempBase ?? tmpdir()
  const result: MachineLeaseReclaimResult = {
    root, minimumAgeMs, lock: 'busy', removedRuns: [], removedPortLeases: [],
    removedTempRoots: [], skipped: [], errors: [],
  }
  const lock = acquireReclaimLock(root)
  if (lock === null) return result
  result.lock = 'acquired'
  const suffix = `${process.pid}-${randomUUID()}`
  try {
    const runsRoot = join(root, 'runs')
    const runCandidates: Array<{
      dir: string
      record: RunRecord
      tempRoots: Set<string>
      processEvidence: string
      eligible: boolean
    }> = []
    if (existsSync(runsRoot)) {
      for (const name of readdirSync(runsRoot)) {
        const dir = join(runsRoot, name)
        try {
          const info = lstatSync(dir)
          if (!info.isDirectory() || info.isSymbolicLink()) {
            result.skipped.push({ path: dir, reason: 'run entry is not a plain directory' })
            continue
          }
          const rawRun = readJson<unknown>(join(dir, 'run.json'))
          if (!validRunRecord(rawRun, name)) {
            result.skipped.push({ path: dir, reason: 'run record is missing, malformed, or names another directory' })
            continue
          }
          const scan = scanProcessRecords(dir)
          const invalidProcess = scan.records.some(record => !validProcessLeaseRecord(record, rawRun.runToken))
          const tempRoots = new Set<string>()
          let unsafeTempRoot = false
          for (const processRecord of scan.records) {
            if (processRecord.tempRoot === undefined) continue
            const safe = safeOwnedTempRoot(processRecord.tempRoot, tempBase)
            if (safe === null) {
              unsafeTempRoot = true
              result.skipped.push({ path: processRecord.tempRoot, reason: 'temp root is outside the owned mkdtemp namespace' })
            } else if (safe.present) {
              tempRoots.add(safe.root)
            }
          }
          const oldEnough = Math.max(0, now - rawRun.createdAt) >= minimumAgeMs
          const allDead = !processIdentityMatches(rawRun.owner)
            && scan.records.every(record => !processIdentityMatches(record))
          const eligible = oldEnough && allDead && scan.unreadable.length === 0 && !invalidProcess && !unsafeTempRoot
          if (!eligible) {
            const reason = !oldEnough ? 'run is newer than the reclaim age'
              : processIdentityMatches(rawRun.owner) || scan.records.some(processIdentityMatches)
                ? 'run still has a live owner or registered process'
                : unsafeTempRoot ? 'run contains an unsafe temp-root reference'
                  : 'run contains unreadable or mismatched process evidence'
            result.skipped.push({ path: dir, reason })
          }
          runCandidates.push({
            dir, record: rawRun, tempRoots,
            processEvidence: processEvidenceSignature(scan.records), eligible,
          })
        } catch (error) {
          if (!isNotFound(error)) result.errors.push({ path: dir, error: String(error) })
        }
      }
    }

    const protectedTempRoots = new Set<string>()
    const tempRootReferenceCounts = new Map<string, number>()
    for (const candidate of runCandidates) {
      for (const tempRoot of candidate.tempRoots) {
        tempRootReferenceCounts.set(tempRoot, (tempRootReferenceCounts.get(tempRoot) ?? 0) + 1)
        if (!candidate.eligible) protectedTempRoots.add(tempRoot)
      }
    }
    for (const [tempRoot, count] of tempRootReferenceCounts) {
      if (count > 1) protectedTempRoots.add(tempRoot)
    }

    for (const candidate of runCandidates.filter(item => item.eligible)) {
      // Revalidate immediately before the irreversible rename. A PID reused
      // or process registered after the first scan turns the run ineligible.
      const latest = scanProcessRecords(candidate.dir)
      let latestRun: unknown
      try { latestRun = readJson<unknown>(join(candidate.dir, 'run.json')) } catch { latestRun = null }
      if (!validRunRecord(latestRun, candidate.record.runToken)
        || latestRun.createdAt !== candidate.record.createdAt
        || latestRun.owner.pid !== candidate.record.owner.pid
        || latestRun.owner.startToken !== candidate.record.owner.startToken
        || processIdentityMatches(candidate.record.owner) || latest.unreadable.length > 0
        || processEvidenceSignature(latest.records) !== candidate.processEvidence
        || latest.records.some(record => !validProcessLeaseRecord(record, candidate.record.runToken)
          || processIdentityMatches(record))) {
        result.skipped.push({ path: candidate.dir, reason: 'identity or evidence changed during reclaim' })
        continue
      }
      let cleanupFailed = false
      for (const tempRoot of candidate.tempRoots) {
        if (protectedTempRoots.has(tempRoot)) {
          result.skipped.push({ path: tempRoot, reason: 'another retained run references this temp root' })
          cleanupFailed = true
          continue
        }
        try {
          const safe = safeOwnedTempRoot(tempRoot, tempBase)
          if (safe === null || !safe.present || safe.root !== tempRoot) {
            if (safe !== null && !safe.present) continue
            result.skipped.push({ path: tempRoot, reason: 'temp root changed during reclaim' })
            cleanupFailed = true
            continue
          }
          if (atomicRemove(tempRoot, suffix)) result.removedTempRoots.push(tempRoot)
        } catch (error) {
          result.errors.push({ path: tempRoot, error: String(error) })
          cleanupFailed = true
        }
      }
      if (cleanupFailed) {
        result.skipped.push({ path: candidate.dir, reason: 'temp-root cleanup was incomplete; run evidence retained' })
        continue
      }
      try {
        if (atomicRemove(candidate.dir, suffix)) result.removedRuns.push(candidate.dir)
      } catch (error) {
        result.errors.push({ path: candidate.dir, error: String(error) })
      }
    }

    const portsRoot = join(root, 'ports')
    if (existsSync(portsRoot)) {
      for (const name of readdirSync(portsRoot)) {
        if (!name.endsWith('.json')) continue
        const file = join(portsRoot, name)
        try {
          const record = readJson<unknown>(file)
          if (!validPortLeaseRecord(record)) {
            result.skipped.push({ path: file, reason: 'port lease is malformed' })
            continue
          }
          const expectedRunDir = join(runsRoot, record.runToken)
          if (name !== `${record.port}.json` || resolve(record.runDir) !== resolve(expectedRunDir)) {
            result.skipped.push({ path: file, reason: 'port lease does not match its filename or machine run directory' })
            continue
          }
          if (Math.max(0, now - record.createdAt) < minimumAgeMs) continue
          if (processIdentityMatches(record.owner)) {
            result.skipped.push({ path: file, reason: 'port lease owner is live' })
            continue
          }
          if (existsSync(expectedRunDir)) {
            result.skipped.push({ path: file, reason: 'port lease belongs to a retained run' })
            continue
          }
          if (atomicRemove(file, suffix)) result.removedPortLeases.push(file)
        } catch (error) {
          if (!isNotFound(error)) result.errors.push({ path: file, error: String(error) })
        }
      }
    }

    // Snapshot roots may outlive their parent before a test run can register
    // them. Only the creator-authored marker grants deletion authority.
    const canonicalTempBase = realpathSync(tempBase)
    for (const name of readdirSync(canonicalTempBase)) {
      if (!/^ankh-transition-preflight-[A-Za-z0-9]{6}$/.test(name)) continue
      const artifactRoot = join(canonicalTempBase, name)
      if (protectedTempRoots.has(artifactRoot)) continue
      try {
        const safe = safeOwnedTempRoot(artifactRoot, canonicalTempBase)
        if (safe === null || !safe.present || safe.root !== artifactRoot) {
          result.skipped.push({ path: artifactRoot, reason: 'snapshot root failed owned-temp validation' })
          continue
        }
        const marker = readJson<unknown>(join(artifactRoot, TEMP_ARTIFACT_OWNER_FILE))
        if (!validTempArtifactOwner(marker)) {
          result.skipped.push({ path: artifactRoot, reason: 'snapshot owner marker is malformed' })
          continue
        }
        if (Math.max(0, now - marker.createdAt) < minimumAgeMs) continue
        if (processIdentityMatches(marker.owner)) {
          result.skipped.push({ path: artifactRoot, reason: 'snapshot owner is live' })
          continue
        }
        if (atomicRemove(artifactRoot, suffix)) result.removedTempRoots.push(artifactRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Legacy/unmarked snapshots are deliberately not guessed safe.
          result.skipped.push({ path: artifactRoot, reason: 'snapshot has no owner marker' })
        } else {
          result.errors.push({ path: artifactRoot, error: String(error) })
        }
      }
    }
  } finally {
    lock.release()
  }
  return result
}

export function formatMachineLeaseReclaimResult(result: MachineLeaseReclaimResult): string {
  const lines = [
    `Ankh Guard test lease reclaim: ${result.root}`,
    `lock: ${result.lock}`,
    `minimum-age-ms: ${result.minimumAgeMs}`,
    `removed-runs: ${result.removedRuns.length}`,
    `removed-port-leases: ${result.removedPortLeases.length}`,
    `removed-temp-roots: ${result.removedTempRoots.length}`,
    `skipped: ${result.skipped.length}`,
    `errors: ${result.errors.length}`,
  ]
  for (const finding of result.errors) lines.push(`  ${finding.path}: ${finding.error}`)
  return `${lines.join('\n')}\n`
}

/** Render only credential-free ownership evidence for a human cleanup decision. */
export function formatMachineLeaseReport(report: MachineLeaseReport): string {
  const lines = [`Ankh Guard test lease report: ${report.root}`]
  const render = (label: string, findings: Array<MachineLeaseFinding<TestProcessLeaseRecord | PortLeaseRecord>>): void => {
    lines.push(`${label}: ${findings.length}`)
    for (const finding of findings) {
      const record = finding.record
      const identity = 'pid' in record ? record : record.owner
      const role = 'role' in record ? record.role : 'port-lease'
      const pgid = 'pgid' in record ? record.pgid : '-'
      const tempRoot = 'tempRoot' in record ? record.tempRoot : undefined
      lines.push(
        `  ${finding.file} ageMs=${finding.ageMs} pid=${identity.pid} pgid=${pgid} startToken=${identity.startToken}`
        + ` role=${role}${'port' in record && record.port !== undefined ? ` port=${record.port}` : ''}`
        + `${tempRoot === undefined ? '' : ` tempRoot=${tempRoot}`}`
        + `${finding.run === undefined ? '' : ` runOwner=${finding.run.owner.pid}/${finding.run.owner.startToken} cwd=${finding.run.cwd}`}`,
      )
    }
  }
  render('reclaimable-dead', report.reclaimable)
  render('over-age-live-human-review', report.overAgeLive)
  render('active-live', report.activeLive)
  lines.push(`unreadable: ${report.unreadable.length}`)
  for (const finding of report.unreadable) lines.push(`  ${finding.file}: ${finding.error}`)
  return `${lines.join('\n')}\n`
}
