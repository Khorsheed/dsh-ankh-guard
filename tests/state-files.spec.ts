/**
 * Gate: the state-directory protocol has exactly one owner. The bash sides
 * (the watchdog, both supervisor installers) address state files as
 * `$STATE_DIR/<name>` literals; every one of them must be a name
 * src/state-files.ts declares, and every file each script owns must still be
 * spelled the same. A drift in either direction splits the protocol between
 * the TS and bash sides — the failure mode behind three rounds of path bugs.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STATE_FILES } from '../src/state-files.ts'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), 'utf8')

const watchdog = read('dsh-watchdog.sh')
const launchd = read('install-launchd.sh')
const systemd = read('install-systemd.sh')

/** Roles each bash side is expected to reference, spelled exactly as declared. */
const EXPECTED: ReadonlyArray<readonly [script: string, content: string, roles: readonly (keyof typeof STATE_FILES)[]]> = [
  ['dsh-watchdog.sh', watchdog, ['guard', 'lastGoodBoot', 'restartRequested', 'watchdogPid', 'watchdogStop', 'watchdogGaveUp', 'bootAttemptLog']],
  ['install-launchd.sh', launchd, ['watchdogPid', 'watchdogLog', 'watchdogStderrLog']],
  ['install-systemd.sh', systemd, ['watchdogPid', 'watchdogLog', 'watchdogStderrLog']],
]

/** Non-comment lines carrying a re-derived state path (home + '/state'). */
function rederivations(script: string, homeVar: string): string[] {
  return script.split('\n').filter(line =>
    !line.trimStart().startsWith('#')
    && line.includes(`$${homeVar}/state`)
    && !line.startsWith('STATE_DIR='))
}

describe('state-directory protocol: bash literals match state-files.ts', () => {
  it('every $STATE_DIR/<name> literal in every bash side is a declared file', () => {
    const declared = new Set(Object.values(STATE_FILES))
    for (const [name, content] of [['dsh-watchdog.sh', watchdog], ['install-launchd.sh', launchd], ['install-systemd.sh', systemd]] as const) {
      const literals = [...content.matchAll(/\$STATE_DIR\/([A-Za-z0-9._-]+)/g)].map(match => match[1])
      expect(literals.length, `${name} references no $STATE_DIR files`).toBeGreaterThan(0)
      for (const literal of literals) expect(declared.has(literal as never), `${name}: $STATE_DIR/${literal} is undeclared`).toBe(true)
    }
  })

  it('every file each bash side owns is still spelled the same', () => {
    for (const [name, content, roles] of EXPECTED) {
      for (const role of roles) {
        expect(content, `${name}: ${role} (${STATE_FILES[role]}) missing`).toContain(`$STATE_DIR/${STATE_FILES[role]}`)
      }
    }
  })

  it('no bash side re-derives the state directory from the home', () => {
    // The single permitted occurrence is the STATE_DIR default itself. Any
    // second one is the round-2 bug's shape: the same path derived twice.
    expect(rederivations(watchdog, 'DSH_ROOT')).toEqual([])
    expect(rederivations(launchd, 'HOME_DIR')).toEqual([])
    expect(rederivations(systemd, 'HOME_DIR')).toEqual([])
  })
})
