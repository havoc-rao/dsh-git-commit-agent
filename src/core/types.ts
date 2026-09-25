/**
 * Domain model for the Git commit agent.
 *
 * The shapes here are the *host-owned* truth: a snapshot describes repository
 * reality at one instant, a plan version describes one exact proposed set of
 * commits, and an execution record is the append-only account of what actually
 * ran. Nothing in this file is model-authored state.
 */

/** Which of the three change layers a record comes from. */
export type ChangeLayer = 'index' | 'worktree' | 'untracked'

/** Normalised change status (porcelain-v2 XY collapsed to one label). */
export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'unmerged'
  | 'untracked'
  | 'unknown'

/**
 * One-letter git/VSCode status symbol for a change status (the character
 * VSCode's source-control decorations show next to a file). `untracked`
 * renders as `?` (git's own glyph); `unknown` as `!`.
 */
export function statusSymbol(status: ChangeStatus): string {
  switch (status) {
    case 'added': return 'A'
    case 'modified': return 'M'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'typechange': return 'T'
    case 'unmerged': return 'U'
    case 'untracked': return '?'
    case 'unknown': return '!'
  }
}

/**
 * The same change in porcelain-v1 XY form: the first slot is the **index**
 * (staged) state, the second the **worktree** (unstaged) state. An index
 * record renders `M `, a worktree record ` M` and an untracked record `??` —
 * so two records of one partially staged path spell `MM` side by side,
 * exactly like `git status --porcelain`.
 */
export function statusXy(status: ChangeStatus, layer: ChangeLayer): string {
  const symbol = statusSymbol(status)
  if (layer === 'untracked') return '??'
  if (layer === 'index') return `${symbol} `
  return ` ${symbol}`
}

/** File mode before/after, as git's 6-digit octal strings. */
export interface ChangeMode {
  old?: string
  new?: string
}

/**
 * One file-level pending change.
 *
 * `changeId` is content-addressed: it combines layer, status, paths, mode and
 * the content digest, so editing a file changes its id and therefore
 * invalidates any plan that referenced the old content.
 */
export interface ChangeRecord {
  readonly changeId: string
  readonly layer: ChangeLayer
  readonly status: ChangeStatus
  /** Current path (new path for renames/copies). Repo-relative, `/`-separated. */
  readonly path: string
  /** Source path for renames/copies. */
  readonly oldPath?: string
  readonly mode?: ChangeMode
  readonly binary: boolean
  readonly submodule: boolean
  readonly symlink: boolean
  /** sha256 hex of the bytes this change represents (contents or deletion token). */
  readonly contentDigest: string
  /** Blob oid in the repository, when the content exists as a blob. */
  readonly blobOid?: string
  readonly sizeBytes?: number
  /**
   * True when this path is staged AND the worktree copy differs from the
   * staged copy (porcelain `MM`/`AM` style). The index variant and the
   * worktree variant are then two separate records.
   */
  readonly partiallyStaged: boolean
  /**
   * True when the other layer holds no differing content for this path
   * (porcelain `M.` / `.M`), so staging the whole file reproduces this record
   * exactly. False for partially staged paths.
   */
  readonly worktreeMatchesIndex: boolean
}

/** Stable identity of the git repository/worktree a task is bound to. */
export interface RepositoryIdentity {
  /** Directory the plugin runs git in (may be a linked worktree). */
  readonly workspaceRoot: string
  /** `git rev-parse --show-toplevel`. */
  readonly topLevel: string
  readonly gitDir: string
  readonly commonDir: string
  readonly isLinkedWorktree: boolean
  /** Stable id derived from the common dir (shared by all worktrees). */
  readonly repositoryId: string
}

/** HEAD facts captured with a snapshot. */
export interface SnapshotHead {
  /** Full commit oid, or `null` when the branch is unborn. */
  readonly commit: string | null
  readonly branch: string | null
  readonly unborn: boolean
  readonly detached: boolean
}

/** In-progress git operations that make automated staging unsafe. */
export interface RepositoryOperationState {
  readonly merge: boolean
  readonly rebase: boolean
  readonly cherryPick: boolean
  readonly revert: boolean
  readonly bisect: boolean
  readonly unmergedEntries: number
}

/** Immutable snapshot of repository state at one instant. */
export interface Snapshot {
  readonly schemaVersion: 1
  readonly snapshotId: string
  readonly repository: RepositoryIdentity
  readonly head: SnapshotHead
  /** Tree oid of the real index. */
  readonly indexTree: string
  /** True when the index tree equals HEAD's tree (no user staging). */
  readonly indexEmpty: boolean
  /** Digest over the full normalised status, for staleness checks. */
  readonly statusDigest: string
  readonly entries: readonly ChangeRecord[]
  readonly operationState: RepositoryOperationState
  readonly capturedAt: string
}

/** How the executor treats the user's pre-existing index. */
export type IndexStrategy = 'index-empty-whole-file' | 'reuse-existing-index'

/** One commit in a plan version. */
export interface PlannedCommit {
  readonly id: string
  readonly message: string
  readonly rationale: string
  readonly dependsOn: readonly string[]
  readonly changes: readonly string[]
  /** Tree oid this commit must produce; filled by materialisation. */
  readonly expectedTree: string
}

/** One file-level change frozen into a plan revision (human-readable review data). */
export interface PlanChangeDetail {
  readonly changeId: string
  readonly path: string
  readonly oldPath?: string
  readonly layer: ChangeLayer
  readonly status: ChangeStatus
  readonly binary: boolean
  readonly symlink: boolean
}

/** Authoritative diff stat between two trees (from `--numstat`, never truncated). */
export interface DiffStat {
  readonly files: number
  readonly additions: number
  readonly deletions: number
}

/**
 * Frozen, human-readable detail of one planned commit.
 *
 * Unlike {@link PlannedCommit.changes} (change ids only), this resolves every
 * change to its path/layer/status as captured in the snapshot the plan was
 * built from, and pins the exact base→expected tree pair plus the full diff
 * stat. It is display data, not executable content: the approval digest covers
 * the plan's executable projection only.
 */
export interface PlanCommitDetail {
  readonly id: string
  readonly message: string
  readonly rationale: string
  readonly dependsOn: readonly string[]
  readonly changes: readonly PlanChangeDetail[]
  readonly baseTree: string
  readonly expectedTree: string
  readonly stat: DiffStat
}

/**
 * Frozen review detail of a plan revision.
 *
 * Stored with every new {@link PlanVersion} so the transcript card, the tool
 * text projection and the approval document can all render the same paths and
 * stats without re-reading a snapshot that may no longer exist. Revisions
 * stored before this field existed carry no detail; consumers fall back to
 * change ids and must state that the detailed preview is unavailable.
 */
export interface PlanReviewDetail {
  readonly schemaVersion: 1
  readonly commits: readonly PlanCommitDetail[]
}

/** One entry of a revision-to-revision comparison (display data only). */
export type PlanDeltaKind =
  /** A commit id that did not exist in the previous revision. */
  | 'commit-added'
  /** A change that was not part of the previous revision. */
  | 'file-added'
  /** A change that moved from one commit to another. */
  | 'file-moved'
  /** A change that was planned before and is now explicitly excluded. */
  | 'file-excluded'
  /** The same commit id now carries a different message subject. */
  | 'message-changed'

/** One change between a previous plan revision and the current one. */
export interface PlanDeltaEntry {
  readonly kind: PlanDeltaKind
  /** The current-revision commit involved (target commit for moves/adds). */
  readonly commitId?: string
  /** The previous-revision commit a moved change came from. */
  readonly fromCommitId?: string
  readonly changeId?: string
  readonly path?: string
}

/**
 * What changed since the previous revision of the same plan, computed by the
 * host from the frozen review details of both revisions. Display data only —
 * the approval digest covers only the executable projection, never this.
 */
export interface PlanRevisionDelta {
  readonly schemaVersion: 1
  readonly fromRevision: number
  readonly entries: readonly PlanDeltaEntry[]
}

/** A change deliberately left out of the plan, with a reason. */
export interface ExcludedChange {
  readonly changeId: string
  readonly path: string
  readonly reason: string
}

/** Target binding of a plan (frozen at proposal time). */
export interface PlanTarget {
  readonly repositoryId: string
  readonly worktreePath: string
  readonly branch: string | null
  readonly head: string | null
}

/** A blocker prevents a plan from ever being approved for execution. */
export interface PlanBlocker {
  readonly code: string
  readonly message: string
  /** Plan commit id or change id the blocker refers to, when scoped. */
  readonly subject?: string
}

/** Approval binds a specific revision AND its content digest. */
export interface PlanApproval {
  readonly approvedAt: string
  /** Identity asserted by the host (never by the model). */
  readonly approvedBy: string
  readonly revision: number
  readonly planDigest: string
  readonly requestId: string
}

export type PlanStatus =
  | 'draft'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'partially-failed'
  | 'failed'
  | 'cancelled'
  | 'stale'

/** One commit that actually landed. */
export interface ExecutedCommit {
  readonly planCommitId: string
  readonly message: string
  readonly oid: string
  readonly parent: string | null
  readonly tree: string
}

export type ExecutionOutcome = 'completed' | 'partial' | 'failed' | 'cancelled' | 'reconciled'

/** Append-only account of one execution attempt. */
export interface ExecutionRecord {
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly outcome: ExecutionOutcome | null
  readonly headBefore: string | null
  readonly headAfter: string | null
  readonly commits: readonly ExecutedCommit[]
  readonly failure?: {
    readonly planCommitId: string | null
    readonly stage: string
    readonly code: string
    readonly message: string
  }
  /** Set when the executor had to reconcile after an abnormal exit. */
  readonly reconciliation?: string
}

/** One immutable version of a plan. */
export interface PlanVersion {
  readonly schemaVersion: 1
  readonly planId: string
  readonly revision: number
  readonly taskId: string
  readonly sourceSessionId: string | null
  readonly agentSessionId: string | null
  readonly target: PlanTarget
  readonly snapshotId: string
  readonly indexStrategy: IndexStrategy
  readonly commits: readonly PlannedCommit[]
  readonly excludedChanges: readonly ExcludedChange[]
  readonly blockers: readonly PlanBlocker[]
  readonly warnings: readonly string[]
  /** sha256 over the executable content of this version (approval binding). */
  readonly planDigest: string
  readonly status: PlanStatus
  readonly createdAt: string
  readonly approval: PlanApproval | null
  readonly execution: ExecutionRecord | null
  /**
   * Frozen human-readable review detail (paths, stats, trees per commit).
   * Absent for revisions stored before this field existed.
   */
  readonly reviewDetail?: PlanReviewDetail
  /**
   * What changed since the previous revision of this plan (display data).
   * Absent when this is the first revision or the previous one predates
   * review details.
   */
  readonly delta?: PlanRevisionDelta
}

/** A task groups every plan version for one (source session, worktree). */
export interface CommitTask {
  readonly taskId: string
  readonly sourceSessionId: string | null
  readonly agentSessionId: string | null
  readonly target: PlanTarget
  readonly createdAt: string
  readonly updatedAt: string
  /** Latest revision number; `0` when no plan has been published. */
  readonly latestRevision: number
  readonly status: 'open' | 'closed'
}

/** Result of an execution attempt, returned to the tool/user. */
export interface ExecutionResult {
  readonly planId: string
  readonly revision: number
  readonly outcome: ExecutionOutcome
  readonly commits: readonly ExecutedCommit[]
  readonly headBefore: string | null
  readonly headAfter: string | null
  readonly failure?: ExecutionRecord['failure']
  readonly reconciliation?: string
  readonly remainingChanges: readonly ChangeRecord[]
}
