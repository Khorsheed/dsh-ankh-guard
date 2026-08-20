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
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composePreflightPatches, resolveHarnessRoot } from '../src/preflight-runner.ts'

const harness = resolveHarnessRoot()
// Probe the home the guard actually protects in deployment: the same chain
// the supervisor installers use (DSH_WD_HOME → DSH_HOME → ~/.dsh-official),
// falling back to the conventional ~/.dsh of a plain npm-line machine. The
// composition differs wildly between homes, and a tripwire that validates a
// tree nobody runs is a blank round — the resolved home goes into the test
// name so a green line says WHICH tree it validated.
const home = [process.env.DSH_WD_HOME, process.env.DSH_HOME]
  .find(value => value !== undefined && value !== '')
  ?? (existsSync(join(homedir(), '.dsh-official')) ? join(homedir(), '.dsh-official') : join(homedir(), '.dsh'))
const profile = process.env.DSH_PREFLIGHT_PROFILE ?? 'web'
const harnessPresent = existsSync(join(harness, 'apps/cli'))
const profilePresent = existsSync(join(home, 'profiles', profile, 'package.json'))

describe('preflight composition drift tripwire', () => {
  const test = harnessPresent && profilePresent ? it : it.skip
  test(`the runner composes the same entry ids as the launcher dump-config (home ${home})`, async () => {
    const tsx = join(harness, 'node_modules/tsx/dist/esm/index.mjs')
    // cwd matters: the dump must resolve the harness's workspace packages,
    // not this repo's published ones (a foreign @deepseek-ai/cordis lacks
    // exports the harness source imports). env matters just as much: both
    // sides must compose the SAME home's tree — a green run against the wrong
    // home is a blank round with a confident title.
    const dump = spawnSync('node', ['--import', tsx, join(harness, 'apps/cli/src/bin.ts'), '--profile', profile, '--dump-config'], { encoding: 'utf8', cwd: harness, env: { ...process.env, DSH_HOME: home } })
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
})
