import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: { client?: { inject?: string[] } }
}

describe('ankh-guard bundle patch', () => {
  it('mounts the guard row at the profile root', () => {
    // The row ships in this package's own patch (dsh.bundle), so
    // `dsh plugin --profile <name> add` reconciles it into the bundles layer.
    expect(patch).toContain('- id: ankh-guard')
    // Scoped names are quoted: a bare @-prefixed scalar is invalid YAML.
    expect(patch).toContain('name: "@khorsheed/dsh-ankh-guard"')
  })

  it('inserts exactly one row', () => {
    expect(patch.match(/- id:/g)).toHaveLength(1)
  })

  it('uses the Cordis-only client contract shared by rc.2 and Alpha.4', () => {
    expect(manifest.dsh?.client?.inject).toEqual([])
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-client-runtime')
    expect(manifest.devDependencies).not.toHaveProperty('@deepseek-ai/dsh-client-runtime')
  })
})
