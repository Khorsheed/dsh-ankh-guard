import { createInterface } from 'node:readline'
import { acquireReclaimLockForTest } from '../helpers/process-lifecycle.ts'

const root = process.argv[2]
if (root === undefined) throw new Error('reclaim lock holder requires a lease root')

const lock = acquireReclaimLockForTest(root)
if (lock === null) throw new Error('reclaim lock holder could not acquire the requested lock')

const input = createInterface({ input: process.stdin })
process.stdout.write('acquired\n')

for await (const line of input) {
  if (line !== 'release') continue
  lock.release()
  process.stdout.write('released\n', () => process.exit(0))
}

lock.release()
throw new Error('reclaim lock holder input closed before release acknowledgement')
