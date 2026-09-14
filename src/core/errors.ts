/**
 * Error taxonomy for the Git commit agent core.
 *
 * Every failure the model or the user can act on carries a stable `code` so
 * the tool layer, the plan service and the executor can map it to an
 * actionable message instead of leaking a raw SIGKILL/stderr string.
 */

/** Stable machine-readable failure codes. */
export type GitCommitErrorCode =
  | 'GIT_NOT_FOUND'
  | 'NOT_A_REPOSITORY'
  | 'GIT_FAILED'
  | 'GIT_TIMEOUT'
  | 'BAD_ARGUMENT'
  | 'UNSAFE_ARGUMENT'
  | 'PATH_ESCAPES_REPOSITORY'
  | 'SNAPSHOT_STALE'
  | 'SNAPSHOT_UNSTABLE'
  | 'REPOSITORY_BUSY'
  | 'UNSUPPORTED_REPOSITORY_STATE'
  | 'UNSUPPORTED_INDEX_STATE'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_STALE'
  | 'PLAN_INVALID'
  | 'PLAN_NOT_APPROVED'
  | 'APPROVAL_MISMATCH'
  | 'APPROVAL_REVOKED'
  | 'EXECUTION_IN_PROGRESS'
  | 'EXECUTION_CONFLICT'
  | 'TREE_MISMATCH'
  | 'COMMIT_UNEXPECTED'
  | 'BUDGET_EXCEEDED'
  | 'DATA_DIR_UNAVAILABLE'
  | 'CANCELLED'
  | 'INTERNAL'

/** Base class: a coded, non-retryable-by-default failure. */
export class GitCommitError extends Error {
  readonly code: GitCommitErrorCode
  /** Additional machine-readable detail (never contains secrets). */
  readonly detail: Record<string, unknown>

  constructor(code: GitCommitErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'GitCommitError'
    this.code = code
    this.detail = detail
  }

  /** Canonical JSON value safe to put in a tool result. */
  toJSON(): { code: GitCommitErrorCode; message: string; detail: Record<string, unknown> } {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}

/** True when `v` is a {@link GitCommitError}. */
export function isGitCommitError(v: unknown): v is GitCommitError {
  return v instanceof GitCommitError
}

/** Normalise an unknown thrown value into a {@link GitCommitError}. */
export function asGitCommitError(v: unknown, fallbackCode: GitCommitErrorCode = 'INTERNAL'): GitCommitError {
  if (isGitCommitError(v)) return v
  const message = v instanceof Error ? v.message : String(v)
  return new GitCommitError(fallbackCode, message)
}
