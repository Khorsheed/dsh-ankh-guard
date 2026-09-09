/**
 * Process primitives shared by the guard CLI and the exit agent: locating the
 * listener on a port and killing a process tree. One owner — the watchdog's
 * bash side keeps its own copy (different runtime), but every TypeScript
 * caller goes through here.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

/** A PID plus the kernel-visible process start instant used to reject PID reuse. */
export interface ProcessIdentity {
  pid: number
  startToken: string
}

/** The old supervisor's exact child root and the listener inside that tree. */
export interface OwnedListener {
  child: ProcessIdentity
  listener: ProcessIdentity
}

function executable(name: string, candidates: readonly string[]): string {
  return candidates.find(candidate => existsSync(candidate)) ?? name
}

// dsh tool sessions intentionally carry a narrow PATH on macOS. Never turn a
// missing /usr/sbin entry into "no listener"; use the platform's canonical
// absolute paths first and retain PATH lookup only as a portable fallback.
const LSOF = executable('lsof', ['/usr/sbin/lsof', '/usr/bin/lsof'])
const PS = executable('ps', ['/bin/ps', '/usr/bin/ps'])
const PGREP = executable('pgrep', ['/usr/bin/pgrep', '/bin/pgrep'])
const SYSCTL = executable('sysctl', ['/usr/sbin/sysctl', '/sbin/sysctl'])
const PYTHON = executable('python3', ['/usr/bin/python3', '/opt/homebrew/bin/python3'])
const DARWIN_START_TOKEN = [
  'import ctypes,struct,sys',
  'p=int(sys.argv[1])',
  'b=ctypes.create_string_buffer(136)',
  'n=ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidinfo(p,3,0,b,136)',
  'n == 136 or sys.exit(1)',
  's,u=struct.unpack_from("QQ",b.raw,120)',
  'print(f"darwin:{s}:{u}",end="")',
].join(';')

/** Every process listening on a TCP port. An empty list also covers unavailable lsof. */
export function findPidsOnPort(port: number): number[] {
  try {
    const out = execFileSync(LSOF, [`-tiTCP:${port}`, '-sTCP:LISTEN', '-P'], { encoding: 'utf8', stdio: 'pipe' }).trim()
    return [...new Set(out.split('\n').map(Number).filter(pid => Number.isInteger(pid) && pid > 0))]
  } catch {
    return []
  }
}

/** TCP listen ports owned directly by one PID, using the same absolute lsof resolution. */
export function listeningPortsForPid(pid: number): number[] {
  try {
    const out = execFileSync(LSOF, ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', stdio: 'pipe' })
    return [...new Set([...out.matchAll(/:(\d+) \(LISTEN\)/g)].map(match => Number(match[1])).filter(Number.isInteger))]
  } catch {
    return []
  }
}

/** The first process listening on a TCP port, or null when none is (via lsof). */
export function findPidOnPort(port: number): string | null {
  return findPidsOnPort(port)[0]?.toString() ?? null
}

/**
 * Current identity for a live process, or null when it cannot be proved.
 * Linux exposes a boot-scoped kernel start tick. Other POSIX hosts do not,
 * so bind the start instant to the boot, uid, session, and settled command.
 * This materially strengthens macOS ps(1)'s second-granularity lstart; all
 * guard captures occur after the watchdog/child has reached its steady argv.
 */
export function processIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const status = execFileSync(PS, ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: 'pipe' }).trim()
    if (status === '' || status.startsWith('Z')) return null
    if (process.platform === 'darwin') {
      try {
        const nativeStart = execFileSync(PYTHON, ['-c', DARWIN_START_TOKEN, String(pid)], {
          encoding: 'utf8', stdio: 'pipe',
        }).trim()
        if (/^darwin:\d+:\d+$/.test(nativeStart)) return { pid, startToken: nativeStart }
      } catch {
        // Minimal macOS installations can lack python3; use the strengthened
        // ps evidence below rather than silently dropping identity checks.
      }
    }
    const procStat = `/proc/${pid}/stat`
    if (existsSync(procStat)) {
      const stat = readFileSync(procStat, 'utf8')
      const commandEnd = stat.lastIndexOf(')')
      const fields = commandEnd < 0 ? [] : stat.slice(commandEnd + 1).trim().split(/\s+/)
      const startTicks = fields[19]
      if (startTicks === undefined || startTicks === '') return null
      let bootId = 'unknown-boot'
      try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || bootId } catch { /* optional */ }
      return { pid, startToken: `linux:${bootId}:${startTicks}` }
    }
    const processEvidence = execFileSync(PS, ['-o', 'sess=', '-o', 'uid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', stdio: 'pipe',
    }).trim()
    if (processEvidence === '') return null
    let bootEvidence = 'unknown-boot'
    try {
      bootEvidence = execFileSync(SYSCTL, ['-n', 'kern.boottime'], {
        encoding: 'utf8', stdio: 'pipe',
      }).trim() || bootEvidence
    } catch {
      // The start instant + uid/session remains a portable fallback.
    }
    const startToken = `posix:${createHash('sha256').update(bootEvidence).update('\0').update(processEvidence).digest('hex')}`
    return { pid, startToken }
  } catch {
    return null
  }
}

/** Whether the same, non-recycled process is still alive. */
export function processIdentityMatches(identity: ProcessIdentity): boolean {
  return processIdentity(identity.pid)?.startToken === identity.startToken
}

function parentPid(pid: number): number | null {
  try {
    const value = Number(execFileSync(PS, ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: 'pipe' }).trim())
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** The live POSIX process-group id for one PID, or null when unavailable. */
export function processGroupId(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const value = Number(execFileSync(PS, ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', stdio: 'pipe' }).trim())
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** Whether candidate is root itself or a live descendant of root. */
export function pidBelongsToTree(root: number, candidate: number): boolean {
  let cursor = candidate
  const seen = new Set<number>()
  while (cursor > 0 && !seen.has(cursor)) {
    if (cursor === root) return true
    seen.add(cursor)
    const parent = parentPid(cursor)
    if (parent === null) return false
    cursor = parent
  }
  return false
}

/**
 * Prove that exactly one port listener belongs to a supervisor and return the
 * direct child root through which that supervisor owns it. This is captured
 * before cutover; the successor must stop this identity, never an arbitrary
 * process discovered later from the shared port.
 */
export function findOwnedListener(port: number, supervisorPid: number): OwnedListener | null {
  const listeners = findPidsOnPort(port)
  if (listeners.length !== 1) return null
  const listenerPid = listeners[0]
  if (listenerPid === undefined) return null
  const listener = processIdentity(listenerPid)
  if (listener === null) return null
  let cursor = listenerPid
  let childRoot: number | null = null
  const seen = new Set<number>()
  while (cursor > 0 && !seen.has(cursor)) {
    seen.add(cursor)
    const parent = parentPid(cursor)
    if (parent === supervisorPid) {
      childRoot = cursor
      break
    }
    if (parent === null) return null
    cursor = parent
  }
  if (childRoot === null) return null
  const child = processIdentity(childRoot)
  return child === null ? null : { child, listener }
}

/** POSIX single-quote one word for a shell command line. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`
}

/**
 * Discover how the process on a port was launched — its exact argv from
 * `ps -o command=`, its cwd from lsof, and its DSH_* environment from
 * `ps eww` — rendered as a shell command. This exists because the agent's
 * sandbox blocks ps entirely, so every fresh-machine agent fell into a
 * process-tree archaeology loop before its first restart; the CLI (running
 * unsandboxed) answers the same question mechanically and reliably. Returns
 * null when the process is gone or ps/lsof are unavailable.
 * @param pid - the listener's pid.
 */
export function discoverLaunchCommand(pid: string): string | null {
  let argv: string
  let cwd: string
  try {
    argv = execFileSync(PS, ['-o', 'command=', '-p', pid], { encoding: 'utf8', stdio: 'pipe' }).trim()
    if (argv === '') return null
  } catch (error) {
    throw new Error(`ps unavailable: ${String(error)}`)
  }
  try {
    const out = execFileSync(LSOF, ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: 'pipe' })
    const match = /^n(.+)$/m.exec(out)
    if (match === null) return null
    cwd = match[1] ?? ''
  } catch (error) {
    throw new Error(`lsof cwd unavailable: ${String(error)}`)
  }
  const TRANSIENT = new Set(['DSH_ANKH_RESTART_DRIVER', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_WEB_URL', 'DSH_SHELL'])
  const env: Record<string, string> = {}
  try {
    const out = execFileSync(PS, ['eww', '-o', 'command', '-p', pid], { encoding: 'utf8', stdio: 'pipe' })
    for (const token of out.split(/\s+/)) {
      const eq = token.indexOf('=')
      if (eq > 0 && token.slice(0, eq).startsWith('DSH_') && !TRANSIENT.has(token.slice(0, eq))) env[token.slice(0, eq)] = token.slice(eq + 1)
    }
  } catch {
    // env undiscoverable — the command still works when the instance's own
    // environment carries the defaults.
  }
  const envPart = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')
  return `cd ${shellQuote(cwd)} && ${envPart !== '' ? `${envPart} ` : ''}${argv}`
}

/**
 * Kill a pid AND its descendants, deepest first (best effort). The supervised
 * instance may have forked children; a plain signal on the pid alone would
 * orphan them (the EADDRINUSE race the watchdog's EADDRINUSE branch exists
 * for). The process-group model is NOT assumed — the instance is not
 * setsid'd — so the sweep walks `pgrep -P` instead. `pgrep` missing or
 * returning nothing is fine: the pid itself still gets the signal.
 */
function signalFrozenTree(pid: number, signal: NodeJS.Signals): boolean {
  let safe = true
  let children: string[] = []
  try {
    const out = execFileSync(PGREP, ['-P', String(pid)], { encoding: 'utf8', stdio: 'pipe' }).trim()
    children = out === '' ? [] : out.split('\n')
  } catch {
    // no children, or pgrep unavailable — the pid itself still gets killed
  }
  for (const raw of children) {
    const child = Number(raw)
    if (!Number.isInteger(child) || child <= 0) continue
    try {
      process.kill(child, 'SIGSTOP')
    } catch {
      continue
    }
    // pgrep and SIGSTOP are separate syscalls. Verify the frozen PID is still
    // this frozen parent's child before recursively signalling it; if not,
    // resume the unrelated process and refuse to claim a complete sweep.
    if (parentPid(child) !== pid) {
      safe = false
      try { process.kill(child, 'SIGCONT') } catch { /* already gone */ }
      continue
    }
    safe = signalFrozenTree(child, signal) && safe
  }
  try {
    process.kill(pid, signal)
    if (signal !== 'SIGKILL') process.kill(pid, 'SIGCONT')
  } catch {
    // already gone
  }
  return safe
}

/**
 * Freeze, then revalidate, then signal an authorized process identity. A
 * mismatch resumes the PID without delivering the requested signal.
 */
export function signalProcessIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): 'signalled' | 'gone' | 'mismatch' {
  try {
    process.kill(identity.pid, 'SIGSTOP')
  } catch {
    return 'gone'
  }
  if (!processIdentityMatches(identity)) {
    try { process.kill(identity.pid, 'SIGCONT') } catch { /* already gone */ }
    return 'mismatch'
  }
  return signalFrozenTree(identity.pid, signal) ? 'signalled' : 'mismatch'
}

export function killPidTree(pid: number, signal: NodeJS.Signals): void {
  try {
    // Freeze before enumeration so a wrapper cannot exit and orphan its
    // listener to PID 1 between pgrep and delivery of the requested signal.
    process.kill(pid, 'SIGSTOP')
  } catch {
    return // already gone
  }
  signalFrozenTree(pid, signal)
}
