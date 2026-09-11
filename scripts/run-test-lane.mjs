#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { cpus, loadavg, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { acquireTestResource } from './test-resource.mjs'
import { assessTestResult } from './test-result.mjs'
import { driftBuiltCliAvailable, driftTripwireRunnable } from '../tests/preflight-environment.mjs'

const lane = process.argv[2]
if (lane !== 'unit' && lane !== 'integration' && lane !== 'all') {
  process.stderr.write('usage: run-test-lane.mjs <unit|integration|all>\n')
  process.exit(2)
}

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const selfSpec = 'tests/self-restart-guard.spec.ts'
const pureSpecs = [
  'tests/browser-handoff.client.spec.ts',
  'tests/browser-handoff.spec.ts',
  'tests/deployment-proof.spec.ts',
  'tests/patch.spec.ts',
  'tests/preset-derive.spec.ts',
  'tests/restart-request.spec.ts',
  'tests/state-files.spec.ts',
  'tests/transition.spec.ts',
  'tests/test-runner.spec.ts',
]

const unitTasks = [
  { name: 'pure', args: pureSpecs },
  {
    name: 'self-unit', args: [selfSpec, '-t', '^(state core|durable launch cutover state|cordis service \\(real git repo\\)|invariant|pack smoke)'],
  },
]
const integrationTasks = [
  ...Array.from({ length: 4 }, (_, index) => ({
    name: `supervise-${index + 1}-of-4`,
    args: [selfSpec, '-t', '^supervise'],
    env: {
      ANKH_GUARD_TEST_SHARD_COUNT: '4',
      ANKH_GUARD_TEST_SHARD_INDEX: String(index),
    },
  })),
  {
    name: 'self-process', args: [selfSpec, '-t', '^(process ownership discovery|CLI|composition preflight gate|restart context injection)'],
  },
  { name: 'lifecycle-drift', args: ['tests/process-lifecycle.spec.ts', 'tests/preflight-drift.spec.ts'] },
]
const tasks = lane === 'unit' ? unitTasks : lane === 'integration' ? integrationTasks : [...integrationTasks, ...unitTasks]
// lifecycle-drift carries two environment-gated tripwires (see
// tests/preflight-drift.spec.ts): the launcher-comparison test needs a real
// deployment profile under the probed home, and the generated-home snapshot
// test needs a built dsh CLI in the toolchain cache. Neither exists in CI, so
// the expected count follows the same shared probes instead of hardcoding a
// deployment-machine count.
const lifecycleDriftExpected = 9 + (driftTripwireRunnable() ? 1 : 0) + (driftBuiltCliAvailable() ? 1 : 0)
const inventory = { pure: 53, 'self-unit': 21, 'supervise-1-of-4': 15, 'supervise-2-of-4': 10,
  'supervise-3-of-4': 15, 'supervise-4-of-4': 12, 'self-process': 67, 'lifecycle-drift': lifecycleDriftExpected }
for (const task of tasks) task.expected = inventory[task.name]
const artifacts = mkdtempSync(join(tmpdir(), 'ankh-test-results-'))
process.stdout.write(`ankh-guard test artifacts: ${artifacts}\n`)
const release = lane === 'unit' ? () => {} : await acquireTestResource('ankh-integration')

function captureBaseline() {
  const cli = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
  let gitHead = 'unavailable'
  let activeTestProcesses = -1
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
  try {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
      })
    const byPid = new Map(rows.map(row => [row.pid, row]))
    const ownChain = new Set([process.pid])
    let cursor = byPid.get(process.pid)?.ppid
    while (cursor !== undefined && cursor > 0 && !ownChain.has(cursor)) {
      ownChain.add(cursor)
      cursor = byPid.get(cursor)?.ppid
    }
    activeTestProcesses = rows.filter(row => !ownChain.has(row.pid) && /(?:vitest|gate\.mts|run-test-lane)/.test(row.command)).length
  } catch {}
  return {
    event: 'ankh-guard-integration-baseline',
    measuredAt: new Date().toISOString(),
    logicalCpuCount: cpus().length,
    node: process.version,
    packageManager: process.env.npm_config_user_agent ?? 'unknown',
    loadAverage: loadavg(),
    activeTestProcesses,
    gitHead,
    cli,
    cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
  }
}
const baseline = captureBaseline()
process.stdout.write(`${JSON.stringify(baseline)}\n`)

const maxParallel = lane === 'unit' ? 2 : 4
// Match the repository preset for spawn-heavy tests without adding a package
// vitest.config.ts: the public ankh-guard mirror owns its standalone config.
// Individual lifecycle cases keep their larger explicit budgets.
const defaultTestTimeoutMs = 30_000
let cursor = 0
let failed = false
let passed = 0
const results = []

async function worker() {
  while (cursor < tasks.length) {
    const task = tasks[cursor++]
    const started = performance.now()
    const reportFile = join(artifacts, `${task.name}.json`)
    const stdoutFile = join(artifacts, `${task.name}.stdout.log`)
    const stderrFile = join(artifacts, `${task.name}.stderr.log`)
    const stdout = openSync(stdoutFile, 'wx', 0o600)
    const stderr = openSync(stderrFile, 'wx', 0o600)
    const child = spawn(process.execPath, [vitest, 'run', '--maxWorkers', '1', '--minWorkers', '1',
      '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`,
      '--testTimeout', String(defaultTestTimeoutMs), ...task.args], {
      env: { ...process.env, ...task.env },
      stdio: ['ignore', stdout, stderr],
    })
    const result = await new Promise(resolve => {
      let spawnError
      child.once('error', error => { spawnError = error })
      // `exit` can precede the final stdout/stderr pipe reads. `close` is the
      // lifecycle boundary that proves both the process and its stdio closed.
      child.once('close', (code, signal) => resolve({ code, signal, spawnError }))
    })
    closeSync(stdout)
    closeSync(stderr)
    const output = readFileSync(stdoutFile, 'utf8') + readFileSync(stderrFile, 'utf8')
    const outcome = result.signal === null ? `exit ${result.code}` : `signal ${result.signal}`
    process.stdout.write(`\n===== ${lane}:${task.name} (${Math.round(performance.now() - started)}ms, ${outcome}) =====\n${output}`)
    let report = null
    try { report = JSON.parse(readFileSync(reportFile, 'utf8')) } catch { /* Missing reports fail closed. */ }
    const assessment = { ...assessTestResult(task, report, result), reportFile, stdoutFile, stderrFile,
      durationMs: Math.round(performance.now() - started) }
    results.push(assessment)
    if (!assessment.ok) failed = true
    passed += assessment.passed ?? 0
  }
}

try {
  const workers = await Promise.allSettled(Array.from({ length: Math.min(maxParallel, tasks.length) }, () => worker()))
  const infrastructureErrors = workers.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : [])
  if (infrastructureErrors.length) failed = true
  const expected = tasks.reduce((sum, task) => sum + task.expected, 0)
  if (passed !== expected) {
    process.stderr.write(`\n${lane} lane inventory mismatch: expected ${expected} passing tests, observed ${passed}\n`)
    failed = true
  }
  const summary = { lane, expected, passed, failed, infrastructureErrors, baseline, atEnd: captureBaseline(), results, artifacts }
  writeFileSync(join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 })
  process.stdout.write(`\nankh-guard ${lane} task summary (${artifacts}):\n`)
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`)
  if (failed) process.stderr.write(`ankh-guard lane failure: ${JSON.stringify(summary)}\n`)
  if (failed) process.exitCode = 1
} finally {
  release()
}
