/** Bridge from commit-agent tool requests to the host approval service. */
import { GitCommitError, asGitCommitError } from '../core/errors.js'
import type { UserApprovalDecision, UserApprovalPrompt } from './tools.js'
import type { HostApprovalOutcome, HostApprovalService } from './types.js'

/** The English plan-approval question for a single-commit plan (`src/core/review.ts`). */
const APPROVE_QUESTION_SINGLE = 'Approve this plan and allow the executor to create 1 commit?'

/** Chinese presentation of the generated plan-approval question. */
function approvalQuestionZh(question: string): string {
  if (question === APPROVE_QUESTION_SINGLE) {
    return '批准该提交计划并允许执行器创建 1 个提交？'
  }
  const many = /^Approve this plan and allow the executor to create (\d+) commits\?$/.exec(question)
  return many === null ? question : `批准该提交计划并允许执行器创建 ${many[1]} 个提交？`
}

/**
 * Ask the host's `approval` service for one plan-approval decision.
 *
 * This is the single place the plugin crosses into the standard approval
 * channel (`approval/request` → `approval/decided` on the agent's session log,
 * rendered client-side by the host's ui-approval ApprovalPanel). It replaces
 * the old user-questions `plan-review` call: the decision now travels as an
 * approval event and only `ctx.get('approval').request()` produces it.
 *
 * Design notes, all verified against the host sources:
 *
 * - `detail` carries the frozen plan revision's Markdown to the approval panel;
 *   `reason` stays short and `displayReason` supplies localized question copy.
 *   Hosts without Markdown approval-detail support show only the question;
 *   the prepare tool's transcript card remains available on those hosts.
 * - The audit pair must be turn-enclosed (`user-approval/src/index.ts:84-92`):
 *   the `approval/asked` + `approval/decided` events are only durable inside an
 *   open turn. The ONLY caller of this function is the `commit_agent_apply_plan`
 *   tool, whose execution always runs inside the model's turn, so the
 *   precondition holds. The business API (`api.approvePlan`) never goes through
 *   this path — it is a programmatic entry for other host integrations.
 * - Failing closed: a host without the service, a non-function service, or an
 *   execution without a calling agent rejects with a coded error before
 *   anything is asked; every outcome except `'allowed-once'` maps to
 *   `{ approved: false }`.
 *
 * @param approval - the live `ctx.get('approval')` value (may be absent).
 * @param prompt - the approval prompt assembled by the apply tool.
 * @returns the closed decision the apply tool consumes.
 */
export async function requestPlanApproval(
  approval: HostApprovalService | undefined,
  prompt: UserApprovalPrompt,
): Promise<UserApprovalDecision> {
  if (approval === undefined || typeof approval.request !== 'function') {
    throw new GitCommitError(
      'BAD_ARGUMENT',
      'this host has no approval service, so an interactive approval cannot be requested; '
      + 'approve through the business API instead',
    )
  }
  if (prompt.agent === undefined) {
    throw new GitCommitError(
      'BAD_ARGUMENT',
      'the approval service requires the calling agent, which is missing from this tool execution',
    )
  }
  let outcome: HostApprovalOutcome
  try {
    outcome = await approval.request({
      agent: prompt.agent,
      toolName: prompt.toolName,
      ...(prompt.callId === undefined ? {} : { callId: prompt.callId }),
      // The audit events persist `reason` verbatim; the client shows
      // `displayReason` (localized) when present. Chinese is the primary
      // presentation copy; the English question stays as the stable audit text.
      reason: prompt.question,
      detail: prompt.detail,
      displayReason: { en: prompt.question, zh: approvalQuestionZh(prompt.question) },
      ...(prompt.signal === undefined ? {} : { signal: prompt.signal }),
    })
  } catch (error) {
    // A service failure (for example the idle-turn refusal) must fail the ask
    // closed as a coded error; the tool boundary normalizes it for the model.
    throw asGitCommitError(error)
  }
  return { approved: outcome === 'allowed-once' }
}
