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
