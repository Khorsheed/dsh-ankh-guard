/**
 * Git helpers for the self-restart guard: the credential binds to the current
 * HEAD, checkpoints are real commits, and rollback is a hard reset. All calls
 * are synchronous child-process invocations scoped to the repo directory.
 */
import { execFileSync } from 'node:child_process'

/**
 * The repository's current HEAD, or null when the directory is not inside a
 * git repository (or git itself is unavailable).
 * @param repoDir - repository directory.
 * @returns the full HEAD sha, or null.
 */
export function currentHead(repoDir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** Result of a checkpoint commit. */
export type CheckpointCommitResult =
  | { ok: true; sha: string }
  | { ok: false; error: string }

/**
 * Commit the whole working tree as a checkpoint snapshot (empty commits
 * allowed — a clean tree still records a rollback point).
 * @param repoDir - repository directory.
 * @param message - checkpoint commit message.
 * @returns the new HEAD sha, or a failure reason.
 */
export function commitCheckpoint(repoDir: string, message: string): CheckpointCommitResult {
  try {
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '--allow-empty', '-m', message], { cwd: repoDir, stdio: 'pipe' })
    const sha = currentHead(repoDir)
    if (sha === null) return { ok: false, error: 'checkpoint commit succeeded but HEAD became unreadable' }
    return { ok: true, sha }
  } catch (error) {
    return { ok: false, error: `git checkpoint failed: ${String(error)}` }
  }
}

/**
 * Roll the checkout back to a checkpoint commit (discards everything after it).
 * @param repoDir - repository directory.
 * @param sha - the checkpoint commit to reset to.
 * @returns success or a failure reason.
 */
export function resetToCheckpoint(repoDir: string, sha: string): { ok: boolean; error?: string } {
  try {
    execFileSync('git', ['reset', '--hard', sha], { cwd: repoDir, stdio: 'pipe' })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `git reset --hard ${sha} failed: ${String(error)}` }
  }
}
