/**
 * Standalone composition-preflight dry-run for the self-restart guard.
 *
 * The fork's `dsh preflight` command (added to apps/cli in the pre-rc.7
 * deploy line) was wiped by the upstream reset and cannot be re-applied
 * without re-forking apps/cli on every release — which we cannot upstream
 * (no PR access). This runner replaces it WITHOUT touching the harness: it
 * resolves the official packages (`@deepseek-ai/dsh-app-boot`,
 * `dsh-home-paths`, `dsh-launch-environment`, `dsh-cmdline`) from an explicit
 * execution binding: source files in the host checkout for a source launch,
 * or the npm toolchain selected by a built launch's dsh package.json. It never
 * infers that choice from Node's execArgv.
 *
 * What it verifies (same contract as the old patch):
 * - the profile's full patch stack composes (bundle layers from
 *   `dsh.profile.bundles`, the profile's user layer, the home-level
 *   `$DSH_HOME/cordis.patch.yml`, `--patch` overlays, the telemetry switch);
 * - the whole plugin tree boots — every apply runs, because apply is
 *   activation — with the webserver port pinned to 0 (OS-assigned) so the
 *   dry-run never collides with the live instance;
 * - every registered client bundle artifact exists on disk;
 * - every registered agent preset is USABLE, not merely loaded: preset rows
 *   mount on the registry's standing scopes beside the profile tree, so a row
 *   whose module stopped resolving (a folded companion's retired package name,
 *   a base version predating its ./tool entry) never fails the boot itself —
 *   it fails every SESSION of that preset later (the picker shows 加载失败,
 *   resume answers "never started"; 3080, 2026-09-28). The audit reads the
 *   preset registry's own `broken` diagnostic back from the dry-run boot;
 * - dispose rolls every effect back.
 *
 * Exit codes (the contract the guard consumes):
 * - 0 — the composition boots and every registered client bundle artifact exists.
 * - 1 — a composition verdict: the tree a restart would boot is broken.
 * - 3 — preflight infrastructure failure (harness missing/unbuilt, spawn
 *   error, env load failure): NOT a verdict on the composition.
 *
 * Run directly (any profile) or via the guard CLI:
 *   node packages/ankh-guard/lib/preflight-runner.js --profile web \
 *     --host-surface built --install-anchor <toolchain>/node_modules/@deepseek-ai/dsh/package.json
 *
 * @module @khorsheed/dsh-ankh-guard/preflight-runner
 */

import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDirectInvocation } from './defaults.ts'

const NAME = 'dsh'
const PROFILE_ROOT_FILENAME = 'cordis.yml'
const HOME_PATCH_FILENAME = 'cordis.patch.yml'
const TELEMETRY_ROW_ID = 'session-telemetry-otel'
const DSH_HARNESS_ENV = 'DSH_HARNESS'

export type PreflightHostSurface = 'source' | 'built'

export interface PreflightHostBinding {
  surface: PreflightHostSurface
  /** Real dsh package.json used by the successor's module graph. */
  installAnchor: string
}

/**
 * The empty root entry list every profile tree patches over — the exact
 * bytes the launcher's prepareProfile rewrites on every boot (the vendored
 * Loader's tree write-back can bake composed rows into this file, so both
 * the launcher and this dry-run always start from the empty root).
 */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

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
 * The module-fallback heal, whose calling convention is the sharpest
 * composition-layering difference between the supported host lines:
 * - rc line (through 0.1.1-rc.*): positional, sync, and runs BEFORE the
 *   profile load (the launcher's prepareProfile heals, then loads);
 * - 0.1.2 line (through 0.1.5): an async options object that also links
 *   bundle-carried packages into the profile, so it runs AFTER the profile
 *   load;
 * - 0.1.6 line: same options object, but the launcher compose calls it only
 *   in the opt-in link/dual resolution modes — the default runtime mode
 *   computes the generation through {@link CreateProfileResolutionGeneration}
 *   instead (apps/cli composeProfile).
 */
type HealProfilesModuleFallback = {
  (installAnchor: string, home?: string): void
  (options: { installAnchor: string; profile?: unknown; home?: string }): Promise<void>
}

/**
 * The 0.1.6 line's compose-time replacement for the heal: compute the
 * profile's package-resolution generation without materializing fallback
 * links (`healProfilesModuleFallback` with `materialize: false`); the boot
 * mounts the generation in-process (PluginPackages), so runtime mode never
 * writes `profiles/node_modules`.
 */
type CreateProfileResolutionGeneration = (
  options: { installAnchor: string; profile?: unknown; home?: string },
) => Promise<unknown>

/**
 * Dynamically import one host package from the explicitly selected surface.
 * A source launch uses checkout source and fails rather than falling back to
 * stale lib; a built launch resolves only through its npm install anchor.
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
async function loadHarnessPackage(
  root: string,
  name: string,
  binding: PreflightHostBinding,
): Promise<Record<string, unknown>> {
  if (binding.surface === 'built') {
    let entry: string
    try {
      entry = createRequire(binding.installAnchor).resolve(name)
    } catch (error) {
      throw new Error(`built host package ${name} is not resolvable from ${binding.installAnchor}: ${String(error)}`, { cause: error })
    }
    return await import(pathToFileURL(entry).href) as Record<string, unknown>
  }
  const relative = HARNESS_PACKAGE_DIRS[name]
  if (relative === undefined) throw new Error(`no known harness layout entry for ${name}`)
  const base = join(root, relative)
  const source = join(base, 'src', 'index.ts')
  if (!existsSync(source)) {
    throw new Error(`harness source entry does not exist: ${source}`)
  }
  try {
    return await import(pathToFileURL(source).href) as Record<string, unknown>
  } catch (error) {
    // A broken source import (syntax error, unresolved workspace dep) is
    // EXACTLY what the next source boot would hit — surface it as a
    // composition verdict, never silently fall back to a stale build.
    throw new Error(`harness source ${source} failed to import (this is what a source boot would hit): ${String(error)}`, { cause: error })
  }
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
  /**
   * The launcher-owned profileContext service value (0.1.6+ lines), built
   * field-for-field as runProfile builds it. Undefined on the heal-based
   * lines, whose launcher provides no such service. The boot prepare must
   * provide it before the tree mounts: the 0.1.7 settings service injects
   * profileContext, so without it every settings-dependent apply never runs.
   */
  profileContext?: Record<string, unknown>
  /**
   * The PluginPackages mount config the boot prepare must apply, mirroring
   * the launcher: `{ generation }` on the 0.1.6 line, `{ resolution }` on the
   * 0.1.7 line. Undefined on the heal-based lines (rc, 0.1.2), where the heal
   * materializes real fallback links and native Node resolution carries the
   * tree — the launcher mounts no PluginPackages there either. Without this
   * mount the in-memory resolution is computed and discarded, so on a tarball
   * profile (whose own node_modules holds no `@deepseek-ai/*` entries) every
   * entry import fails natively while the real boot of the same profile is
   * clean.
   */
  pluginPackagesConfig?: Record<string, unknown>
}

/**
 * Compose one profile's full patch stack through the launcher's layering —
 * bundle layers in `dsh.profile.bundles` order, the profile user layer, the
 * home-level user layer, `--patch` overlays, the agent-presets roots overlay
 * (rc host line only; the 0.1.2 line's preset package self-ships its root),
 * then the telemetry switch. Three host API generations are mirrored and
 * feature-detected per run — see the `hostLine` branch below. Exported so
 * the drift tripwire can compare this assembly against the launcher's own
 * dump without booting anything.
 * @param profile - the profile name (same resolution as `--profile`).
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @param root - harness checkout root.
 * @param home - the dsh home to compose against; defaults to the harness's
 * own resolution ($DSH_HOME → ~/.dsh). Explicit because a caller verifying a
 * specific deployment must not silently compose a different home's tree.
 * @returns the patch stack and composed rows.
 */
export async function composePreflightPatches(
  profile: string,
  patchFiles: readonly string[],
  root: string,
  home?: string,
  binding: PreflightHostBinding = {
    surface: 'source',
    installAnchor: join(root, 'apps', 'cli', 'package.json'),
  },
): Promise<PreflightComposition> {
  let appBoot: Record<string, unknown>
  let homePaths: Record<string, unknown>
  try {
    appBoot = await loadHarnessPackage(root, '@deepseek-ai/dsh-app-boot', binding)
    homePaths = await loadHarnessPackage(root, '@deepseek-ai/dsh-home-paths', binding)
  } catch (error) {
    throw new PreflightInfraError(`harness packages unavailable under ${root}: ${String(error)}`, { cause: error })
  }
  const composeEntries = appBoot.composeEntries as (layers: readonly unknown[][], warn?: (msg: string) => void) => Array<{ id?: unknown; config?: Record<string, unknown> }>
  const healProfilesModuleFallback = appBoot.healProfilesModuleFallback as HealProfilesModuleFallback
  const createProfileResolutionGeneration = appBoot.createProfileResolutionGeneration as CreateProfileResolutionGeneration
  const createRuntimeResolution = appBoot.createRuntimeResolution as ((options: { installAnchor: string; profile: unknown }) => Promise<unknown>) | undefined
  const loadOptionalPatches = appBoot.loadOptionalPatches as (bin: string, file: string) => unknown[] | undefined
  const loadOverlayPatches = appBoot.loadOverlayPatches as (bin: string, file: string) => unknown[]
  const loadProfile = appBoot.loadProfile as (bin: string, name: string, anchor: string, home: string, opts: { userLayer?: boolean }) => {
    dir: string
    patchPath: string
    patches: unknown[]
    layers: Array<{ packageName: string; patches: unknown[] }>
  }
  const resolveDshHome = homePaths.resolveDshHome as (configured?: string) => string
  // The heal/load anchor mirrors the real launcher's INSTALL_ANCHOR (the dsh
  // app's own manifest) — never this runner's package: an installed runner's
  // dependency closure resolves through the profile fallback itself, and
  // healing then re-points fallback links into self-referential loops
  // (observed on a second preflight from the installed CLI: ~20 links looped,
  // the next real boot would have failed).
  const anchor = binding.installAnchor
  const resolvedHome = resolveDshHome(home)
  // Which app-boot API generation this host speaks. The 0.1.2 line re-layered
  // the profile composition: the heal moved behind the async options API and
  // below the profile load (see HealProfilesModuleFallback), and the launcher
  // dropped its agent-presets shipped-root overlay because the preset package
  // now self-ships its root. The 0.1.6 line flipped the default resolution
  // mode from link to runtime: its compose computes an immutable resolution
  // generation instead of materializing fallback links, and it removed
  // DEFAULT_PROFILE_PATCH_RELOAD — the 0.1.2 line's marker. The 0.1.7 line
  // deleted the fallback projections outright (in-memory runtime resolution
  // interception): its compose calls createRuntimeResolution and carries
  // neither older marker, so the markers must be probed newest-first. Each
  // marker is a value export only its line carries; a version parse would
  // break on exactly the unreleased builds this runner must dry-run. All
  // lines stay supported: prod hosts run 0.1.5 until the next npm line lands.
  const hostLine: 'rc' | '0.1.2' | '0.1.6' | '0.1.7' = 'createRuntimeResolution' in appBoot
    ? '0.1.7'
    : 'createProfileResolutionGeneration' in appBoot
      ? '0.1.6'
      : 'DEFAULT_PROFILE_PATCH_RELOAD' in appBoot ? '0.1.2' : 'rc'
  if (hostLine === 'rc') healProfilesModuleFallback(anchor, resolvedHome)
  const composed = loadProfile(NAME, profile, anchor, resolvedHome, { userLayer: true })
  // Mirror prepareProfile: rewrite the empty root config the tree patches
  // over. The Loader needs the real file to anchor the include, and on a
  // fresh home (the launcher never booted it) the file does not exist yet —
  // the dry-run would otherwise fail on exactly the tree a first boot
  // composes fine.
  writeFileSync(join(composed.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  let pluginPackagesConfig: Record<string, unknown> | undefined
  if (hostLine === '0.1.2') {
    await healProfilesModuleFallback({ installAnchor: anchor, profile: composed, home: resolvedHome })
  } else if (hostLine === '0.1.6') {
    // The launcher compose's runtime-mode step (apps/cli composeProfile):
    // compute the generation AFTER the profile load and root-config rewrite,
    // materializing nothing. Awaited, so a resolution-graph failure rejects
    // the compose instead of escaping as an unhandled rejection. The explicit
    // home keeps the recorded profilesDir on the deployment under check. The
    // generation is kept: the launcher hands it to the boot's PluginPackages
    // mount (`{ generation }`), and so must the dry-run — computing it and
    // dropping it leaves profile-tree imports to native Node resolution,
    // which finds nothing in a tarball profile's node_modules.
    const generation = await createProfileResolutionGeneration({ installAnchor: anchor, profile: composed, home: resolvedHome })
    pluginPackagesConfig = { generation }
  } else if (hostLine === '0.1.7') {
    // The 0.1.7 launcher compose (apps/cli composeProfile): the resolution is
    // computed in memory right after the profile load and root-config rewrite
    // — the older lines' fallback projections are gone for good, so this
    // interception is the ONLY way profile-tree imports resolve. Awaited, so
    // a resolution-graph failure rejects the compose instead of escaping as
    // an unhandled rejection. The resolution is kept for the boot's
    // PluginPackages mount (`{ resolution }`), exactly as the launcher's
    // runProfile hands it over; discarding it is the tarball-profile false
    // FAIL (every official entry reports "failed to import" on a profile
    // whose real boot is clean).
    const resolution = await createRuntimeResolution!({ installAnchor: anchor, profile: composed })
    pluginPackagesConfig = { resolution }
  }
  const homePatches = loadOptionalPatches(NAME, join(resolvedHome, HOME_PATCH_FILENAME)) ?? []
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  // The launcher provides a data-only profileContext service before the tree
  // mounts (since 0.1.6-alpha.2; the heal-based lines had no such service).
  // The 0.1.7 settings service injects it, so a dry-run without it leaves
  // `settings` — and everything injecting it — pending: applies the contract
  // promises to exercise never run, on a profile the real boot runs clean.
  const profileContext = hostLine === '0.1.6' || hostLine === '0.1.7'
    ? {
      name: profile,
      dir: composed.dir,
      patchPath: composed.patchPath,
      installAnchor: anchor,
      startedBundles: composed.layers.map(layer => layer.packageName),
      cwd: process.cwd(),
      home: resolvedHome,
      overlays,
      telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    : undefined
  const bundlePatches = composed.layers.flatMap(layer => layer.patches)
  const patches = [...bundlePatches, ...composed.patches, ...homePatches, ...overlays]
  const rows = new Map<string, { id?: unknown; config?: Record<string, unknown> }>()
  for (const row of composeEntries([bundlePatches, composed.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const composedOverlays = [...overlays]
  // The launcher's shipped preset root exists only on the rc line — the
  // 0.1.2 line removed apps/cli/config/agent-presets and lets the preset
  // package self-ship its root, so the overlay follows the directory, not
  // the host line.
  const shippedPresetRoot = binding.surface === 'built'
    ? join(dirname(binding.installAnchor), 'config', 'agent-presets')
    : join(root, 'apps', 'cli', 'config', 'agent-presets')
  if (rows.has('agent-presets') && existsSync(shippedPresetRoot)) {
    composedOverlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: shippedPresetRoot, trust: 'system' }],
      },
    })
  }
  if (rows.has('web-runtime')) {
    // A dry-run must not have user-visible side effects: the real apply of
    // the web-app row opens a browser tab on every preflight (openBrowser
    // defaults true). Suppress it for the dry-run; the port stays 0 either
    // way.
    composedOverlays.push({
      id: 'web-runtime',
      config: {
        ...(rows.get('web-runtime')?.config ?? {}) as Record<string, unknown>,
        openBrowser: false,
      },
    })
  }
  if (profileContext !== undefined && rows.has('hmr')) {
    // Providing profileContext satisfies the hmr row's disable expression
    // (`!ctx.get('profileContext')`) on the runtime-resolution lines. A
    // dry-run is one-shot — no HMR, no user-patch watchers: the boot's own
    // tree write-back would queue a config refresh on hmr's operations queue,
    // and dispose then awaits a queue that never drains (observed: preflight
    // hung past boot and the process exited 13 on an unsettled await).
    composedOverlays.push({ id: 'hmr', disabled: true })
  }
  if (rows.has('ankh-guard')) {
    // The guard plugin writes state at apply (the instance-launch record,
    // snapshots). A dry-run is NOT the real instance — isolate its state to a
    // throwaway dir so a preflight can never poison the deployment's records
    // (observed: a dry-run wrote instance-launch.json naming the preflight
    // runner itself as the launch command; a restart falling back to that
    // record would have spawned a preflight process instead of the instance).
    composedOverlays.push({
      id: 'ankh-guard',
      config: {
        ...(rows.get('ankh-guard')?.config ?? {}) as Record<string, unknown>,
        stateDir: mkdtempSync(join(tmpdir(), 'ankh-guard-dry-run-')),
      },
    })
  }
  const telemetryPatch = (process.env.DSH_TELEMETRY_DISABLED ?? '') !== '' && rows.has(TELEMETRY_ROW_ID)
    ? { id: TELEMETRY_ROW_ID, disabled: true }
    : undefined
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  patches.push(...composedOverlays)
  return {
    patches,
    rows,
    profileDir: composed.dir,
    ...(profileContext === undefined ? {} : { profileContext }),
    ...(pluginPackagesConfig === undefined ? {} : { pluginPackagesConfig }),
  }
}

interface ClientArtifactRegistry {
  graph(): { entries: Array<{ id: string }> }
  clientPath(id: string): string | undefined
}

/** The launcher's readiness service shape (0.1.2's `AppReady` in dsh-cmdline). */
interface AppReady {
  onReady(listener: () => void): () => void
}

/**
 * The launcher's readiness signal, mirrored: 0.1.2's runProfile provides an
 * `appReady` service through provideCmdline and commits it once boot and host
 * setup settle. The rc line's provideCmdline ignores the field, so one
 * implementation serves both host lines.
 */
function createAppReadyStub(): { service: AppReady; commit(): void } {
  let committed = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (committed) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (committed) return
      committed = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
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

/** The registry roster row, read structurally — only the audit's two fields. */
interface AgentPresetAuditRow {
  id?: unknown
  broken?: unknown
}

/**
 * The preset-roster half of the verdict. A profile can boot clean while one
 * of its agent presets is BROKEN: preset rows mount on the registry's
 * standing scopes, not on the profile root the dry-run boots, so a row whose
 * module stopped resolving never fails the boot — it surfaces later as the
 * preset picker's 加载失败 badge and `resume failed … never started` on every
 * session of that preset (3080, 2026-09-28: the dev preset named
 * `@khorsheed/dsh-worktrees/tool` while the installed worktrees predated the
 * entry). The registry already computes this verdict: it activates every
 * registered preset eagerly and records a mount failure as `broken`, and its
 * `list()` re-audits mounted trees after the loader settles, so rows still
 * waiting on a host service report their pending reason instead of passing
 * silently. Fail the dry-run on any broken preset — the restart this gate
 * protects would serve those broken sessions. A host whose registry face is
 * absent or list-less degrades to no findings: the audit never invents one.
 */
export async function brokenAgentPresets(ctx: unknown): Promise<Array<{ id: string; broken: string }>> {
  const registry = (ctx as { get?: (key: string) => unknown }).get?.('agentPresets') as { list?: unknown } | undefined
  if (registry === undefined || typeof registry.list !== 'function') return []
  const rows = await (registry.list as () => Promise<AgentPresetAuditRow[]>)()
  return rows.flatMap(row =>
    row !== null && typeof row === 'object' && typeof row.id === 'string' && typeof row.broken === 'string'
      ? [{ id: row.id, broken: row.broken }]
      : [])
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
  binding: PreflightHostBinding = {
    surface: 'source',
    installAnchor: join(root, 'apps', 'cli', 'package.json'),
  },
): Promise<number> {
  // Environment loading sits outside the composition pipeline; a failure here
  // is preflight infrastructure, not a verdict on the tree.
  let appBoot: Record<string, unknown>
  let launchEnvironment: Record<string, unknown>
  let cmdline: Record<string, unknown>
  try {
    appBoot = await loadHarnessPackage(root, '@deepseek-ai/dsh-app-boot', binding)
    launchEnvironment = await loadHarnessPackage(root, '@deepseek-ai/dsh-launch-environment', binding)
    cmdline = await loadHarnessPackage(root, '@deepseek-ai/dsh-cmdline', binding)
  } catch (error) {
    process.stderr.write(`preflight could not execute (harness packages unavailable under ${root}): ${
      error instanceof Error ? error.message : String(error)}\n`)
    return 3
  }
  const boot = appBoot.boot as (bin: string, config: string, patches?: unknown[], prepare?: (ctx: { provide?: (key: string, value: unknown) => void; plugin?: (service: unknown, config?: unknown) => Promise<void> }) => void | Promise<void>) => Promise<{ fiber: { dispose(): Promise<unknown> } }>
  const loadLayeredEnv = appBoot.loadLayeredEnv as (bin: string) => unknown
  const launchEnvironmentKey = launchEnvironment.DSH_LAUNCH_ENVIRONMENT_KEY as string
  const provideCmdline = cmdline.provideCmdline as (ctx: unknown, options: { args: readonly string[]; exit: () => void; ready?: AppReady }) => void
  const PluginPackages = appBoot.PluginPackages as ((ctx: unknown, config: Record<string, unknown>) => unknown) | undefined

  let environment: unknown
  try {
    environment = loadLayeredEnv(NAME)
  } catch (error) {
    process.stderr.write(`preflight could not execute (infrastructure failure, not a composition verdict): ${
      error instanceof Error ? error.message : String(error)}\n`)
    return 3
  }
  try {
    const composed = await composePreflightPatches(profile, patchFiles, root, undefined, binding)
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
    const appReady = createAppReadyStub()
    // Cloned for the same insert-aliasing reason the launcher documents: boot
    // application mutates rows by reference.
    const ctx = await boot(NAME, rootConfig, structuredClone(patches), async (hostCtx) => {
      // Mirror runProfile's prepare order: profileContext, launch environment,
      // PluginPackages, cmdline — all before boot() mounts the root include.
      if (composed.profileContext !== undefined) hostCtx.provide?.('profileContext', composed.profileContext)
      hostCtx.provide?.(launchEnvironmentKey, environment)
      // On the runtime-resolution lines the composed resolution/generation
      // must be mounted in-process through PluginPackages BEFORE the config
      // tree mounts — boot() awaits prepare before the root include, so every
      // entry import resolves through the interception. Skipping the mount is
      // not a neutral shortcut: without it Node resolves profile-tree imports
      // natively, a tarball profile's node_modules holds no official packages,
      // and the dry-run reports a wall of "failed to import" on a tree the
      // real launcher boots clean.
      if (composed.pluginPackagesConfig !== undefined) {
        if (PluginPackages === undefined || hostCtx.plugin === undefined) {
          throw new Error('host line requires a PluginPackages mount but the loaded app-boot does not export PluginPackages')
        }
        await hostCtx.plugin(PluginPackages, composed.pluginPackagesConfig)
      }
      provideCmdline(hostCtx, { args: [], exit: () => {}, ready: appReady.service })
    })
    // The launcher commits readiness once boot and host setup settle; a
    // dry-run's host setup is the no-op cmdline above, so boot settling is
    // that point.
    appReady.commit()
    const missing = missingClientArtifacts(ctx)
    // The registry settles pending rows against the finished loader tree, so
    // the audit runs after boot completion and before dispose.
    const brokenPresets = await brokenAgentPresets(ctx)
    // A repeated dispose returns the settled single-shot result when boot
    // already tore the tree down, so this is safe on every path.
    await ctx.fiber.dispose()
    if (missing.length > 0 || brokenPresets.length > 0) {
      if (missing.length > 0) {
        process.stderr.write(`preflight FAIL: profile ${JSON.stringify(profile)} boots but client bundle artifacts are missing or unreadable:\n${
          missing.map(line => `  - ${line}`).join('\n')}\nrun \`pnpm run build\` before launch\n`)
      }
      if (brokenPresets.length > 0) {
        process.stderr.write(`preflight FAIL: profile ${JSON.stringify(profile)} boots but ${brokenPresets.length} agent preset(s) are broken — every session on them fails to resume (the preset picker shows 加载失败):\n${
          brokenPresets.map(preset => `  - ${preset.id}: ${preset.broken.split('\n').join('\n    ')}`).join('\n')}\n`
          + 'fix the named row (install the package it names, repoint a folded companion row to the core package\'s ./tool entry, or disable the row) or remove the preset, then re-run preflight\n')
      }
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

/** Minimal argv parse; the host execution surface is mandatory and explicit. */
export function parsePreflightArgs(argv: readonly string[]): {
  profile: string
  patchFiles: string[]
  binding?: PreflightHostBinding
  error?: string
} {
  const patchFiles: string[] = []
  let profile = ''
  let surface = ''
  let installAnchor = ''
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') {
      profile = argv[++i] ?? ''
    } else if (arg === '--patch') {
      const file = argv[++i]
      if (file !== undefined) patchFiles.push(file)
    } else if (arg === '--host-surface') {
      surface = argv[++i] ?? ''
    } else if (arg === '--install-anchor') {
      installAnchor = argv[++i] ?? ''
    } else if (arg === '--help' || arg === '-h') {
      return { profile: '', patchFiles: [], error: 'usage: preflight-runner --profile <name> --host-surface source|built --install-anchor FILE [--patch FILE]...' }
    }
  }
  if (profile === '') return { profile: '', patchFiles: [], error: 'preflight requires --profile <name>' }
  if (surface !== 'source' && surface !== 'built') {
    return { profile, patchFiles, error: 'preflight requires --host-surface source|built' }
  }
  if (installAnchor === '') return { profile, patchFiles, error: 'preflight requires --install-anchor FILE' }
  return { profile, patchFiles, binding: { surface, installAnchor } }
}

// Standalone entry: only when executed directly (not imported by the CLI).
if (isDirectInvocation(import.meta.url)) {
  const { profile, patchFiles, binding, error } = parsePreflightArgs(process.argv.slice(2))
  if (error !== undefined || binding === undefined) {
    process.stderr.write(`${error}\n`)
    process.exit(2)
  }
  process.exitCode = await runPreflight(profile, patchFiles, resolveHarnessRoot(), binding)
}
