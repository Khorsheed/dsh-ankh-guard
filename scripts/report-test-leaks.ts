#!/usr/bin/env node
import {
  formatMachineLeaseReclaimResult, formatMachineLeaseReport,
  inspectMachineTestLeases, reclaimMachineTestLeases,
} from '../tests/helpers/process-lifecycle.ts'

const usage = 'usage: report-test-leaks [--age-ms N] [--json] [--summary] [--reclaim]\n'
const valued = new Set(['--age-ms'])
const switches = new Set(['--', '--json', '--summary', '--reclaim'])
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]
  if (switches.has(argument)) continue
  if (valued.has(argument) && process.argv[index + 1] !== undefined) {
    index++
    continue
  }
  process.stderr.write(usage)
  process.exit(2)
}

const ageIndex = process.argv.indexOf('--age-ms')
const ageMs = ageIndex < 0 ? undefined : Number(process.argv[ageIndex + 1])
if (ageMs !== undefined && (!Number.isFinite(ageMs) || ageMs < 0)) {
  process.stderr.write(usage)
  process.exit(2)
}
const now = Date.now()
const reclaim = process.argv.includes('--reclaim')
const result = reclaim ? reclaimMachineTestLeases(now, ageMs ?? 0) : undefined
const report = inspectMachineTestLeases(now, ageMs)
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(result === undefined ? report : { reclaim: result, report }, null, 2)}\n`)
} else {
  if (result !== undefined) process.stdout.write(formatMachineLeaseReclaimResult(result))
  if (process.argv.includes('--summary')) {
    process.stdout.write([
      `reclaimable-dead: ${report.reclaimable.length}`,
      `over-age-live-human-review: ${report.overAgeLive.length}`,
      `active-live: ${report.activeLive.length}`,
      `unreadable: ${report.unreadable.length}`,
      '',
    ].join('\n'))
  } else {
    process.stdout.write(formatMachineLeaseReport(report))
  }
}
if (result !== undefined && result.errors.length > 0) process.exitCode = 1
