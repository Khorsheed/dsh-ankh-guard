/**
 * Local feedback board for the self-iteration flow: agents running this
 * plugin leave structured notes when the gate misbehaves (false deny/allow,
 * canary misjudgment, supervise anomalies, doc/behavior drift). The board is
 * a local loop inside one deployment — deliberately NOT an upstream feedback
 * channel; upstream issues belong on the project's issue tracker.
 *
 * Storage is a single append-only JSONL under the DSH_HOME runtime area
 * (`<home>/feedback/dsh-self-restart-guard.jsonl`, home = the state
 * directory's parent) — never the plugin install directory or the source
 * tree — capped at {@link MAX_FEEDBACK_ENTRIES} with the newest kept.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One board entry: timestamp, invoking command context, and the description. */
export interface FeedbackEntry {
  ts: number
  /** The invoking command context, e.g. the CLI verb that produced the anomaly. */
  command: string
  /** The reproducible, actionable problem description (no secrets or privacy). */
  description: string
  /** The checkout revision at the time of the report (optional). */
  revision?: string
}

/** Single-file cap; older entries roll off. */
export const MAX_FEEDBACK_ENTRIES = 200

const FILE = 'dsh-self-restart-guard.jsonl'

/** Absolute path of the feedback file (runtime area, sibling of the state dir). */
export function feedbackFile(stateDir: string): string {
  return join(dirname(stateDir), 'feedback', FILE)
}

/**
 * Append one entry (newest kept, capped by {@link MAX_FEEDBACK_ENTRIES}).
 * @param stateDir - the guard state directory (its parent is the runtime home).
 * @param entry - the structured record.
 * @returns whether the append rolled older entries off the cap.
 */
export function appendFeedback(stateDir: string, entry: FeedbackEntry): { rolled: boolean } {
  const file = feedbackFile(stateDir)
  mkdirSync(dirname(file), { recursive: true })
  const lines: string[] = []
  try {
    const raw = readFileSync(file, 'utf8')
    lines.push(...raw.split('\n').filter(line => line.trim() !== ''))
  } catch {
    // Absent or unreadable file: start fresh (an unreadable file fails loud
    // on the next append instead of being silently dropped).
  }
  lines.push(JSON.stringify(entry))
  const rolled = lines.length > MAX_FEEDBACK_ENTRIES
  const kept = rolled ? lines.slice(lines.length - MAX_FEEDBACK_ENTRIES) : lines
  writeFileSync(file, `${kept.join('\n')}\n`)
  return { rolled }
}

/**
 * Read the newest board entries.
 * @param stateDir - the guard state directory.
 * @param limit - how many of the newest entries to return.
 * @returns the entries, newest last.
 */
export function readFeedback(stateDir: string, limit = 50): FeedbackEntry[] {
  try {
    const raw = readFileSync(feedbackFile(stateDir), 'utf8')
    return raw
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as FeedbackEntry)
      .slice(-limit)
  } catch {
    return []
  }
}
