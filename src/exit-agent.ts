/**
 * The schedule-exit exit agent: a DETACHED one-shot process that SIGTERMs the
 * listener on a port after a delay and records the outcome to a result file.
 * Detached (setsid via the spawning CLI) so the scheduling turn's end cannot
 * reap it — the fix for "the kill never happened" seen with `(sleep N; kill) &`
 * from a managed shell. A real file (not a `node -e` string) so the logic
 * typechecks, lints, and unit-tests.
 *
 * Environment (set by the CLI's schedule-exit):
 *   WD_PORT=N          port whose listener receives the SIGTERM
 *   WD_DELAY_MS=MS     delay before the kill, so the scheduling turn finishes
 *   WD_RESULT_FILE=F   the restart record written after the attempt
 *   WD_INITIATOR=ID    session that scheduled the exit (rides into the record)
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { findPidOnPort } from './processes.ts'

/** The exit agent's environment input. */
export interface ExitAgentEnv {
  WD_PORT?: string
  WD_DELAY_MS?: string
  WD_RESULT_FILE?: string
  WD_INITIATOR?: string
}

/**
 * One exit attempt: SIGTERM the listener on {@link port} and record the
 * outcome. Extracted from the timer so tests can drive it directly.
 */
export function performExit(port: number, resultFile: string, initiator: string | undefined): void {
  const record = (fields: Record<string, unknown>): string =>
    JSON.stringify({ ...fields, ...(initiator !== undefined ? { initiator } : {}) })
  try {
    const pid = findPidOnPort(port)
    const pidNumber = pid === null ? NaN : Number(pid)
    if (Number.isInteger(pidNumber)) {
      process.kill(pidNumber, 'SIGTERM')
      writeFileSync(resultFile, record({ exitAt: Date.now(), pid: pidNumber }))
    } else {
      writeFileSync(resultFile, record({ error: `no listener on port ${port}` }))
    }
  } catch (error) {
    writeFileSync(resultFile, record({ error: String(error) }))
  }
}

/** The agent's main: read the environment, arm the one-shot timer. */
export function exitAgentMain(env: ExitAgentEnv = process.env): void {
  const port = Number(env.WD_PORT)
  const delayMs = Number(env.WD_DELAY_MS)
  const resultFile = env.WD_RESULT_FILE
  if (!Number.isInteger(port) || !Number.isInteger(delayMs) || resultFile === undefined || resultFile === '') {
    process.stderr.write('exit-agent: WD_PORT, WD_DELAY_MS and WD_RESULT_FILE are required\n')
    process.exit(2)
  }
  setTimeout(() => { performExit(port, resultFile, env.WD_INITIATOR) }, delayMs)
}

// Direct invocation only: imported (tests, bundling) it must never fire.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  exitAgentMain()
}
