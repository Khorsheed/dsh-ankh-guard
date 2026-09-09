/** Machine admission for test tooling only. No process is signalled or reclaimed. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function acquireTestResource(name, {
  root = join(tmpdir(), `dsh-test-admission-${process.getuid?.() ?? 'unknown'}`),
  timeoutMs = 20 * 60_000,
  pollMs = 250,
  report = event => process.stderr.write(`${JSON.stringify(event)}\n`),
} = {}) {
  if (!/^[a-z-]+$/.test(name)) throw new Error('invalid test resource name')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)
    || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`unsafe test admission directory: ${root}`)
  }
  const file = join(root, `${name}.json`)
  const mine = { pid: process.pid, token: randomUUID(), cwd: process.cwd(), createdAt: Date.now() }
  const started = performance.now()
  let announced = -Infinity
  while (true) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: 'wx', mode: 0o600 })
      const release = () => {
        try {
          if (JSON.parse(readFileSync(file, 'utf8')).token === mine.token) unlinkSync(file)
        } catch { /* Preserve unreadable or replaced ownership evidence. */ }
      }
      // Only the caller knows when ALL descendants have settled. An exit hook
      // would release early on a crash while detached test children still run.
      report({ event: 'test-admission-acquired', name, file, waitedMs: Math.round(performance.now() - started), owner: mine })
      return release
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    let owner = null
    try { owner = JSON.parse(readFileSync(file, 'utf8')) } catch { /* Writer may still be publishing. */ }
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0) } catch (error) {
        if (error.code === 'ESRCH') {
          throw new Error(`test admission owner exited; inspect retained lock ${file} and its test processes before removing it`)
        }
      }
    }
    const waitedMs = performance.now() - started
    if (waitedMs >= timeoutMs) throw new Error(`test admission timed out after ${Math.round(waitedMs)}ms: ${file}; owner=${JSON.stringify(owner)}`)
    if (waitedMs - announced >= 15_000) {
      report({ event: 'test-admission-waiting', name, file, waitedMs: Math.round(waitedMs), timeoutMs, owner })
      announced = waitedMs
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}
