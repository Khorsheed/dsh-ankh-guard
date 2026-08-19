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
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composePreflightPatches, resolveHarnessRoot } from '../src/preflight-runner.ts'

const harness = resolveHarnessRoot()
const home = process.env.DSH_HOME ?? ''
const profile = process.env.DSH_PREFLIGHT_PROFILE ?? 'web'
const harnessPresent = existsSync(join(harness, 'apps/cli'))
const profilePresent = home !== '' && existsSync(join(home, 'profiles', profile, 'package.json'))

describe('preflight composition drift tripwire', () => {
  const test = harnessPresent && profilePresent ? it : it.skip
  test('the runner composes the same entry ids as the launcher dump-config', async () => {
    const tsx = join(harness, 'node_modules/tsx/dist/esm/index.mjs')
    // cwd matters: the dump must resolve the harness's workspace packages,
    // not this repo's published ones (a foreign @deepseek-ai/cordis lacks
    // exports the harness source imports).
    const dump = spawnSync('node', ['--import', tsx, join(harness, 'apps/cli/src/bin.ts'), '--profile', profile, '--dump-config'], { encoding: 'utf8', cwd: harness })
    expect(dump.error).toBeUndefined()
    expect(dump.status).toBe(0)
    const dumpIds = new Set([...dump.stdout.matchAll(/^- id: (\S+)/gm)].map(match => match[1]))
    const { rows } = await composePreflightPatches(profile, [], harness)
    // The runner's two extra overlays reuse existing row ids (agent-presets
    // config, telemetry disable), so the id SETS must match exactly.
    expect([...rows.keys()].sort()).toEqual([...dumpIds].sort())
  }, 60_000)
})
