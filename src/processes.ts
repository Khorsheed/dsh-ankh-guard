/**
 * Process primitives shared by the guard CLI and the exit agent: locating the
 * listener on a port and killing a process tree. One owner — the watchdog's
 * bash side keeps its own copy (different runtime), but every TypeScript
 * caller goes through here.
 */
import { execFileSync } from 'node:child_process'

/** The first process listening on a TCP port, or null when none is (via lsof). */
export function findPidOnPort(port: number): string | null {
  try {
    const out = execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN', '-P'], { encoding: 'utf8', stdio: 'pipe' }).trim()
    const first = out.split('\n')[0]
    return first !== undefined && first !== '' ? first : null
  } catch {
    return null
  }
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
    argv = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8', stdio: 'pipe' }).trim()
    if (argv === '') return null
  } catch (error) {
    throw new Error(`ps unavailable: ${String(error)}`)
  }
  try {
    const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: 'pipe' })
    const match = /^n(.+)$/m.exec(out)
    if (match === null) return null
    cwd = match[1] ?? ''
  } catch (error) {
    throw new Error(`lsof cwd unavailable: ${String(error)}`)
  }
  const TRANSIENT = new Set(['DSH_ANKH_RESTART_DRIVER', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_WEB_URL', 'DSH_SHELL'])
  const env: Record<string, string> = {}
  try {
    const out = execFileSync('ps', ['eww', '-o', 'command', '-p', pid], { encoding: 'utf8', stdio: 'pipe' })
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
export function killPidTree(pid: number, signal: NodeJS.Signals): void {
  let children: string[] = []
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: 'pipe' }).trim()
    children = out === '' ? [] : out.split('\n')
  } catch {
    // no children, or pgrep unavailable — the pid itself still gets killed
  }
  for (const raw of children) {
    const child = Number(raw)
    if (Number.isInteger(child) && child > 0) killPidTree(child, signal)
  }
  try {
    process.kill(pid, signal)
  } catch {
    // already gone
  }
}
