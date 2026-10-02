/**
 * Human approval of one plan revision.
 *
 * The approval document is built here as pure data and handed to the host's
 * `approval` service by the apply tool (`commit_agent_apply_plan` → the
 * plugin's `requestPlanApproval` wiring). That matters for two reasons:
 *
 *  - the decision arrives through a host-owned protocol (`approval/request` →
 *    `approval/decided` on the agent's session log), so the model cannot
 *    fabricate it — unlike a "confirm" button the plugin would have to trust;
 *  - the document shown to the user is derived from the same content the
 *    approval digest covers, so what is approved is what is displayed.
 *
 * The full document travels in the transcript (the `commit_agent_prepare_plan`
 * tool call already presented it); the approval panel receives only the short
 * question as its reason, so the reviewer decides against the plan they just
 * read in chat.
 */
import type { PlanDeltaEntry, PlanVersion } from './types.js'
import { statusXy } from './types.js'

/** Maximum characters of the generated review document. */
const MAX_DETAIL_CHARS = 24_000
/** Maximum file rows listed per commit. */
const MAX_FILES_PER_COMMIT = 60

/** A plan rendered for human review. */
export interface PlanReview {
  readonly header: string
  readonly question: string
  readonly detail: string
  /** The option label that approves; every other option declines. */
  readonly approveLabel: string
  readonly declineLabel: string
}

/** Shorten a commit/tree oid for display. */
function shortOid(oid: string | null): string {
  return oid === null || oid === '' ? '(unborn)' : oid.slice(0, 12)
}

/** One human-readable line for a revision-delta entry. */
function describeDeltaEntry(entry: PlanDeltaEntry): string {
  const path = entry.path === undefined ? '' : `\`${entry.path}\``
  switch (entry.kind) {
    case 'commit-added':
      return `commit ${entry.commitId} is new`
    case 'file-added':
      return `${path} was added to commit ${entry.commitId}`
    case 'file-moved':
      return `${path} moved from commit ${entry.fromCommitId} to commit ${entry.commitId}`
    case 'file-excluded':
      return `${path} is now excluded${entry.fromCommitId === undefined ? '' : ` (was in commit ${entry.fromCommitId})`}`
    case 'message-changed':
      return `the message of commit ${entry.commitId} was reworded`
    default:
      return entry.kind
  }
}

/** Bound a document, marking the cut. */
function bound(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS)}\n\n… (truncated)`
}

/**
 * Render one plan revision as a review document.
 *
 * Deliberately deterministic: the same plan always produces the same text, so a
 * reviewer can compare revisions by eye. File-level rows come from the plan's
 * frozen `reviewDetail` (paths and stats captured at publish time), never from
 * re-reading the live worktree. Revisions stored before the detail existed
 * fall back to change ids with an explicit note.
 */
export function buildPlanReview(plan: PlanVersion): PlanReview {
  const lines: string[] = []
  const totalChanges = plan.commits.reduce((sum, commit) => sum + commit.changes.length, 0)
  const detail = plan.reviewDetail

  lines.push(`## Plan revision ${plan.revision} — ${plan.commits.length} commit(s), ${totalChanges} change(s)`)
  lines.push('')
  lines.push(`- **Worktree:** \`${plan.target.worktreePath}\``)
  lines.push(`- **Branch:** \`${plan.target.branch ?? '(detached)'}\``)
  lines.push(`- **HEAD:** \`${shortOid(plan.target.head)}\``)
  lines.push(`- **Index:** ${plan.indexStrategy === 'reuse-existing-index' ? 'reuses the staged content already in the index' : 'the index matches HEAD (all changes are unstaged/untracked)'}`)
  lines.push(`- **Plan id:** \`${plan.planId}\``)
  lines.push(`- **Content digest:** \`${plan.planDigest.slice(0, 16)}…\``)
  if (detail === undefined) {
    lines.push('- _File-level detail is unavailable for this revision (stored before review details existed)._')
  }
  // File rows below use git/VSCode status symbols in porcelain XY form: the
  // first slot is the staged (index) state, the second the unstaged
  // (worktree) state — `A` added, `M` modified, `D` deleted, `R` renamed,
  // `C` copied, `T` typechange, `U` unmerged, `?` untracked. Two records of
  // one partially staged path spell `MM`.
  if (detail !== undefined) {
    lines.push('')
    lines.push('_Status symbols: `XY` = staged/unstaged; A added · M modified · D deleted · R renamed · C copied · T typechange · U unmerged · ? untracked_')
  }
  lines.push('')

  for (const commit of plan.commits) {
    const subject = commit.message.split('\n')[0] ?? commit.message
    lines.push(`### ${commit.id} — ${subject}`)
    if (commit.rationale.trim() !== '') {
      lines.push('')
      lines.push(commit.rationale.trim())
    }
    if (commit.dependsOn.length > 0) {
      lines.push('')
      lines.push(`_Depends on:_ ${commit.dependsOn.join(', ')}`)
    }
    lines.push('')
    const commitDetail = detail?.commits.find((d) => d.id === commit.id)
    if (commitDetail !== undefined) {
      const stat = commitDetail.stat
      lines.push(`_Files: ${stat.files}, +${stat.additions}/-${stat.deletions}_`)
      lines.push('')
      const shown = commitDetail.changes.slice(0, MAX_FILES_PER_COMMIT)
      for (const change of shown) {
        const rename = change.oldPath === undefined ? '' : ` (from \`${change.oldPath}\`)`
        const kind = change.binary ? ' [binary]' : change.symlink ? ' [symlink]' : ''
        lines.push(`- \`${statusXy(change.status, change.layer)}\` ${change.path}${kind}${rename}`)
      }
      if (commitDetail.changes.length > shown.length) {
        lines.push(`- … and ${commitDetail.changes.length - shown.length} more`)
      }
    } else {
      const shown = commit.changes.slice(0, MAX_FILES_PER_COMMIT)
      for (const changeId of shown) lines.push(`- \`${changeId}\``)
      if (commit.changes.length > shown.length) {
        lines.push(`- … and ${commit.changes.length - shown.length} more`)
      }
    }
    if (commit.message.includes('\n')) {
      lines.push('')
      lines.push('```text')
      lines.push(commit.message)
      lines.push('```')
    }
    lines.push('')
  }

  if (plan.excludedChanges.length > 0) {
    lines.push('### Deliberately excluded')
    lines.push('')
    for (const excluded of plan.excludedChanges) {
      lines.push(`- \`${excluded.path}\` — ${excluded.reason}`)
    }
    lines.push('')
  }

  if (plan.delta !== undefined && plan.delta.entries.length > 0) {
    lines.push(`### Changes since revision ${plan.delta.fromRevision}`)
    lines.push('')
    const shown = plan.delta.entries.slice(0, MAX_FILES_PER_COMMIT)
    for (const entry of shown) lines.push(`- ${describeDeltaEntry(entry)}`)
    if (plan.delta.entries.length > shown.length) {
      lines.push(`- … and ${plan.delta.entries.length - shown.length} more`)
    }
    lines.push('')
  }

  if (plan.warnings.length > 0) {
    lines.push('### Warnings')
    lines.push('')
    for (const warning of plan.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(
    'Approving approves **exactly this revision and its content**. Any later plan revision revokes this approval, '
    + 'and the executor refuses to run if the repository no longer matches the snapshot this plan was built from.',
  )

  return {
    header: `Plan review · ${plan.commits.length} commit(s)`,
    question: plan.commits.length === 1
      ? 'Approve this plan and allow the executor to create 1 commit?'
      : `Approve this plan and allow the executor to create ${plan.commits.length} commits?`,
    detail: bound(lines.join('\n')),
    approveLabel: 'Approve',
    declineLabel: 'Keep planning',
  }
}
