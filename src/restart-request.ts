/**
 * In-process guarded-restart trigger for UI-grade callers (the mode
 * switcher's host half). Dispatches on supervision — no live watchdog: the
 * `restart` verb's self-contained stop→start→canary; supervised:
 * `reconfigure`'s transactional cutover, the only safe way to change the
 * launch command under a live watchdog (its respawn would otherwise fight
 * the new command). The trigger shells out to this package's own CLI, so
 * the gate chain (credential → preflight → marker/lock) keeps exactly one
 * behavior source and the detached driver keeps its proven lifetime rules;
 * the structured verdict returns through DSH_ANKH_VERDICT_FILE, never
 * scraped from the human stderr text.
 *
 * Never import the CLI module from the plugin graph: a runtime edge pulls
 * cli.ts into a shared tsdown chunk, evicting its code from lib/cli.js so
 * the direct-invocation guard never fires and the built CLI silently exits
 * 0 on every call (observed 2026-09-09; type-only imports are erased and
 * stay safe).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CliRefusal } from './cli.ts'
import { readInstanceLaunch } from './restart-context.ts'
import { liveWatchdogPid } from './state-files.ts'

/** One guarded-restart request. */
export interface RestartRequest {
  /** The successor launch command (the target profile's `dsh web …` line). */
  start: string
  /** The dsh profile the composition preflight dry-runs. */
  profile: string
  /** The session id the restart report returns to — required, never invented. */
  initiator: string
}

/** The structured verdict; terminal hint text never crosses this seam. */
export type RestartRequestResult =
  | { accepted: true; via: 'restart' | 'reconfigure'; detail: string }
  | { accepted: false; stage: string; reason: string; detail: string }

/** Bounded human detail carried alongside the structured verdict, for display. */
const DETAIL_CAP = 4096

/**
 * argv (after process.execPath) that runs this package's CLI with the given
 * args — the same source/built split as the CLI's own cliInvocation, resolved
 * from this module's directory (src/ and lib/ keep their entries side by
 * side). The two copies must not be unified through an import: see the module
 * doc for what a runtime edge into the CLI module does to the built bundle.
 */
function cliEntryArgs(args: readonly string[]): string[] {
  // Check the FILE path, not the directory: '…/src' has no trailing
  // separator and never matches '/src/' — cliInvocation gets this right
  // because it tests the module file itself.
  const modulePath = fileURLToPath(import.meta.url)
  const here = dirname(modulePath)
  if (modulePath.includes(`${sep}src${sep}`)) {
    const tsx = join(resolve(here, '../../../node_modules'), 'tsx', 'dist', 'esm', 'index.mjs')
    if (existsSync(tsx)) return ['--import', tsx, join(here, 'cli.ts'), ...args]
    return [join(here, 'cli.ts'), ...args]
  }
  return [join(here, 'cli.js'), ...args]
}

/** Read the caller-side verdict file, or null when the CLI never wrote one. */
function readVerdict(file: string): CliRefusal | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<CliRefusal>
    return typeof value.stage === 'string' && typeof value.reason === 'string'
      ? { stage: value.stage, reason: value.reason }
      : null
  } catch {
    return null
  }
}

/**
 * Validate and dispatch one restart request through the guard's own gate
 * chain. A refusal never stops the running instance.
 * @param request - the successor command, target profile, and owning session.
 * @param context - the guard's resolved state dir and credential repo.
 * @returns the structured verdict with bounded human detail for display.
 */
export async function requestRestart(
  request: RestartRequest,
  context: { stateDir: string; repoDir: string },
): Promise<RestartRequestResult> {
  if (request.start.trim() === '') {
    return { accepted: false, stage: 'usage', reason: 'start (the successor launch command) is required', detail: '' }
  }
  if (request.profile.trim() === '') {
    return { accepted: false, stage: 'usage', reason: 'profile (the dsh profile to preflight) is required', detail: '' }
  }
  if (request.initiator.trim() === '') {
    return { accepted: false, stage: 'usage', reason: 'initiator (the session id the restart report returns to) is required — never invent one', detail: '' }
  }
  const port = readInstanceLaunch(context.stateDir)?.port
  if (port === undefined) {
    return { accepted: false, stage: 'usage', reason: "no instance launch record in the state dir — the guard does not know this instance's port", detail: '' }
  }
  const via = liveWatchdogPid(context.stateDir) === null ? 'restart' : 'reconfigure'
  const argv = via === 'restart'
    ? [
        'restart', '--port', String(port), '--start', request.start, '--profile', request.profile,
        '--initiator', request.initiator, '--state-dir', context.stateDir, '--repo', context.repoDir,
      ]
    : [
        'reconfigure', '--start', request.start, '--profile', request.profile,
        '--on-failure', 'restore-previous', '--initiator', request.initiator, '--state-dir', context.stateDir,
      ]
  const verdictDir = mkdtempSync(join(tmpdir(), 'ankh-restart-request-'))
  const verdictFile = join(verdictDir, 'verdict.json')
  // This instance's own supervision variables must not leak into the CLI's
  // children: a WD_STATE_DIR would retarget every watchdog they spawn (the
  // same scrub the restart verb applies to the instance it starts).
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_ANKH_VERDICT_FILE: verdictFile }
  delete env.DSH_ANKH_RESTART_DRIVER
  for (const key of Object.keys(env)) {
    if (key.startsWith('WD_')) delete env[key]
  }
  try {
    const { code, output } = await new Promise<{ code: number | null; output: string }>((resolvePromise, rejectPromise) => {
      let captured = ''
      const child = spawn(process.execPath, cliEntryArgs(argv), { stdio: ['ignore', 'pipe', 'pipe'], env })
      const append = (chunk: Buffer): void => { if (captured.length < DETAIL_CAP) captured += chunk.toString('utf8') }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      child.once('error', rejectPromise)
      child.once('exit', exitCode => { resolvePromise({ code: exitCode, output: captured }) })
    })
    const detail = output.trim()
    if (code === 0) return { accepted: true, via, detail }
    const verdict = readVerdict(verdictFile)
    return {
      accepted: false,
      stage: verdict?.stage ?? 'unknown',
      reason: verdict?.reason ?? detail.split('\n', 1)[0] ?? `guard CLI exited ${code ?? 'signal'}`,
      detail,
    }
  } finally {
    rmSync(verdictDir, { recursive: true, force: true })
  }
}
