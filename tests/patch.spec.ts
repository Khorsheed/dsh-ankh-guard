import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')

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
})
