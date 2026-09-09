import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  proveCurrentDeployment, verifyProvenDeployment, verifyRestartAuthorization, verifyRestartEvidence,
} from '../src/deployment-proof.ts'
import { commandSha256, writeStableLaunchSpec, type LaunchSpec } from '../src/launch-spec.ts'
import { loadState, recordCredential } from '../src/state.ts'
import { runCli, type CliIo } from '../src/cli.ts'

const roots: string[] = []
const NOW = 1_800_000_000_000

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function fixture(): { root: string; stateDir: string; repo: string; home: string; spec: LaunchSpec } {
  const root = mkdtempSync(join(tmpdir(), 'guard-proof-'))
  roots.push(root)
  const repo = join(root, 'harness')
  const home = join(root, 'home')
  const stateDir = join(home, 'state')
  const profile = join(home, 'profiles', 'web')
  const installed = join(profile, 'node_modules', 'fixture-plugin')
  mkdirSync(repo, { recursive: true })
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture-host"}\n')
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(repo, 'host.js'), 'export const host = true\n')
  writeFileSync(join(repo, 'preflight-runner.js'), 'export const preflight = true\n')
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'guard@test')
  git(repo, 'config', 'user.name', 'guard test')
  git(repo, 'add', 'package.json', 'pnpm-lock.yaml', 'host.js', 'preflight-runner.js')
  git(repo, 'commit', '-qm', 'fixture')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'fixture-profile', dependencies: { 'fixture-plugin': '1.0.0' },
  }))
  writeFileSync(join(profile, 'cordis.patch.yml'), 'config:\n  - fixture-plugin\n')
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(installed, 'package.json'), '{"name":"fixture-plugin","version":"1.0.0"}\n')
  writeFileSync(join(installed, 'index.js'), 'export const value = 1\n')
  const spec: LaunchSpec = {
    version: 1,
    command: `node ${join(repo, 'host.js')}`,
    port: 3080,
    home,
    credentialRepo: repo,
    harnessRoot: repo,
    profile: 'web',
    preflight: {
      version: 1,
      surface: 'source',
      runnerExecutable: process.execPath,
      runnerRuntimeArgs: [],
      runnerPath: join(repo, 'preflight-runner.js'),
      runnerSha256: createHash('sha256').update('export const preflight = true\n').digest('hex'),
      installAnchor: join(repo, 'package.json'),
      installAnchorSha256: createHash('sha256').update('{"name":"fixture-host"}\n').digest('hex'),
      hostPackageVersion: '0.0.0-test',
      targetCommandSha256: commandSha256(`node ${join(repo, 'host.js')}`),
    },
  }
  writeStableLaunchSpec(stateDir, spec)
  return { root, stateDir, repo, home, spec }
}

function seedProof(stateDir: string, repo: string, spec: LaunchSpec): void {
  const revision = git(repo, 'rev-parse', 'HEAD')
  recordCredential(stateDir, { scope: 'build+test', revision, command: 'pnpm build && pnpm test' }, NOW)
  const fresh = verifyRestartEvidence(stateDir, spec, 10, NOW)
  expect(fresh.ok).toBe(true)
  expect(fresh.authorization?.kind).toBe('fresh-credential')
  expect(proveCurrentDeployment(stateDir, spec, fresh.authorization!, NOW + 1).ok).toBe(true)
}

describe('pure-restart deployment proof', () => {
  it('reuses a canary-promoted deployment after the build credential expires', () => {
    const { stateDir, repo, spec } = fixture()
    seedProof(stateDir, repo, spec)

    const result = verifyRestartEvidence(stateDir, spec, 10, NOW + 11 * 60_000)
    expect(result.ok).toBe(true)
    expect(result.authorization?.kind).toBe('proven-deployment')
    expect(result.reason).toContain('proven deployment valid')
    expect(loadState(stateDir).provenDeployment?.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('does not treat a legacy boot stamp or an unpromoted credential as reusable evidence', () => {
    const { stateDir, repo, spec } = fixture()
    const revision = git(repo, 'rev-parse', 'HEAD')
    recordCredential(stateDir, { scope: 'build+test', revision, command: 'green' }, NOW)
    writeFileSync(join(stateDir, 'last-good-boot.json'), JSON.stringify({ revision, at: NOW + 1 }))

    const result = verifyRestartEvidence(stateDir, spec, 10, NOW + 11 * 60_000)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no proven deployment recorded')
  })

  it('fails closed when profile config or installed package bytes drift', () => {
    const first = fixture()
    seedProof(first.stateDir, first.repo, first.spec)
    writeFileSync(join(first.home, 'profiles', 'web', 'cordis.patch.yml'), 'config:\n  - changed\n')
    expect(verifyProvenDeployment(first.stateDir, first.spec).reason).toContain('fingerprint changed')

    const second = fixture()
    seedProof(second.stateDir, second.repo, second.spec)
    writeFileSync(join(second.home, 'profiles', 'web', 'node_modules', 'fixture-plugin', 'index.js'), 'export const value = 2\n')
    expect(verifyProvenDeployment(second.stateDir, second.spec).reason).toContain('fingerprint changed')
  })

  it('follows linked package targets and detects external target drift', () => {
    const { root, stateDir, repo, home, spec } = fixture()
    const profile = join(home, 'profiles', 'web')
    const installed = join(profile, 'node_modules', 'fixture-plugin')
    const external = join(root, 'external-plugin')
    rmSync(installed, { recursive: true, force: true })
    mkdirSync(external)
    writeFileSync(join(external, 'package.json'), '{"name":"fixture-plugin","version":"1.0.0"}\n')
    writeFileSync(join(external, 'index.js'), 'export const value = 1\n')
    symlinkSync(external, installed)
    seedProof(stateDir, repo, spec)

    writeFileSync(join(external, 'index.js'), 'export const value = 2\n')
    expect(verifyProvenDeployment(stateDir, spec).reason).toContain('fingerprint changed')
  })

  it('binds the scheduled authorization and invalidates proof on a new record attempt', () => {
    const { stateDir, repo, spec } = fixture()
    seedProof(stateDir, repo, spec)
    const reusable = verifyRestartEvidence(stateDir, spec, 10, NOW + 11 * 60_000)
    expect(verifyRestartAuthorization(stateDir, spec, reusable.authorization!).ok).toBe(true)

    const revision = git(repo, 'rev-parse', 'HEAD')
    recordCredential(stateDir, { scope: 'replacement', revision, command: 'different evidence' }, NOW + 12 * 60_000)
    expect(loadState(stateDir).provenDeployment).toBeUndefined()
    expect(verifyRestartAuthorization(stateDir, spec, reusable.authorization!).ok).toBe(false)
    expect(reusable.authorization?.evidenceSha256).not.toBe(commandSha256('different evidence'))
  })

  it('makes the successor CLI revalidate the evidence SHA from the restart marker', async () => {
    const { stateDir, repo, home, spec } = fixture()
    seedProof(stateDir, repo, spec)
    const reusable = verifyRestartEvidence(stateDir, spec, 10, NOW + 11 * 60_000)
    writeFileSync(join(stateDir, 'restart-requested.json'), JSON.stringify({
      reason: 'scheduled self-restart', requestedAt: Date.now(), authorization: reusable.authorization,
    }))
    const output: string[] = []
    const io: CliIo = { stdout: value => output.push(value), stderr: value => output.push(value) }
    expect(await runCli(['verify-restart', '--state-dir', stateDir], io)).toBe(0)
    expect(output.join('')).toContain('restart evidence PASS')

    writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'fixture-plugin', 'index.js'), 'drift\n')
    expect(await runCli(['verify-restart', '--state-dir', stateDir], io)).toBe(1)
    expect(output.join('')).toContain('scheduled proven-deployment authorization changed')
  })
})
