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
