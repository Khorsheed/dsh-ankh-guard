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
    // stdio 'pipe': without it a non-git directory forwards git's stderr
    // ("fatal: not a git repository…") into the host's log — expected states
    // must stay silent.
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** Result of a checkpoint commit. */
export type CheckpointCommitResult =
  | { ok: true; sha: string; artifacts: string[] }
  | { ok: false; error: string }

/**
 * Files that look like bare-tsc emissions next to sources (real build output
 * goes to `lib/`). Swept into a checkpoint they pollute diffs forever after —
 * surfaced as a warning, never a refusal: a checkpoint's job is to preserve
 * work, including a dirty tree.
 */
const SRC_ARTIFACT_PATTERN = /^packages\/[^/]+\/[^/]+\/src\/.+\.(?:js|d\.ts|js\.map|d\.ts\.map)$/

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
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repoDir, encoding: 'utf8' })
    const artifacts = staged.split('\n').filter(file => SRC_ARTIFACT_PATTERN.test(file))
    execFileSync('git', ['commit', '--allow-empty', '-m', message], { cwd: repoDir, stdio: 'pipe' })
    const sha = currentHead(repoDir)
    if (sha === null) return { ok: false, error: 'checkpoint commit succeeded but HEAD became unreadable' }
    return { ok: true, sha, artifacts }
  } catch (error) {
    return { ok: false, error: `git checkpoint failed: ${String(error)}` }
  }
}

/**
 * Roll the checkout back to a checkpoint commit WITHOUT losing work: the
 * discarded HEAD becomes a `guard-backup-*` branch, and uncommitted tracked
 * changes become a second `-wip` anchor commit (`git stash create` snapshots
 * the worktree without touching it; untracked files survive `reset --hard`
 * on their own). Every reset path — the watchdog, the CLI, the agent-facing
 * service — funnels through here, so recovery never depends on the reflog.
 * @param repoDir - repository directory.
 * @param sha - the checkpoint commit to reset to.
 * @returns success with the recovery anchor refs, or a failure reason.
 */
export function resetToCheckpoint(
  repoDir: string,
  sha: string,
): { ok: boolean; error?: string; anchors: string[] } {
  const anchors: string[] = []
  try {
    // 2026-08-15T07:46:27.297Z → 20260815-074627; the random suffix keeps
    // same-second resets from colliding on one branch name.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '')
    const anchor = `guard-backup-${stamp.slice(0, 8)}-${stamp.slice(8)}-${Math.random().toString(36).slice(2, 6)}`
    const head = currentHead(repoDir)
    if (head !== null && head !== sha) {
      try {
        execFileSync('git', ['branch', anchor, 'HEAD'], { cwd: repoDir, stdio: 'pipe' })
        anchors.push(anchor)
      } catch {
        // Best-effort: the anchor must never block the reset itself.
      }
    }
    // Unconditional even when head === sha: `reset --hard HEAD` still wipes
    // uncommitted tracked changes, so snapshot them first.
    let wip = ''
    try {
      wip = execFileSync('git', ['stash', 'create'], { cwd: repoDir, encoding: 'utf8' }).trim()
    } catch {
      // Not a usable worktree (bare repo etc.) — nothing to snapshot.
    }
    if (wip !== '') {
      try {
        execFileSync('git', ['branch', `${anchor}-wip`, wip], { cwd: repoDir, stdio: 'pipe' })
        anchors.push(`${anchor}-wip`)
      } catch {
        // Best-effort: the anchor must never block the reset itself.
      }
    }
    execFileSync('git', ['reset', '--hard', sha], { cwd: repoDir, stdio: 'pipe' })
    return { ok: true, anchors }
  } catch (error) {
    return { ok: false, error: `git reset --hard ${sha} failed: ${String(error)}`, anchors }
  }
}
