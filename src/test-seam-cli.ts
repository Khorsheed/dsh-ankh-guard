#!/usr/bin/env node
/** Internal executable used only by dsh-watchdog.sh under an explicit test run. */
import {
  appendTestLifecycleEventForProcess, registerCurrentTestProcess, registerTestProcess,
  TEST_PROCESS_ROLE_ENV,
} from './test-seam.ts'

const command = process.argv[2] ?? 'register'
if (command === 'register-parent') {
  const role = process.argv[3] ?? process.env[TEST_PROCESS_ROLE_ENV] ?? 'unknown'
  registerTestProcess(process.ppid, role, { source: 'child-self' })
} else if (command === 'event-parent') {
  const role = process.argv[3] ?? process.env[TEST_PROCESS_ROLE_ENV] ?? 'unknown'
  const event = process.argv[4] ?? 'unknown'
  appendTestLifecycleEventForProcess(process.ppid, role, event)
} else if (command === 'register-pid') {
  const pid = Number(process.argv[3])
  const role = process.argv[4] ?? process.env[TEST_PROCESS_ROLE_ENV] ?? 'unknown'
  registerTestProcess(pid, role, { source: 'child-self' })
} else if (command === 'event-pid') {
  const pid = Number(process.argv[3])
  const role = process.argv[4] ?? process.env[TEST_PROCESS_ROLE_ENV] ?? 'unknown'
  const event = process.argv[5] ?? 'unknown'
  appendTestLifecycleEventForProcess(pid, role, event)
} else {
  registerCurrentTestProcess()
}
