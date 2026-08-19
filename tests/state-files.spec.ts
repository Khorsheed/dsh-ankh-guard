/**
 * Gate: the state-directory protocol has exactly one owner. The watchdog's
 * bash side addresses state files as `$STATE_DIR/<name>` literals; every one
 * of them must be a name src/state-files.ts declares, and every file the
 * watchdog touches must still be spelled the same. A drift in either
 * direction splits the protocol between the TS and bash sides — the failure
 * mode behind three rounds of path bugs.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STATE_FILES } from '../src/state-files.ts'

const script = readFileSync(fileURLToPath(new URL('../scripts/dsh-watchdog.sh', import.meta.url)), 'utf8')

/** Roles the bash side is expected to reference. */
const BASH_ROLES = [
  'guard',
  'lastGoodBoot',
  'restartRequested',
  'watchdogPid',
  'watchdogStop',
  'watchdogGaveUp',
  'bootAttemptLog',
] as const

describe('state-directory protocol: bash literals match state-files.ts', () => {
  it('every $STATE_DIR/<name> literal in the watchdog is a declared file', () => {
    const declared = new Set(Object.values(STATE_FILES))
    const literals = [...script.matchAll(/\$STATE_DIR\/([A-Za-z0-9._-]+)/g)].map(match => match[1])
    expect(literals.length).toBeGreaterThan(0)
    for (const name of literals) expect(declared.has(name as never), `$STATE_DIR/${name} is undeclared`).toBe(true)
  })

  it('every file the watchdog owns is still spelled the same', () => {
    for (const role of BASH_ROLES) {
      expect(script, `${role} (${STATE_FILES[role]}) missing from the watchdog`).toContain(`$STATE_DIR/${STATE_FILES[role]}`)
    }
  })
})
