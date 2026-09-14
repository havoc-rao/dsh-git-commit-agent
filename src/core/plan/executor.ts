/**
 * Approved-plan execution.
 *
 * This is the only code path in the plugin that writes to a real repository.
 * Its invariants:
 *
 *  1. Approval is bound to `(revision, planDigest)` and re-verified against the
 *     plan's *recomputed* digest — a model cannot forge it by editing state.
 *  2. The plan's snapshot must still match live repository state, content
 *     digests included, or nothing runs.
 *  3. Expected trees are recomputed immediately before execution; a mismatch
 *     aborts with nothing committed.
 *  4. Each commit group is staged with literal, single-path `update-index`
 *     calls and the real index tree is compared to the approved tree *before*
 *     `git commit` runs.
 *  5. HEAD is re-read after every commit attempt, including failures and
 *     cancellations, so an unexpected commit is recorded instead of retried.
 *  6. Nothing here ever resets the index, amends, pushes, skips hooks or
 *     rewrites history.
 */
import { GitCommitError } from '../errors.js'
import type { ChangeRecord, ExecutedCommit, ExecutionOutcome, ExecutionRecord, ExecutionResult, Snapshot } from '../types.js'
import { checkSnapshot, captureSnapshot, findChange } from '../git/snapshot.js'
import type { GitRunner } from '../git/runner.js'
import { materializePlan, stageChangeRecord } from './materialize.js'
import { computePlanDigest } from './digest.js'
import type { PlanVersion } from '../types.js'
import { worktreeLockKey, type WorktreeLock } from './lock.js'

/** Progress events emitted while a plan executes. */
export type ExecutionEvent =
  | { readonly type: 'verify-started' }
  | { readonly type: 'verify-passed' }
  | { readonly type: 'commit-staging'; readonly planCommitId: string; readonly index: number; readonly total: number }
  | { readonly type: 'commit-staged'; readonly planCommitId: string }
  | { readonly type: 'commit-created'; readonly planCommitId: string; readonly oid: string }
  | { readonly type: 'commit-failed'; readonly planCommitId: string; readonly message: string }
  | { readonly type: 'cancelled' }
  | { readonly type: 'reconciled'; readonly head: string | null; readonly note: string }

/** Input for {@link executeApprovedPlan}. */
export interface ExecutePlanInput {
  readonly runner: GitRunner
  readonly plan: PlanVersion
  readonly snapshot: Snapshot
  readonly lock: WorktreeLock
  readonly signal?: AbortSignal
  readonly onEvent?: (event: ExecutionEvent) => void
}

/** Verify that a plan carries a valid, matching approval for its current content. */
export function assertPlanApprovable(plan: PlanVersion): void {
  // Status is checked first so a plan whose approval was withdrawn or that went
  // stale reports that revocation rather than a generic "not approved".
  if (plan.status !== 'ready') {
    throw new GitCommitError('APPROVAL_REVOKED', `plan status is ${plan.status}, not ready`, {
      planId: plan.planId,
      revision: plan.revision,
      status: plan.status,
    })
  }
  if (plan.approval === null) {
    throw new GitCommitError('PLAN_NOT_APPROVED', 'this plan revision has not been approved', {
      planId: plan.planId,
      revision: plan.revision,
    })
  }
  if (plan.approval.revision !== plan.revision) {
    throw new GitCommitError('APPROVAL_MISMATCH', 'the approval belongs to a different plan revision', {
      planId: plan.planId,
      revision: plan.revision,
      approvedRevision: plan.approval.revision,
    })
  }
  const digest = computePlanDigest(plan)
  if (digest !== plan.planDigest) {
    throw new GitCommitError('APPROVAL_MISMATCH', 'the plan content changed after it was digested', {
      planId: plan.planId,
      revision: plan.revision,
    })
  }
  if (plan.approval.planDigest !== plan.planDigest) {
    throw new GitCommitError('APPROVAL_REVOKED', 'the approval does not match the current plan content', {
      planId: plan.planId,
      revision: plan.revision,
    })
  }
  if (plan.blockers.length > 0) {
    throw new GitCommitError('PLAN_INVALID', 'a plan with blockers cannot be executed', {
      planId: plan.planId,
      blockers: plan.blockers.map((b) => b.code),
    })
  }
}

/** Outcome for an execution that produced no commits before failing. */
function outcomeFor(executed: number, total: number, cancelled: boolean): ExecutionOutcome {
  if (cancelled && executed < total) return executed > 0 ? 'partial' : 'cancelled'
  if (executed === total) return 'completed'
  return executed > 0 ? 'partial' : 'failed'
}

/**
 * Execute an approved plan version against the real repository.
 *
 * @returns the exact result, including partial success and the reconciled HEAD.
 * @throws GitCommitError for pre-flight failures (nothing was committed).
 */
export async function executeApprovedPlan(input: ExecutePlanInput): Promise<ExecutionResult> {
  const { runner, plan, snapshot, lock, signal, onEvent } = input
  assertPlanApprovable(plan)

  const lockKey = worktreeLockKey(snapshot.repository.repositoryId, runner.topLevel)
  const release = await lock.acquire(lockKey, { owner: plan.agentSessionId ?? 'dsh-git-commit-agent' })
  const headBefore = snapshot.head.commit
  try {
    onEvent?.({ type: 'verify-started' })
    const check = await checkSnapshot(runner, snapshot, signal === undefined ? {} : { signal })
    if (check.headChanged || check.indexTreeChanged || check.changed.length > 0) {
      throw new GitCommitError('PLAN_STALE', 'the repository changed after the plan snapshot was taken', {
        planId: plan.planId,
        revision: plan.revision,
        changed: check.changed.slice(0, 50),
      })
    }

    const withSignal = signal === undefined ? {} : { signal }
    const materialized = await materializePlan({
      runner,
      snapshot,
      commits: plan.commits,
      indexStrategy: plan.indexStrategy,
      ...withSignal,
    })
    if (materialized.blockers.length > 0) {
      throw new GitCommitError('PLAN_INVALID', 'the plan could not be materialised for execution', {
        blockers: materialized.blockers.map((b) => ({ code: b.code, message: b.message })),
      })
    }
    for (let index = 0; index < plan.commits.length; index += 1) {
      const planned = plan.commits[index]
      const step = materialized.steps[index]
      if (planned === undefined || step === undefined) continue
      if (planned.expectedTree !== step.expectedTree) {
        throw new GitCommitError(
          'TREE_MISMATCH',
          `commit ${planned.id} would produce a different tree than the approved plan`,
          { planCommitId: planned.id, expected: planned.expectedTree, recomputed: step.expectedTree },
        )
      }
    }
    onEvent?.({ type: 'verify-passed' })

    const executed: ExecutedCommit[] = []
    let previousHead = headBefore
    let cancelled = false
    let failure: ExecutionRecord['failure'] | undefined

    for (let index = 0; index < plan.commits.length; index += 1) {
      const commit = plan.commits[index]
      if (commit === undefined) continue
      if (signal?.aborted === true) {
        cancelled = true
        onEvent?.({ type: 'cancelled' })
        break
      }
      onEvent?.({ type: 'commit-staging', planCommitId: commit.id, index, total: plan.commits.length })

      try {
        for (const changeId of commit.changes) {
          const record = findChange(snapshot, changeId)
          if (record === undefined) {
            throw new GitCommitError('PLAN_INVALID', `change ${changeId} is missing from the snapshot`, {
              planCommitId: commit.id,
            })
          }
          if (plan.indexStrategy === 'reuse-existing-index' && index === 0 && record.layer === 'index') continue
          await stageChangeRecord(runner, record, undefined, signal)
        }
      } catch (error) {
        const e = error instanceof GitCommitError ? error : new GitCommitError('GIT_FAILED', String(error))
        failure = { planCommitId: commit.id, stage: 'stage', code: e.code, message: e.message }
        onEvent?.({ type: 'commit-failed', planCommitId: commit.id, message: e.message })
        break
      }

      let realTree: string
      try {
        realTree = await runner.writeTree(undefined, signal)
      } catch (error) {
        const e = error instanceof GitCommitError ? error : new GitCommitError('GIT_FAILED', String(error))
        failure = { planCommitId: commit.id, stage: 'write-tree', code: e.code, message: e.message }
        break
      }
      if (realTree !== commit.expectedTree) {
        throw new GitCommitError(
          'TREE_MISMATCH',
          `the staged tree for commit ${commit.id} does not match the approved tree; nothing was committed`,
          { planCommitId: commit.id, expected: commit.expectedTree, actual: realTree, headAfter: previousHead },
        )
      }
      onEvent?.({ type: 'commit-staged', planCommitId: commit.id })

      let commitResult: { code: number; stdout: string; stderr: string }
      try {
        commitResult = await runner.commit(commit.message, signal)
      } catch (error) {
        // A cancelled/throwing commit may still have created a commit, so fall
        // through to reconciliation below with a synthetic failure result.
        const e = error instanceof GitCommitError ? error : new GitCommitError('GIT_FAILED', String(error))
        commitResult = { code: 1, stdout: '', stderr: e.message }
      }

      const newHead = await runner.revParseVerify('HEAD', signal)
      if (newHead === null || newHead === previousHead) {
        // No commit landed. Report the git error verbatim and stop.
        failure = {
          planCommitId: commit.id,
          stage: 'commit',
          code: 'GIT_COMMIT_FAILED',
          message: (commitResult.stderr || commitResult.stdout).trim().slice(0, 4000) || 'git commit produced no new commit',
        }
        onEvent?.({ type: 'commit-failed', planCommitId: commit.id, message: failure.message })
        previousHead = newHead ?? previousHead
        break
      }

      const parents = await runner.commitParents(newHead, signal)
      const actualTree = await runner.revParseTree('HEAD', signal)
      const parentOk = previousHead === null ? parents.length === 0 : parents[0] === previousHead
      const treeOk = actualTree === commit.expectedTree
      executed.push({
        planCommitId: commit.id,
        message: commit.message,
        oid: newHead,
        parent: parents[0] ?? null,
        tree: actualTree ?? '',
      })
      previousHead = newHead
      onEvent?.({ type: 'commit-created', planCommitId: commit.id, oid: newHead })

      if (!parentOk || !treeOk) {
        failure = {
          planCommitId: commit.id,
          stage: 'verify',
          code: 'COMMIT_UNEXPECTED',
          message: `the created commit ${newHead} does not match the approved plan (parentOk=${parentOk}, treeOk=${treeOk})`,
        }
        onEvent?.({ type: 'commit-failed', planCommitId: commit.id, message: failure.message })
        break
      }
      if (commitResult.code !== 0) {
        // The commit exists but git reported an error (e.g. a post-commit hook
        // failed). Record it and stop; never retry.
        failure = {
          planCommitId: commit.id,
          stage: 'post-commit',
          code: 'COMMIT_REPORTED_ERROR',
          message: (commitResult.stderr || commitResult.stdout).trim().slice(0, 4000),
        }
        onEvent?.({ type: 'commit-failed', planCommitId: commit.id, message: failure.message })
        break
      }
    }

    if (signal?.aborted === true && executed.length < plan.commits.length) cancelled = true
    const outcome = outcomeFor(executed.length, plan.commits.length, cancelled)

    const headAfter = await runner.revParseVerify('HEAD', signal)
    let remaining: ChangeRecord[] = []
    try {
      const after = await captureSnapshot(runner, { agreeingPasses: 1, ...(signal === undefined ? {} : { signal }) })
      remaining = [...after.entries]
    } catch {
      remaining = []
    }

    const result: ExecutionResult = {
      planId: plan.planId,
      revision: plan.revision,
      outcome,
      commits: executed,
      headBefore,
      headAfter,
      ...(failure === undefined ? {} : { failure }),
      remainingChanges: remaining,
    }
    return result
  } finally {
    await release()
  }
}

/** Reconciliation of a plan whose execution may have been interrupted. */
export interface ReconciliationResult {
  readonly landed: readonly ExecutedCommit[]
  readonly head: string | null
  readonly note: string
}

/**
 * Compare live history against a plan's expected trees without changing
 * anything. Used after a crash, a killed process or on resume: the plugin must
 * find out what actually landed before it is allowed to act again.
 */
export async function reconcilePlan(runner: GitRunner, plan: PlanVersion, signal?: AbortSignal): Promise<ReconciliationResult> {
  const head = await runner.revParseVerify('HEAD', signal)
  if (head === null) {
    return { landed: [], head, note: 'the repository has no commits' }
  }
  if (head === plan.target.head) {
    return { landed: [], head, note: 'HEAD is unchanged since the plan snapshot' }
  }
  const recent = await runner.recentCommits(plan.commits.length + 5, signal)
  const chronological = [...recent].reverse()
  const landed: ExecutedCommit[] = []
  for (let index = 0; index < plan.commits.length; index += 1) {
    const planned = plan.commits[index]
    if (planned === undefined) continue
    const match = chronological.find(
      (c, i) => c.tree === planned.expectedTree && chronological.slice(0, i).some(() => true),
    )
    if (match === undefined) continue
    const position = chronological.indexOf(match)
    const parent = match.parents[0] ?? null
    landed.push({
      planCommitId: planned.id,
      message: planned.message,
      oid: match.oid,
      parent,
      tree: match.tree,
    })
    if (position < 0) break
  }
  const note = landed.length === 0
    ? 'HEAD moved but no planned commit could be matched by tree'
    : `matched ${landed.length} of ${plan.commits.length} planned commit(s) in history`
  return { landed, head, note }
}
