/** JSON is authoritative; human stdout is retained as diagnostic evidence only. */
export function assessTestResult(task, report, processResult) {
  const reasons = []
  const valid = report !== null && typeof report === 'object'
    && ['numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numTotalTests', 'numFailedTestSuites']
      .every(key => Number.isInteger(report[key]) && report[key] >= 0)
    && Array.isArray(report.testResults)
    && report.testResults.every(file => file && Array.isArray(file.assertionResults)
      && file.assertionResults.every(test => test && typeof test.status === 'string'))
  const counts = valid ? {
    passed: report.numPassedTests, failed: report.numFailedTests,
    skipped: report.numPendingTests, todo: report.numTodoTests, total: report.numTotalTests,
  } : { passed: null, failed: null, skipped: null, todo: null, total: null }
  if (!valid) reasons.push('missing-or-invalid-report')
  if (processResult.spawnError) reasons.push('spawn-error')
  if (processResult.signal) reasons.push('process-signal')
  if (processResult.code !== 0) reasons.push('nonzero-exit')
  if (valid) {
    if (!report.success || counts.failed || report.numFailedTestSuites) reasons.push('test-or-suite-failure')
    if (counts.passed !== task.expected) reasons.push('passing-inventory-mismatch')
    if (counts.total !== counts.passed + counts.failed + counts.skipped + counts.todo) reasons.push('inconsistent-report')
  }
  return {
    task: task.name, expected: task.expected, ...counts,
    missingPassing: valid ? task.expected - counts.passed : null,
    code: processResult.code, signal: processResult.signal,
    spawnError: processResult.spawnError ? String(processResult.spawnError) : null,
    reasons, ok: reasons.length === 0,
    failures: valid ? report.testResults.flatMap(file => [
      ...(file.message ? [{ file: file.name, message: file.message }] : []),
      ...file.assertionResults.filter(test => test.status === 'failed').map(test => ({
        file: file.name, test: test.fullName, messages: test.failureMessages,
      })),
    ]) : [],
  }
}
