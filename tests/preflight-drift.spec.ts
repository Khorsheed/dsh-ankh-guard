/**
 * Drift tripwire for the preflight runner's hand-assembled composition. The
 * launcher keeps its composition private (apps/cli composeProfile is not
 * exported upstream), so the runner mirrors its layering by hand. This spec
 * compares the runner's composed entry ids against the launcher's own
 * `dsh --dump-config` output for the same profile — when upstream changes the
 * composition, this test fails before a restart would.
 *
 * Runs only where a harness checkout and the target profile both exist (CI
 * clones the harness and sets DSH_HARNESS/DSH_HOME per the repo AGENTS.md).
 * The home defaults to the conventional ~/.dsh so the tripwire still fires on
 * a deployment machine where DSH_HOME is simply not exported into the test
 * process — a sentinel that skips everywhere is no sentinel.
 */
import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { rm } from 'node:fs/promises'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composePreflightPatches, resolveHarnessRoot, runPreflight } from '../src/preflight-runner.ts'
import { driftBuiltCliAvailable, driftTripwireRunnable } from './preflight-environment.mjs'

const exec = promisify(execFile)
async function run(executable: string, args: string[], options: ExecFileOptions) {
  try {
    const result = await exec(executable, args, { ...options, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
    return { ...result, status: 0, error: undefined }
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string; code?: number }
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.code, error: result }
  }
}

// Snapshotting the real dependency graph is deliberately synchronous product
// code. Exercise the freshly built implementation off Vitest's RPC event loop.
async function snapshotOffThread(home: string): Promise<{ home: string; root: string }> {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ createPreflightSnapshot }) => {
      const snapshot = createPreflightSnapshot(workerData.home);
      parentPort.postMessage({ home: snapshot.home, root: snapshot.root });
    });
  `, { eval: true, workerData: { home, module: new URL('../lib/types/transition.js', import.meta.url).href } })
  return new Promise((resolve, reject) => {
    let result: { home: string; root: string } | undefined
    let failure: Error | undefined
    const deadline = setTimeout(() => {
      failure = new Error('snapshot worker exceeded 90 seconds')
      void worker.terminate()
    }, 90_000)
    worker.once('message', value => { result = value })
    worker.once('error', error => { failure = error })
    worker.once('exit', code => {
      clearTimeout(deadline)
      if (failure || code !== 0 || !result) reject(failure ?? new Error(`snapshot worker exited ${code} without a result`))
      else resolve(result)
    })
  })
}

const harness = resolveHarnessRoot()
// Probe the home the guard actually protects in deployment: the same chain
// the supervisor installers use (DSH_WD_HOME → DSH_HOME → ~/.dsh-official),
// falling back to the conventional ~/.dsh of a plain npm-line machine. The
// composition differs wildly between homes, and a tripwire that validates a
// tree nobody runs is a blank round — the resolved home goes into the test
// name so a green line says WHICH tree it validated.
// The two gate predicates live in ./preflight-environment.mjs, shared with
// the lane runner's expected-passing inventory — they must never drift apart.
const home = [process.env.DSH_WD_HOME, process.env.DSH_HOME]
  .find(value => value !== undefined && value !== '')
  ?? (existsSync(join(homedir(), '.dsh-official')) ? join(homedir(), '.dsh-official') : join(homedir(), '.dsh'))
const profile = process.env.DSH_PREFLIGHT_PROFILE ?? 'web'
const tsx = join(harness, 'node_modules/tsx/dist/esm/index.mjs')
const dshCli = join(harness, 'apps/cli/src/bin.ts')
const builtDshCli = [
  process.env.DSH_BUILT_CLI,
  join(homedir(), '.dsh-toolchains', 'stable', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  join(homedir(), '.dsh-toolchains', 'rc-0.1.2-rc.1', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
].find(path => path !== undefined && existsSync(path))

describe('preflight composition drift tripwire', () => {
  it('refuses a missing source entry instead of importing a stale built fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ankh-source-preflight-'))
    const packageRoot = join(root, 'packages', 'boot', 'app-boot')
    const fixtureHome = join(root, 'home')
    try {
      mkdirSync(join(packageRoot, 'lib'), { recursive: true })
      mkdirSync(fixtureHome)
      writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
        name: '@deepseek-ai/dsh-app-boot',
        type: 'module',
        main: 'lib/index.js',
      }, null, 2)}\n`)
      writeFileSync(join(packageRoot, 'lib', 'index.js'), "throw new Error('stale built fallback executed')\n")

      await expect(composePreflightPatches('web', [], root, fixtureHome, {
        surface: 'source',
        installAnchor: join(root, 'apps', 'cli', 'package.json'),
      })).rejects.toThrow(/harness source entry does not exist/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  const test = driftTripwireRunnable() ? it : it.skip
  test(`the runner composes the same entry ids as the launcher dump-config (home ${home})`, async () => {
    // cwd matters: the dump must resolve the harness's workspace packages,
    // not this repo's published ones (a foreign @deepseek-ai/cordis lacks
    // exports the harness source imports). env matters just as much: both
    // sides must compose the SAME home's tree — a green run against the wrong
    // home is a blank round with a confident title.
    const dump = await run(process.execPath, ['--import', tsx, join(harness, 'apps/cli/src/bin.ts'), '--profile', profile, '--dump-config'], { cwd: harness, env: { ...process.env, DSH_HOME: home } })
    expect(dump.error).toBeUndefined()
    expect(dump.status).toBe(0)
    const dumpIds = new Set([...dump.stdout.matchAll(/^- id: (\S+)/gm)].map(match => match[1]))
    const { rows, patches, profileDir } = await composePreflightPatches(profile, [], harness, home)
    // Pin the target: the composition must actually have read this home.
    expect(profileDir).toBe(join(home, 'profiles', profile))
    // The runner's extra overlays reuse existing row ids (agent-presets
    // config, telemetry disable, dry-run suppressions), so the id SETS must
    // match exactly.
    expect([...rows.keys()].sort()).toEqual([...dumpIds].sort())
    // A dry-run must not have user-visible side effects: no browser, and the
    // guard's state is isolated from the deployment's real stateDir.
    const overlayRow = (id: string): Record<string, unknown> | undefined =>
      patches.find(row => (row as { id?: unknown }).id === id) as Record<string, unknown> | undefined
    if (dumpIds.has('web-runtime')) {
      expect((overlayRow('web-runtime')?.config as Record<string, unknown> | undefined)?.openBrowser).toBe(false)
    }
    if (dumpIds.has('ankh-guard')) {
      expect(String((overlayRow('ankh-guard')?.config as Record<string, unknown> | undefined)?.stateDir)).toContain('ankh-guard-dry-run-')
    }
  }, 60_000)

  const generatedHomeTest = driftBuiltCliAvailable() ? it : it.skip
  generatedHomeTest('runs a built candidate against a DSH-generated home with a cyclic pnpm/Cordis link graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ankh-generated-dsh-home-'))
    const generatedHome = join(root, 'home')
    const graph = join(generatedHome, 'pnpm-cordis-cycle')
    const runtimePackage = join(graph, 'packages', 'cordis-runtime')
    const pluginPackage = join(graph, 'packages', 'cordis-plugin')
    const externalPackage = join(root, 'external-package')
    let snapshot: Awaited<ReturnType<typeof snapshotOffThread>> | undefined
    try {
      mkdirSync(generatedHome)
      const initialize = await run(process.execPath, [builtDshCli!, '--profile', 'web', '--dump-config'], {
        cwd: dirname(builtDshCli!),
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: generatedHome },
      })
      expect(initialize.error).toBeUndefined()
      expect(initialize.status, initialize.stderr).toBe(0)
      const liveProfile = join(generatedHome, 'profiles', 'web', 'package.json')
      const liveProfileBytes = readFileSync(liveProfile)
      const generatedCordisLink = join(generatedHome, 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
      expect(lstatSync(generatedCordisLink).isSymbolicLink()).toBe(true)

      mkdirSync(runtimePackage, { recursive: true })
      mkdirSync(pluginPackage, { recursive: true })
      mkdirSync(externalPackage)
      writeFileSync(join(graph, 'package.json'), `${JSON.stringify({
        name: 'ankh-pnpm-cordis-cycle',
        private: true,
        dependencies: {
          '@fixture/cordis-runtime': 'workspace:*',
          '@fixture/cordis-plugin': 'workspace:*',
          '@fixture/external': 'link:../../external-package',
        },
      }, null, 2)}\n`)
      writeFileSync(join(graph, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
      writeFileSync(join(runtimePackage, 'package.json'), `${JSON.stringify({
        name: '@fixture/cordis-runtime', version: '1.0.0',
        dependencies: { '@fixture/cordis-plugin': 'workspace:*' },
      }, null, 2)}\n`)
      writeFileSync(join(pluginPackage, 'package.json'), `${JSON.stringify({
        name: '@fixture/cordis-plugin', version: '1.0.0',
        dependencies: { '@fixture/cordis-runtime': 'workspace:*' },
      }, null, 2)}\n`)
      writeFileSync(join(externalPackage, 'package.json'), `${JSON.stringify({
        name: '@fixture/external', version: '1.0.0',
      }, null, 2)}\n`)
      writeFileSync(join(runtimePackage, 'state.txt'), 'live-cordis-runtime')
      writeFileSync(join(externalPackage, 'state.txt'), 'live-external-package')
      const install = await run('pnpm', ['install', '--offline', '--ignore-scripts'], {
        cwd: graph,
        encoding: 'utf8',
      })
      expect(install.error).toBeUndefined()
      expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0)

      const runtimeLink = join(graph, 'node_modules', '@fixture', 'cordis-runtime')
      const pluginLink = join(graph, 'node_modules', '@fixture', 'cordis-plugin')
      const externalLink = join(graph, 'node_modules', '@fixture', 'external')
      expect(lstatSync(runtimeLink).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(runtimePackage, 'node_modules', '@fixture', 'cordis-plugin')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(pluginPackage, 'node_modules', '@fixture', 'cordis-runtime')).isSymbolicLink()).toBe(true)

      snapshot = await snapshotOffThread(generatedHome)
      const copiedGraph = join(snapshot.home, 'pnpm-cordis-cycle')
      const copiedCordisLink = join(snapshot.home, 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
      const copiedRuntimeLink = join(copiedGraph, 'node_modules', '@fixture', 'cordis-runtime')
      const copiedPluginLink = join(copiedGraph, 'node_modules', '@fixture', 'cordis-plugin')
      const copiedExternalLink = join(copiedGraph, 'node_modules', '@fixture', 'external')
      expect(lstatSync(copiedRuntimeLink).isSymbolicLink()).toBe(true)
      expect(lstatSync(copiedPluginLink).isSymbolicLink()).toBe(true)
      expect(lstatSync(copiedExternalLink).isSymbolicLink()).toBe(true)
      expect(lstatSync(copiedCordisLink).isSymbolicLink()).toBe(true)
      expect(realpathSync(copiedCordisLink).startsWith(`${realpathSync(snapshot.root)}/`)).toBe(true)
      const copiedRuntime = realpathSync(copiedRuntimeLink)
      const copiedPlugin = realpathSync(copiedPluginLink)
      expect(realpathSync(join(copiedRuntime, 'node_modules', '@fixture', 'cordis-plugin'))).toBe(copiedPlugin)
      expect(realpathSync(join(copiedPlugin, 'node_modules', '@fixture', 'cordis-runtime'))).toBe(copiedRuntime)
      expect(realpathSync(copiedExternalLink).startsWith(`${realpathSync(snapshot.root)}/`)).toBe(true)

      const candidate = await run(process.execPath, ['-e', `
const fs = require('node:fs')
const child = require('node:child_process')
fs.writeFileSync(process.env.ANKH_TEST_RUNTIME_LINK + '/state.txt', 'candidate-cordis-runtime')
fs.writeFileSync(process.env.ANKH_TEST_EXTERNAL_LINK + '/state.txt', 'candidate-external-package')
const result = child.spawnSync(process.execPath, [process.env.ANKH_TEST_DSH_CLI, '--profile', 'web', '--dump-config'], {
  cwd: process.env.ANKH_TEST_DSH_CWD,
  env: process.env,
  encoding: 'utf8',
})
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) throw result.error
process.exit(result.status === null ? 1 : result.status)
`], {
        cwd: dirname(builtDshCli!),
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_HOME: snapshot.home,
          ANKH_TEST_RUNTIME_LINK: copiedRuntimeLink,
          ANKH_TEST_EXTERNAL_LINK: copiedExternalLink,
          ANKH_TEST_DSH_CLI: builtDshCli!,
          ANKH_TEST_DSH_CWD: dirname(builtDshCli!),
        },
      })
      expect(candidate.error).toBeUndefined()
      expect(candidate.status, candidate.stderr).toBe(0)
      expect(candidate.stdout).toContain('- id:')
      expect(readFileSync(join(copiedRuntimeLink, 'state.txt'), 'utf8')).toBe('candidate-cordis-runtime')
      expect(readFileSync(join(copiedExternalLink, 'state.txt'), 'utf8')).toBe('candidate-external-package')
      expect(readFileSync(join(runtimePackage, 'state.txt'), 'utf8')).toBe('live-cordis-runtime')
      expect(readFileSync(join(externalPackage, 'state.txt'), 'utf8')).toBe('live-external-package')
      expect(readFileSync(liveProfile)).toEqual(liveProfileBytes)
    } finally {
      if (snapshot) await rm(snapshot.root, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})

/**
 * Regression coverage for the runtime-resolution mount (the tarball-profile
 * false FAIL): on the 0.1.6/0.1.7 host lines the runner must hand the
 * composed resolution to the boot's PluginPackages mount and provide the
 * launcher's profileContext service — a tarball profile's own node_modules
 * holds no `@deepseek-ai/*` entries, so without the in-process interception
 * every entry import fails natively while the real boot is clean. These
 * tests boot against a fake built host surface, so they run everywhere.
 */
interface FakeHostOptions {
  line: 'rc' | '0.1.2' | '0.1.6' | '0.1.7'
  /** Include an `hmr` row in the profile's own patch layer. */
  hmrRow?: boolean
  /** Make the fake boot throw, simulating a tree that fails to boot. */
  bootError?: boolean
}

interface FakeHost {
  root: string
  home: string
  profileDir: string
  installAnchor: string
  recordsFile: string
}

function writeFakeBuiltHost(options: FakeHostOptions): FakeHost {
  const root = mkdtempSync(join(tmpdir(), 'ankh-preflight-mount-'))
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'web')
  const recordsFile = join(root, 'records.jsonl')
  const installAnchor = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(dirname(installAnchor), { recursive: true })
  writeFileSync(installAnchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }, null, 2)}\n`)
  writeFileSync(recordsFile, '')

  const recordPrelude = `import { appendFileSync } from 'node:fs'
const RECORDS = ${JSON.stringify(recordsFile)}
const record = (entry) => appendFileSync(RECORDS, JSON.stringify(entry) + '\\n')
`
  const writePackage = (name: string, code: string) => {
    const dir = join(root, 'node_modules', '@deepseek-ai', name)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: `@deepseek-ai/${name}`, version: '0.0.0-test', type: 'module', main: './lib/index.js',
    }, null, 2)}\n`)
    writeFileSync(join(dir, 'lib', 'index.js'), code)
  }

  const profileRows = options.hmrRow === true
    ? [{ id: 'hmr', name: '@deepseek-ai/dsh-hmr', config: { root: [] } }]
    : []
  const lineExports = {
    rc: `export const healProfilesModuleFallback = (anchor, home) => record({ heal: [String(anchor), String(home)] })
`,
    '0.1.2': `export const DEFAULT_PROFILE_PATCH_RELOAD = 'marker'
export const healProfilesModuleFallback = async (options) => record({ heal: options })
`,
    '0.1.6': `export const createProfileResolutionGeneration = async (options) => ({ sentinel: 'generation-0.1.6' })
`,
    '0.1.7': `export const createRuntimeResolution = async (options) => ({ sentinel: 'resolution-0.1.7' })
`,
  }[options.line]
  writePackage('dsh-app-boot', `${recordPrelude}
export const composeEntries = (layers) => layers.flatMap(layer => layer.flatMap(row => row !== null && typeof row === 'object' && Array.isArray(row.insert) ? row.insert : [row]))
export const loadOptionalPatches = () => undefined
export const loadOverlayPatches = () => []
export const loadProfile = () => ({
  dir: ${JSON.stringify(profileDir)},
  patchPath: ${JSON.stringify(join(profileDir, 'cordis.patch.yml'))},
  patches: ${JSON.stringify(profileRows)},
  layers: [{ packageName: '@fixture/bundle', patches: [] }],
})
export const loadLayeredEnv = () => ({})
export class PluginPackages {
  constructor(ctx, config) { record({ pluginPackages: config }) }
}
export const boot = async (bin, config, patches, prepare) => {
  const hostCtx = {
    provide: (key, value) => record({ provide: key }),
    plugin: async (service, config) => record({ plugin: config }),
  }
  await prepare?.(hostCtx)
  ${options.bootError === true ? "throw new Error('fixture tree failed to boot')" : ''}
  return { get: () => undefined, fiber: { dispose: async () => record({ disposed: true }) } }
}
${lineExports}`)
  writePackage('dsh-home-paths', `export const resolveDshHome = (configured) => configured ?? ${JSON.stringify(home)}
`)
  writePackage('dsh-launch-environment', `export const DSH_LAUNCH_ENVIRONMENT_KEY = 'launchEnvironment'
`)
  writePackage('dsh-cmdline', `${recordPrelude}
export const provideCmdline = (ctx, options) => record({ cmdline: true })
`)
  return { root, home, profileDir, installAnchor, recordsFile }
}

function readRecords(host: FakeHost): Array<Record<string, unknown>> {
  return readFileSync(host.recordsFile, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('preflight runner runtime-resolution mount', () => {
  it('0.1.7 line: mounts the computed runtime resolution through PluginPackages and provides profileContext', async () => {
    const host = writeFakeBuiltHost({ line: '0.1.7', hmrRow: true })
    try {
      const binding = { surface: 'built', installAnchor: host.installAnchor } as const
      const composed = await composePreflightPatches('web', [], host.root, host.home, binding)
      // The compose keeps the resolution for the boot instead of discarding it.
      expect(composed.pluginPackagesConfig).toEqual({ resolution: { sentinel: 'resolution-0.1.7' } })
      expect(composed.profileContext).toMatchObject({
        name: 'web',
        dir: host.profileDir,
        patchPath: join(host.profileDir, 'cordis.patch.yml'),
        installAnchor: host.installAnchor,
        startedBundles: ['@fixture/bundle'],
        home: host.home,
      })
      // profileContext would enable the hmr row's file watchers; the one-shot
      // dry-run disables the row instead (no HMR, no user-patch watchers).
      expect(composed.patches).toContainEqual({ id: 'hmr', disabled: true })

      writeFileSync(host.recordsFile, '')
      const code = await runPreflight('web', [], host.root, binding)
      expect(code).toBe(0)
      const records = readRecords(host)
      // The launcher order: profileContext, launch environment, PluginPackages, cmdline.
      expect(records.map(record => Object.keys(record)[0])).toEqual(['provide', 'provide', 'plugin', 'cmdline', 'disposed'])
      expect(records[0].provide).toBe('profileContext')
      expect(records[1].provide).toBe('launchEnvironment')
      expect(records[2].plugin).toEqual({ resolution: { sentinel: 'resolution-0.1.7' } })
    } finally {
      rmSync(host.root, { recursive: true, force: true })
    }
  })

  it('0.1.6 line: mounts the computed resolution generation through PluginPackages', async () => {
    const host = writeFakeBuiltHost({ line: '0.1.6', hmrRow: true })
    try {
      const binding = { surface: 'built', installAnchor: host.installAnchor } as const
      const composed = await composePreflightPatches('web', [], host.root, host.home, binding)
      expect(composed.pluginPackagesConfig).toEqual({ generation: { sentinel: 'generation-0.1.6' } })
      expect(composed.profileContext).toMatchObject({ name: 'web', dir: host.profileDir })
      expect(composed.patches).toContainEqual({ id: 'hmr', disabled: true })

      writeFileSync(host.recordsFile, '')
      const code = await runPreflight('web', [], host.root, binding)
      expect(code).toBe(0)
      const records = readRecords(host)
      expect(records.map(record => Object.keys(record)[0])).toEqual(['provide', 'provide', 'plugin', 'cmdline', 'disposed'])
      expect(records[2].plugin).toEqual({ generation: { sentinel: 'generation-0.1.6' } })
    } finally {
      rmSync(host.root, { recursive: true, force: true })
    }
  })

  it('rc line: heals fallback links and mounts no PluginPackages and no profileContext', async () => {
    const host = writeFakeBuiltHost({ line: 'rc', hmrRow: true })
    try {
      const binding = { surface: 'built', installAnchor: host.installAnchor } as const
      const composed = await composePreflightPatches('web', [], host.root, host.home, binding)
      expect(composed.pluginPackagesConfig).toBeUndefined()
      expect(composed.profileContext).toBeUndefined()
      // No profileContext, so nothing enables the hmr row: no dry-run override either.
      expect(composed.patches).not.toContainEqual({ id: 'hmr', disabled: true })

      writeFileSync(host.recordsFile, '')
      const code = await runPreflight('web', [], host.root, binding)
      expect(code).toBe(0)
      const records = readRecords(host)
      // The rc heal is positional and synchronous, before the profile load.
      expect(records[0]).toEqual({ heal: [host.installAnchor, host.home] })
      expect(records.some(record => 'plugin' in record)).toBe(false)
      expect(records.some(record => record.provide === 'profileContext')).toBe(false)
    } finally {
      rmSync(host.root, { recursive: true, force: true })
    }
  })

  it('0.1.2 line: heals through the async options API and mounts no PluginPackages', async () => {
    const host = writeFakeBuiltHost({ line: '0.1.2', hmrRow: true })
    try {
      const binding = { surface: 'built', installAnchor: host.installAnchor } as const
      const composed = await composePreflightPatches('web', [], host.root, host.home, binding)
      expect(composed.pluginPackagesConfig).toBeUndefined()
      expect(composed.profileContext).toBeUndefined()

      writeFileSync(host.recordsFile, '')
      const code = await runPreflight('web', [], host.root, binding)
      expect(code).toBe(0)
      const records = readRecords(host)
      expect(records[0]).toMatchObject({ heal: { installAnchor: host.installAnchor, home: host.home } })
      expect(records.some(record => 'plugin' in record)).toBe(false)
    } finally {
      rmSync(host.root, { recursive: true, force: true })
    }
  })

  it('a boot failure with the resolution mounted remains a composition verdict (exit 1)', async () => {
    const host = writeFakeBuiltHost({ line: '0.1.7', bootError: true })
    try {
      const binding = { surface: 'built', installAnchor: host.installAnchor } as const
      const code = await runPreflight('web', [], host.root, binding)
      expect(code).toBe(1)
      // The PluginPackages mount ran before the failure — the prepare order is intact.
      expect(readRecords(host).some(record => 'plugin' in record)).toBe(true)
    } finally {
      rmSync(host.root, { recursive: true, force: true })
    }
  })
})
