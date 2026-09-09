/**
 * Git helpers for the self-restart guard: the credential binds to the current
 * HEAD, checkpoints are real commits, and rollback is a hard reset. All calls
 * are synchronous child-process invocations scoped to the repo directory.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

/**
 * Porcelain entries for every tracked or untracked working-tree change.
 * `null` means git could not inspect the checkout; callers must fail closed.
 */
export function workingTreeChanges(repoDir: string): string[] | null {
  try {
    const out = execFileSync(
      'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' },
    )
    return out.split('\0').filter(entry => entry !== '')
  } catch {
    return null
  }
}

/** Whether the checkout has no staged, unstaged, or untracked changes. */
export function isWorkingTreeClean(repoDir: string): boolean {
  const changes = workingTreeChanges(repoDir)
  return changes !== null && changes.length === 0
}

/** Result of a checkpoint commit. */
export type CheckpointCommitResult =
  | { ok: true; sha: string; artifacts: string[]; createdCommit: boolean }
  | { ok: false; error: string }

/**
 * Record a clean HEAD directly, or commit the whole dirty working tree as an
 * explicitly approved checkpoint snapshot. Dirty commits use a temporary git
 * index: a hook/commit failure leaves the caller's real index untouched.
 * @param repoDir - repository directory.
 * @param message - checkpoint commit message.
 * @param artifactPattern - staged paths matching this are reported as
 * build-artifact-looking warnings (deployment-specific — see
 * SRC_ARTIFACT_PATTERN in defaults.ts; omit for none).
 * @returns the new HEAD sha, or a failure reason.
 */
export function commitCheckpoint(
  repoDir: string,
  message: string,
  artifactPattern?: RegExp,
  includeDirty = false,
): CheckpointCommitResult {
  let tempDir: string | undefined
  try {
    const changes = workingTreeChanges(repoDir)
    if (changes === null) return { ok: false, error: 'git checkpoint failed: working tree status is unavailable' }
    if (changes.length > 0 && !includeDirty) {
      const shown = changes.slice(0, 10).map(entry => `  ${entry}`).join('\n')
      const more = changes.length > 10 ? `\n  … (${changes.length - 10} more)` : ''
      return {
        ok: false,
        error: `checkpoint refused: working tree has ${changes.length} change(s); review them, then rerun with --include-dirty to commit the complete snapshot:\n${shown}${more}`,
      }
    }
    const previousHead = currentHead(repoDir)
    if (previousHead === null) return { ok: false, error: 'git checkpoint failed: current HEAD is unavailable' }
    if (changes.length === 0) return { ok: true, sha: previousHead, artifacts: [], createdCommit: false }

    const indexPathRaw = execFileSync('git', ['rev-parse', '--git-path', 'index'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim()
    const indexPath = resolve(repoDir, indexPathRaw)
    tempDir = mkdtempSync(join(tmpdir(), 'ankh-guard-index-'))
    const tempIndex = join(tempDir, 'index')
    copyFileSync(indexPath, tempIndex)
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex }
    execFileSync('git', ['add', '-A'], { cwd: repoDir, env, stdio: 'pipe' })
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repoDir, env, encoding: 'utf8' })
    const artifacts = artifactPattern === undefined
      ? []
      : staged.split('\n').filter(file => artifactPattern.test(file))
    execFileSync('git', ['commit', '-m', message], { cwd: repoDir, env, stdio: 'pipe' })
    const sha = currentHead(repoDir)
    if (sha === null) return { ok: false, error: 'checkpoint commit succeeded but HEAD became unreadable' }
    try {
      // The complete snapshot is now HEAD; make the real index match it. This
      // is the successful-path equivalent of the old `git add -A && commit`,
      // while the temporary index protected the failure path.
      execFileSync('git', ['reset', '--mixed', 'HEAD'], { cwd: repoDir, stdio: 'pipe' })
    } catch (error) {
      try { execFileSync('git', ['update-ref', 'HEAD', previousHead, sha], { cwd: repoDir, stdio: 'pipe' }) } catch { /* best effort */ }
      return { ok: false, error: `checkpoint commit could not settle the real index: ${String(error)}` }
    }
    return { ok: true, sha, artifacts, createdCommit: true }
  } catch (error) {
    return { ok: false, error: `git checkpoint failed: ${String(error)}` }
  } finally {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
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
