/**
 * Package-owned invariant companion for `@khorsheed/dsh-ankh-guard`.
 * @module @khorsheed/dsh-ankh-guard/invariant
 */

/* jscpd:ignore-start */
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { resolveStateDir } from './defaults.ts'
import { loadState, stateFilePath } from './state.ts'

const PACKAGE_NAME = '@khorsheed/dsh-ankh-guard'

/** Cordis companion plugin name. */
export const name = 'ankh-guard-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Owned-data check: the package's state file, when present at the default
 * location, must parse as a well-formed guard state. A malformed file would
 * make the gate unreadable — the credential's revision/recordedAt shape is
 * this package's own contract, so corruption fails loud at load instead of at
 * the moment a restart needs the gate.
 * @param _ctx - host context (unused; the check reads only the state file).
 * @param fail - invariant failure reporter.
 */
export const install: InvariantInstaller = (_ctx, fail) => {
  const stateDir = resolveStateDir(undefined)
  const file = stateFilePath(stateDir)
  if (!existsSync(file)) return
  try {
    loadState(stateDir)
  } catch (error) {
    fail(`state file ${file} is malformed: ${String(error)}`)
  }
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
