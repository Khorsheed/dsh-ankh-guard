/**
 * Standalone composition-preflight dry-run for the self-restart guard.
 *
 * The fork's `dsh preflight` command (added to apps/cli in the pre-rc.7
 * deploy line) was wiped by the upstream reset and cannot be re-applied
 * without re-forking apps/cli on every release — which we cannot upstream
 * (no PR access). This runner replaces it WITHOUT touching the harness: it
 * resolves the official published packages (`@deepseek-ai/dsh-app-boot`,
 * `dsh-home-paths`, `dsh-launch-environment`, `dsh-cmdline`) from the LIVE
 * harness checkout's node_modules, so it always dry-runs the exact engine
 * the next boot will use and follows host updates automatically.
 *
 * What it verifies (same contract as the old patch):
 * - the profile's full patch stack composes (bundle layers from
 *   `dsh.profile.bundles`, the profile's user layer, the home-level
 *   `$DSH_HOME/cordis.patch.yml`, `--patch` overlays, the telemetry switch);
 * - the whole plugin tree boots — every apply runs, because apply is
 *   activation — with the webserver port pinned to 0 (OS-assigned) so the
 *   dry-run never collides with the live instance;
 * - every registered client bundle artifact exists on disk;
 * - dispose rolls every effect back.
 *
 * Exit codes (the contract the guard consumes):
 * - 0 — the composition boots and every registered client bundle artifact exists.
 * - 1 — a composition verdict: the tree a restart would boot is broken.
 * - 3 — preflight infrastructure failure (harness missing/unbuilt, spawn
 *   error, env load failure): NOT a verdict on the composition.
 *
 * Run directly (any profile) or via the guard CLI:
 *   node --import <harness>/node_modules/tsx/dist/esm/index.mjs \
 *     packages/ankh-guard/src/preflight-runner.ts --profile web [--patch FILE]...
 *
 * @module @khorsheed/dsh-ankh-guard/preflight-runner
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NAME = 'dsh'
const PROFILE_ROOT_FILENAME = 'cordis.yml'
const HOME_PATCH_FILENAME = 'cordis.patch.yml'
const TELEMETRY_ROW_ID = 'session-telemetry-otel'
const DSH_HARNESS_ENV = 'DSH_HARNESS'

/** The guarded (or tracking) harness checkout the live instance boots from. */
export function resolveHarnessRoot(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HARNESS_ENV]
  return fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), 'code/deepseek-harness')
}

/**
 * Monorepo layout: workspace packages live at packages/<category>/<name> and
 * are NOT linked at the harness root's node_modules (each package's own
 * node_modules holds the links). The layout is stable across releases.
 */
const HARNESS_PACKAGE_DIRS: Record<string, string> = {
  '@deepseek-ai/dsh-app-boot': 'packages/boot/app-boot',
  '@deepseek-ai/dsh-home-paths': 'packages/util/home-paths',
  '@deepseek-ai/dsh-launch-environment': 'packages/util/launch-environment',
  '@deepseek-ai/dsh-cmdline': 'packages/boot/cmdline',
}

/**
 * Whether this runtime can import TypeScript sources (the runner is launched
 * through tsx; a plain-node consumer of the published package cannot).
 */
function canImportTypeScript(): boolean {
  return process.execArgv.some(arg => arg.includes('tsx'))
}

/**
 * Dynamically import a harness package from the live checkout, SOURCE FIRST:
 * a source-launched prod instance (tsx … apps/cli/src/bin.ts) boots the
 * source, so the preflight engine must be the source too — a stale `lib/`
 * must never make the preflight greener than the real boot. The built entry
 * is the fallback for harnesses that ship only artifacts.
 *
 * The composition layers below (bundle layers, user layers, overlays, the
 * agent-presets roots, the telemetry switch) mirror the launcher's private
 * composeProfile — upstream does not export it, so this assembly is a
 * documented drift window; the `dsh dump-config` comparison test in
 * tests/preflight-drift.spec.ts is the tripwire that catches upstream
 * composition changes.
 * @param root - harness checkout root.
 * @param name - package name (a key of {@link HARNESS_PACKAGE_DIRS}).
 * @returns the imported module.
 */
async function loadHarnessPackage(root: string, name: string): Promise<Record<string, unknown>> {
  const relative = HARNESS_PACKAGE_DIRS[name]
  if (relative === undefined) throw new Error(`no known harness layout entry for ${name}`)
  const base = join(root, relative)
  const source = join(base, 'src', 'index.ts')
  if (canImportTypeScript() && existsSync(source)) {
    try {
      return await import(pathToFileURL(source).href) as Record<string, unknown>
    } catch (error) {
      // A broken source import (syntax error, unresolved workspace dep) is
      // EXACTLY what the next source boot would hit — surface it as a
      // composition verdict, never silently fall back to a stale build.
      throw new Error(`harness source ${source} failed to import (this is what a source boot would hit): ${String(error)}`, { cause: error })
    }
  }
  const manifest = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')) as { main?: string }
  const entry = manifest.main ?? 'lib/index.js'
  const module = await import(pathToFileURL(join(base, entry)).href)
  return module as Record<string, unknown>
}

/** Thrown for harness-side load failures — preflight infrastructure, never a composition verdict. */
class PreflightInfraError extends Error {}

/** The composed composition of one profile for a preflight (or a drift check). */
export interface PreflightComposition {
  /** The full patch stack in application order, BEFORE the port-0 overlay. */
  patches: unknown[]
  /** Composed rows by entry id. */
  rows: Map<string, { id?: unknown; config?: Record<string, unknown> }>
  /** The profile directory (the include root's anchor). */
  profileDir: string
}

/**
 * Compose one profile's full patch stack through the launcher's layering —
 * bundle layers in `dsh.profile.bundles` order, the profile user layer, the
 * home-level user layer, `--patch` overlays, the agent-presets roots overlay,
 * then the telemetry switch. Exported so the drift tripwire can compare this
 * assembly against the launcher's own dump without booting anything.
 * @param profile - the profile name (same resolution as `--profile`).
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @param root - harness checkout root.
 * @returns the patch stack and composed rows.
 */
export async function composePreflightPatches(
  profile: string,
  patchFiles: readonly string[],
  root: string,
): Promise<PreflightComposition> {
  let appBoot: Record<string, unknown>
  let homePaths: Record<string, unknown>
  try {
    appBoot = await loadHarnessPackage(root, '@deepseek-ai/dsh-app-boot')
    homePaths = await loadHarnessPackage(root, '@deepseek-ai/dsh-home-paths')
  } catch (error) {
    throw new PreflightInfraError(`harness packages unavailable under ${root}: ${String(error)}`, { cause: error })
  }
  const composeEntries = appBoot.composeEntries as (layers: readonly unknown[][], warn?: (msg: string) => void) => Array<{ id?: unknown; config?: Record<string, unknown> }>
  const healProfilesModuleFallback = appBoot.healProfilesModuleFallback as (anchor: string) => void
  const loadOptionalPatches = appBoot.loadOptionalPatches as (bin: string, file: string) => unknown[] | undefined
  const loadOverlayPatches = appBoot.loadOverlayPatches as (bin: string, file: string) => unknown[]
  const loadProfile = appBoot.loadProfile as (bin: string, name: string, anchor: string, home: string, opts: { userLayer?: boolean }) => {
    dir: string
    patches: unknown[]
    layers: Array<{ patches: unknown[] }>
  }
  const resolveDshHome = homePaths.resolveDshHome as (configured?: string) => string
  const anchor = fileURLToPath(new URL('../package.json', import.meta.url))
  const home = resolveDshHome()
  healProfilesModuleFallback(anchor)
  const composed = loadProfile(NAME, profile, anchor, home, { userLayer: true })
  const homePatches = loadOptionalPatches(NAME, join(home, HOME_PATCH_FILENAME)) ?? []
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = composed.layers.flatMap(layer => layer.patches)
  const patches = [...bundlePatches, ...composed.patches, ...homePatches, ...overlays]
  const rows = new Map<string, { id?: unknown; config?: Record<string, unknown> }>()
  for (const row of composeEntries([bundlePatches, composed.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const composedOverlays = [...overlays]
  if (rows.has('agent-presets')) {
    composedOverlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: join(root, 'apps/cli/config/agent-presets/'), trust: 'system' }],
      },
    })
  }
  const telemetryPatch = (process.env.DSH_TELEMETRY_DISABLED ?? '') !== '' && rows.has(TELEMETRY_ROW_ID)
    ? { id: TELEMETRY_ROW_ID, disabled: true }
    : undefined
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  patches.push(...composedOverlays)
  return { patches, rows, profileDir: composed.dir }
}

interface ClientArtifactRegistry {
  graph(): { entries: Array<{ id: string }> }
  clientPath(id: string): string | undefined
}

/** Stat every registered client bundle; report one line per missing/unreadable artifact. */
function missingClientArtifacts(ctx: unknown): string[] {
  const registry = (ctx as { get?: (key: string) => unknown }).get?.('clientModules') as ClientArtifactRegistry | undefined
  if (registry === undefined) return []
  const missing: string[] = []
  for (const entry of registry.graph().entries) {
    const path = registry.clientPath(entry.id)
    if (path === undefined) {
      missing.push(`${entry.id}: registered without a resolved client bundle path`)
      continue
    }
    try {
      statSync(path)
    } catch {
      missing.push(`${entry.id}: ${path}`)
    }
  }
  return missing
}

/**
 * Boot the profile's full tree once, tear it down, and report the verdict on
 * the process streams. No HMR, no user-patch watchers, no signal wiring —
 * preflight is one-shot.
 * @param profile - the profile name (same resolution as `--profile`).
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @param root - harness checkout root (default: DSH_HARNESS or ~/code/deepseek-harness).
 * @returns the process exit code (see the module contract).
 */
export async function runPreflight(
  profile: string,
  patchFiles: readonly string[] = [],
  root: string = resolveHarnessRoot(),
): Promise<number> {
  // Environment loading sits outside the composition pipeline; a failure here
  // is preflight infrastructure, not a verdict on the tree.
  let appBoot: Record<string, unknown>
  let launchEnvironment: Record<string, unknown>
  let cmdline: Record<string, unknown>
  try {
    appBoot = await loadHarnessPackage(root, '@deepseek-ai/dsh-app-boot')
    launchEnvironment = await loadHarnessPackage(root, '@deepseek-ai/dsh-launch-environment')
    cmdline = await loadHarnessPackage(root, '@deepseek-ai/dsh-cmdline')
  } catch (error) {
    process.stderr.write(`preflight could not execute (harness packages unavailable under ${root}): ${
      error instanceof Error ? error.message : String(error)}\n`)
    return 3
  }
  const boot = appBoot.boot as (bin: string, config: string, patches?: unknown[], prepare?: (ctx: { provide?: (key: string, value: unknown) => void }) => void | Promise<void>) => Promise<{ fiber: { dispose(): Promise<unknown> } }>
  const loadLayeredEnv = appBoot.loadLayeredEnv as (bin: string) => unknown
  const launchEnvironmentKey = launchEnvironment.DSH_LAUNCH_ENVIRONMENT_KEY as string
  const provideCmdline = cmdline.provideCmdline as (ctx: unknown, options: { args: readonly string[]; exit: () => void }) => void

  let environment: unknown
  try {
    environment = loadLayeredEnv(NAME)
  } catch (error) {
    process.stderr.write(`preflight could not execute (infrastructure failure, not a composition verdict): ${
      error instanceof Error ? error.message : String(error)}\n`)
    return 3
  }
  try {
    const composed = await composePreflightPatches(profile, patchFiles, root)
    const patches = [...composed.patches]
    const rows = composed.rows

    // Never collide with the live instance on its configured port: 0 asks the
    // OS for a free one. A patch's config REPLACES the row's config, so merge
    // over the composed row first. Non-web compositions carry no webserver row.
    const webserver = rows.get('webserver')
    if (webserver !== undefined) {
      patches.push({
        id: 'webserver',
        config: { ...(webserver.config ?? {}) as Record<string, unknown>, port: 0 },
      })
    }

    const rootConfig = join(composed.profileDir, PROFILE_ROOT_FILENAME)
    // Cloned for the same insert-aliasing reason the launcher documents: boot
    // application mutates rows by reference.
    const ctx = await boot(NAME, rootConfig, structuredClone(patches), (hostCtx) => {
      hostCtx.provide?.(launchEnvironmentKey, environment)
      provideCmdline(hostCtx, { args: [], exit: () => {} })
    })
    const missing = missingClientArtifacts(ctx)
    // A repeated dispose returns the settled single-shot result when boot
    // already tore the tree down, so this is safe on every path.
    await ctx.fiber.dispose()
    if (missing.length > 0) {
      process.stderr.write(`preflight FAIL: profile ${JSON.stringify(profile)} boots but client bundle artifacts are missing or unreadable:\n${
        missing.map(line => `  - ${line}`).join('\n')}\nrun \`pnpm run build\` before launch\n`)
      return 1
    }
    process.stdout.write(`preflight PASS: profile ${JSON.stringify(profile)} boots clean\n`)
    return 0
  } catch (error) {
    if (error instanceof PreflightInfraError) {
      process.stderr.write(`preflight could not execute (${error.message})\n`)
      return 3
    }
    // boot() already disposed the partial tree and labelled the failure stage;
    // print the whole chain so the guard's diagnostics name the broken layer.
    process.stderr.write(`preflight FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return 1
  }
}

/** Minimal argv parse for `--profile NAME` and repeatable `--patch FILE`. */
export function parsePreflightArgs(argv: readonly string[]): { profile: string; patchFiles: string[]; error?: string } {
  const patchFiles: string[] = []
  let profile = ''
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') {
      profile = argv[++i] ?? ''
    } else if (arg === '--patch') {
      const file = argv[++i]
      if (file !== undefined) patchFiles.push(file)
    } else if (arg === '--help' || arg === '-h') {
      return { profile: '', patchFiles: [], error: 'usage: preflight-runner --profile <name> [--patch FILE]...' }
    }
  }
  if (profile === '') return { profile: '', patchFiles: [], error: 'preflight requires --profile <name>' }
  return { profile, patchFiles }
}

// Standalone entry: only when executed directly (not imported by the CLI).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { profile, patchFiles, error } = parsePreflightArgs(process.argv.slice(2))
  if (error !== undefined) {
    process.stderr.write(`${error}\n`)
    process.exit(2)
  }
  process.exitCode = await runPreflight(profile, patchFiles)
}
