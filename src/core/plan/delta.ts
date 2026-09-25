/**
 * Revision-to-revision plan comparison.
 *
 * A new revision revokes the approval of every earlier one, so the human who
 * reviews again wants to know *what changed* — a file moved between commits,
 * a message reworded, something newly excluded. The comparison is pure data
 * over the frozen review details of both revisions: no git calls, no live
 * worktree reads, fully deterministic.
 *
 * The result rides on the new {@link PlanVersion.delta} as display data only;
 * the approval digest never covers it.
 */
import type { ExcludedChange, PlanDeltaEntry, PlanDeltaKind, PlanRevisionDelta } from '../types.js'

/** The earlier revision, as the comparison needs it. */
export interface DeltaPrevious {
  readonly revision: number
  readonly commits: readonly { readonly id: string; readonly message: string; readonly changes: readonly string[] }[]
  readonly excludedChanges: readonly ExcludedChange[]
}

/** The current revision, as the comparison needs it. */
export interface DeltaCurrent {
  readonly commits: readonly { readonly id: string; readonly message: string; readonly changes: readonly string[] }[]
  readonly excludedChanges: readonly ExcludedChange[]
  /** changeId → path, from the frozen review detail (or the snapshot). */
  readonly pathOf: (changeId: string) => string | undefined
}

/**
 * Compare the current revision against an earlier one of the same plan.
 *
 * Commits are compared by id (c1…cn). Entries are produced in a stable order:
 * per current commit (in plan order), commit/message changes first, then
 * per-change moves/adds; finally per-change exclusions of previously planned
 * changes.
 */
export function computePlanDelta(previous: DeltaPrevious | null, current: DeltaCurrent): PlanRevisionDelta | null {
  if (previous === null) return null

  const entries: PlanDeltaEntry[] = []
  // changeId → previous commit id
  const prevChangeCommit = new Map<string, string>()
  for (const commit of previous.commits) {
    for (const changeId of commit.changes) prevChangeCommit.set(changeId, commit.id)
  }
  const prevSubjects = new Map(previous.commits.map((c) => [c.id, c.message.split('\n')[0] ?? '']))

  const push = (kind: PlanDeltaKind, entry: Omit<PlanDeltaEntry, 'kind'>): void => {
    entries.push({ kind, ...entry })
  }

  for (const commit of current.commits) {
    const subject = commit.message.split('\n')[0] ?? ''
    if (!prevSubjects.has(commit.id)) {
      // A brand-new commit id: every change of it is either new or moved.
      push('commit-added', { commitId: commit.id })
      for (const changeId of commit.changes) {
        const from = prevChangeCommit.get(changeId)
        if (from !== undefined && from !== commit.id) {
          push('file-moved', { commitId: commit.id, fromCommitId: from, changeId, path: current.pathOf(changeId) })
        } else if (from === undefined) {
          push('file-added', { commitId: commit.id, changeId, path: current.pathOf(changeId) })
        }
      }
      continue
    }
    if (prevSubjects.get(commit.id) !== subject) {
      push('message-changed', { commitId: commit.id })
    }
    for (const changeId of commit.changes) {
      const from = prevChangeCommit.get(changeId)
      if (from === undefined) {
        push('file-added', { commitId: commit.id, changeId, path: current.pathOf(changeId) })
      } else if (from !== commit.id) {
        push('file-moved', { commitId: commit.id, fromCommitId: from, changeId, path: current.pathOf(changeId) })
      }
    }
  }

  // Changes that were planned before and are now explicitly excluded.
  const prevChangeIds = [...prevChangeCommit.keys()]
  for (const changeId of prevChangeIds) {
    const inCurrent = current.commits.some((c) => c.changes.includes(changeId))
    if (inCurrent) continue
    const excluded = current.excludedChanges.find((e) => e.changeId === changeId)
    if (excluded === undefined) continue
    push('file-excluded', {
      fromCommitId: prevChangeCommit.get(changeId),
      changeId,
      path: excluded.path !== '' ? excluded.path : current.pathOf(changeId),
    })
  }

  if (entries.length === 0) return null
  return { schemaVersion: 1, fromRevision: previous.revision, entries }
}