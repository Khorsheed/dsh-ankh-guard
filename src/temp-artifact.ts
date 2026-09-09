import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processIdentity, type ProcessIdentity } from './processes.ts'

/** Owner proof for a crash-left temporary artifact that may later be reaped. */
export const TEMP_ARTIFACT_OWNER_FILE = '.ankh-guard-owner.json'

export interface TempArtifactOwnerRecord {
  version: 1
  kind: 'preflight-snapshot'
  createdAt: number
  owner: ProcessIdentity
}

/**
 * Bind one private temporary artifact to the exact process identity creating
 * it. A later reaper may remove the artifact only after this identity is gone.
 */
export function writeTempArtifactOwner(root: string, kind: TempArtifactOwnerRecord['kind']): TempArtifactOwnerRecord {
  const owner = processIdentity(process.pid)
  if (owner === null) throw new Error(`cannot capture temporary-artifact owner identity for pid ${process.pid}`)
  const record: TempArtifactOwnerRecord = { version: 1, kind, createdAt: Date.now(), owner }
  writeFileSync(join(root, TEMP_ARTIFACT_OWNER_FILE), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
  return record
}
