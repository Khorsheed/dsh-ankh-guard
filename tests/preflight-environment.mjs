/**
 * Shared environment probes for the preflight-drift tripwire. Both the spec
 * (tests/preflight-drift.spec.ts) and the lane inventory (scripts/run-test-lane.mjs)
 * must agree on whether the two environment-gated tests will run — the lane's
 * expected-passing count is derived from these probes, so a green lane means
 * the same thing on a deployment machine and in CI (where neither the target
 * profile nor the toolchain cache exists).
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Mirror of preflight-runner's harness resolution chain, env-first. */
export function driftHarnessRoot() {
  return process.env.DSH_HARNESS ?? join(homedir(), 'code', 'deepseek-harness')
}

/** The same home chain the spec probes: DSH_WD_HOME → DSH_HOME → ~/.dsh-official → ~/.dsh. */
export function driftHome() {
  return [process.env.DSH_WD_HOME, process.env.DSH_HOME]
    .find(value => value !== undefined && value !== '')
    ?? (existsSync(join(homedir(), '.dsh-official')) ? join(homedir(), '.dsh-official') : join(homedir(), '.dsh'))
}

/** The launcher-comparison tripwire needs a harness checkout and the target profile. */
export function driftTripwireRunnable() {
  const harness = driftHarnessRoot()
  const profile = process.env.DSH_PREFLIGHT_PROFILE ?? 'web'
  return existsSync(join(harness, 'apps/cli'))
    && existsSync(join(driftHome(), 'profiles', profile, 'package.json'))
}

/** The generated-home snapshot test needs a built dsh CLI (env or toolchain cache). */
export function driftBuiltCliAvailable() {
  return [
    process.env.DSH_BUILT_CLI,
    join(homedir(), '.dsh-toolchains', 'stable', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(homedir(), '.dsh-toolchains', 'rc-0.1.2-rc.1', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].some(path => path !== undefined && existsSync(path))
}
