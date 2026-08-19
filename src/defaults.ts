/**
 * Default state/repo directory resolution, shared by the cordis plugin, the
 * CLI, and the invariant companion so all three agree on where a credential
 * lives. The state file must survive a restart, so it anchors to DSH_HOME (or
 * the checkout) rather than any process-lifetime directory.
 */
import { join } from 'node:path'

/**
 * Resolve the state directory: an explicit value wins, then $DSH_HOME/state,
 * then `<cwd>/.dsh-guard-state`.
 * @param configStateDir - plugin/CLI-provided override, or ''/undefined.
 * @returns the state directory.
 */
export function resolveStateDir(configStateDir: string | undefined): string {
  if (configStateDir !== undefined && configStateDir !== '') return configStateDir
  const home = process.env.DSH_HOME
  if (home !== undefined && home !== '') return join(home, 'state')
  return join(process.cwd(), '.dsh-guard-state')
}

/**
 * Resolve the repository directory the credential binds to: an explicit value
 * wins, then the process cwd.
 * @param configRepoDir - plugin/CLI-provided override, or ''/undefined.
 * @returns the repository directory.
 */
export function resolveRepoDir(configRepoDir: string | undefined): string {
  if (configRepoDir !== undefined && configRepoDir !== '') return configRepoDir
  return process.cwd()
}

/**
 * Files that look like bare-tsc emissions next to sources (real build output
 * goes to `lib/`). Swept into a checkpoint they pollute diffs forever after —
 * surfaced as a warning, never a refusal: a checkpoint's job is to preserve
 * work, including a dirty tree. This is deployment knowledge (the
 * harness/dsh-plugins monorepo layout); the git helper stays generic and
 * takes it as a parameter.
 */
export const SRC_ARTIFACT_PATTERN = /^packages\/[^/]+\/[^/]+\/src\/.+\.(?:js|d\.ts|js\.map|d\.ts\.map)$/
