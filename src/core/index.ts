/**
 * Public core surface: everything host-agnostic and directly testable.
 */
export * from './errors.js'
export * from './types.js'
export { GitRunner, sha256Hex, isAttributeNoOpinion } from './git/runner.js'
export type { GitResult, GitExecOptions, RawStatusEntry, PathAttributes } from './git/runner.js'
export { captureSnapshot, checkSnapshot, findChange, sameSnapshotState, repositoryIdentity, assertSafeRepoPath } from './git/snapshot.js'
export type { CaptureOptions, SnapshotCheck } from './git/snapshot.js'
export { CommitAgentStore } from './store/store.js'
export type { StoredTask } from './store/store.js'
export { DEFAULT_VALIDATION_LIMITS, normalizeAndValidatePlan, commitIdForIndex, assertNoBlockers } from './plan/validate.js'
export type { PlanDraft, PlanDraftCommit, ValidationOutcome, ValidationLimits } from './plan/validate.js'
export { materializePlan, stageChangeRecord, treeDiff } from './plan/materialize.js'
export type { MaterializeInput, MaterializeResult, MaterializedStep } from './plan/materialize.js'
export { WorktreeLock, worktreeLockKey } from './plan/lock.js'
export type { LockRecord, AcquireOptions } from './plan/lock.js'
export { assertPlanApprovable, executeApprovedPlan, reconcilePlan } from './plan/executor.js'
export type { ExecutePlanInput, ExecutionEvent, ReconciliationResult } from './plan/executor.js'
export { canonicalJson, computePlanDigest, digestInputOf } from './plan/digest.js'
export { CommitAgentService, defaultDataDir } from './service.js'
export type {
  ServiceOptions,
  TaskState,
  PublishPlanResult,
  PlanPreviewBlock,
  ReadContextResult,
} from './service.js'
