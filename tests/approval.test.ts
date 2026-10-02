/**
 * Human-approval tests.
 *
 * The approval path is the security boundary between "the model proposed
 * something" and "this may be committed". `commit_agent_apply_plan` is the
 * single place the model crosses it: the apply tool asks the host's approval
 * service (`approval/request` → `approval/decided`), and only an
 * `'allowed-once'` outcome records the approval and lets the executor run.
 * These tests pin that:
 *  - the decision comes from the host's approval service, not from the model,
 *    and the apply tool forwards tool identity (toolName + callId) with the
 *    prompt so the client can attach the panel to the exact tool call;
 *  - declining leaves the plan unapproved and the repository untouched;
 *  - a stale revision is refused BEFORE the user is asked;
 *  - without an approval surface the tool refuses instead of self-approving;
 *  - a repository change between prepare and apply fails closed after approval;
 *  - the host wiring (`requestPlanApproval`) maps every approval outcome to a
 *    closed `{ approved }` decision, fails closed without the service, and
 *    forwards the abort signal (an abort settles `'cancelled'`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitCommitError } from '../src/core/errors.js'
import { buildPlanReview } from '../src/core/review.js'
import { CommitAgentService } from '../src/core/service.js'
import type { PlanVersion } from '../src/core/types.js'
import { buildCommitAgentTools, type UserApprovalDecision, type UserApprovalPrompt } from '../src/host/tools.js'
import type { HostApprovalOutcome, HostApprovalService, HostToolDefinition, HostToolRunContext } from '../src/host/types.js'
import { requestPlanApproval } from '../src/index.js'
import { createInitialisedFixture, git, type Fixture } from './helpers/fixture.js'
import { writeFile } from './helpers/fixture.js'

/** Tool lookup by name. */
function toolNamed(tools: readonly HostToolDefinition[], name: string): HostToolDefinition {
  const tool = tools.find((t) => t.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

/** A fake tool execution context, optionally carrying the host call id. */
function execContext(sessionId = 'session-agent', callId?: string): HostToolRunContext {
  return {
    agent: { id: sessionId, session: { id: sessionId } },
    ...(callId === undefined ? {} : { callId }),
    signal: new AbortController().signal,
  }
}

/** Build tools with a scripted approval surface. */
function toolsWithAsker(
  fixture: Fixture,
  decide: (prompt: UserApprovalPrompt) => UserApprovalDecision,
): { service: CommitAgentService; tools: HostToolDefinition[]; prompts: UserApprovalPrompt[] } {
  const service = new CommitAgentService({ dataDir: fixture.dataDir })
  const prompts: UserApprovalPrompt[] = []
  const tools = buildCommitAgentTools({
    service,
    resolveWorkspace: async () => fixture.root,
    askUserApproval: async (prompt) => {
      prompts.push(prompt)
      return decide(prompt)
    },
  })
  return { service, tools, prompts }
}

/** Prepare a one-commit plan for a new file and return its identity. */
async function prepareOne(
  tools: readonly HostToolDefinition[],
  exec: HostToolRunContext,
): Promise<{ taskId: string; planId: string; revision: number; planDigest: string }> {
  const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
  const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string
  const prepared = (await toolNamed(tools, 'commit_agent_prepare_plan').execute(
    { commits: [{ message: 'feat: add the thing', changes: [changeId] }] },
    exec,
  )) as Record<string, unknown>
  const plan = prepared['plan'] as Record<string, unknown>
  return {
    taskId: status['taskId'] as string,
    planId: plan['planId'] as string,
    revision: plan['revision'] as number,
    planDigest: plan['planDigest'] as string,
  }
}

test('apply_plan asks the host once, records the approval and executes', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const { service, tools, prompts } = toolsWithAsker(fixture, () => ({ approved: true }))
    // The host execution carries a call id; the apply tool must forward it so
    // the client can attach the approval panel to the exact tool call.
    const exec = execContext('session-agent', 'call-1')
    const plan = await prepareOne(tools, exec)

    const result = (await toolNamed(tools, 'commit_agent_apply_plan').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(result['approved'], true)
    assert.equal(result['outcome'], 'completed')
    assert.equal(prompts.length, 1)
    // The prompt identifies the initiating tool and the exact call, and still
    // carries the plan document the digest covers (the host wiring decides
    // which parts reach the user; see `requestPlanApproval`).
    assert.equal(prompts[0]?.toolName, 'commit_agent_apply_plan')
    assert.equal(prompts[0]?.callId, 'call-1')
    assert.ok(prompts[0]?.detail.includes('feat: add the thing'))
    assert.ok(prompts[0]?.detail.includes('src/thing.ts'))
    assert.ok(prompts[0]?.detail.includes('+1/-0'))
    assert.equal(prompts[0]?.approveLabel, 'Approve')

    const stored = await service.plansOf(plan.taskId)
    const approved = stored.find((p) => p.planId === plan.planId && p.revision === plan.revision)
    assert.equal(approved?.approval?.approvedBy, 'user:approval')
    assert.equal(git(fixture.root, ['log', '--format=%s', '-n1']).trim(), 'feat: add the thing')
  } finally {
    await fixture.cleanup()
  }
})

test('declining leaves the plan unapproved and commits nothing', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const headBefore = git(fixture.root, ['rev-parse', 'HEAD']).trim()
    const { service, tools } = toolsWithAsker(fixture, () => ({ approved: false }))
    const exec = execContext()
    const plan = await prepareOne(tools, exec)

    const decision = (await toolNamed(tools, 'commit_agent_apply_plan').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(decision['approved'], false)
    // The approval channel has no option labels or free-text feedback: the
    // decision is the closed `{ approved }` shape only.
    assert.equal('selected' in decision, false)
    assert.equal('custom' in decision, false)

    // Nothing was approved and nothing was committed.
    const stored = await service.plansOf(plan.taskId)
    assert.equal(
      stored.find((p) => p.planId === plan.planId && p.revision === plan.revision)?.approval,
      null,
    )
    assert.equal(git(fixture.root, ['rev-parse', 'HEAD']).trim(), headBefore)
  } finally {
    await fixture.cleanup()
  }
})

test('a rejected answer is not an approval, and the model sees the outcome', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    // Every non-grant outcome (rejected / cancelled / unavailable) closes as
    // `{ approved: false }`; the tool must treat it exactly like a decline.
    const { tools } = toolsWithAsker(fixture, () => ({ approved: false }))
    const exec = execContext()
    const plan = await prepareOne(tools, exec)
    const decision = (await toolNamed(tools, 'commit_agent_apply_plan').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(decision['approved'], false)
    // The render projection must say so plainly, or the model could never
    // react to what actually happened.
    const rendered = toolNamed(tools, 'commit_agent_apply_plan').output.render({}, decision)
    const text = rendered.map((b) => b.text).join('\n')
    assert.match(text, /NOT approve/i)
  } finally {
    await fixture.cleanup()
  }
})

test('applying an older revision after a newer one exists is refused before asking', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const { tools, prompts } = toolsWithAsker(fixture, () => ({ approved: true }))
    const exec = execContext()
    const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
    const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string

    const first = (await toolNamed(tools, 'commit_agent_prepare_plan').execute(
      { commits: [{ message: 'feat: first wording', changes: [changeId] }] },
      exec,
    )) as Record<string, unknown>
    const firstPlan = first['plan'] as Record<string, unknown>
    // Prepare a second revision (same plan id, revision 2).
    await toolNamed(tools, 'commit_agent_prepare_plan').execute(
      { commits: [{ message: 'feat: second wording', changes: [changeId] }] },
      exec,
    )

    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_apply_plan').execute(
        { planId: firstPlan['planId'], revision: firstPlan['revision'] },
        exec,
      )),
      (error: unknown) => error instanceof GitCommitError && error.code === 'APPROVAL_REVOKED',
    )
    // The user was never asked: a stale revision cannot be approved, so showing
    // the review panel would only waste their time.
    assert.equal(prompts.length, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('a plan with blockers cannot be submitted for approval', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    await writeFile(fixture.root, 'b.txt', 'b\n')
    const { tools, prompts } = toolsWithAsker(fixture, () => ({ approved: true }))
    const exec = execContext()
    const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
    const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string
    // Leave one change uncovered -> blocker.
    const prepared = (await toolNamed(tools, 'commit_agent_prepare_plan').execute(
      { commits: [{ message: 'feat: partial', changes: [changeId] }] },
      exec,
    )) as Record<string, unknown>
    const plan = prepared['plan'] as Record<string, unknown>
    assert.ok((plan['blockers'] as unknown[]).length > 0)

    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_apply_plan').execute(
        { planId: plan['planId'], revision: plan['revision'] },
        exec,
      )),
      (error: unknown) => error instanceof GitCommitError && error.code === 'PLAN_INVALID',
    )
    assert.equal(prompts.length, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('without an approval surface the tool refuses instead of self-approving', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const tools = buildCommitAgentTools({ service, resolveWorkspace: async () => fixture.root })
    const exec = execContext()
    const plan = await prepareOne(tools, exec)
    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_apply_plan').execute(
        { planId: plan.planId, revision: plan.revision },
        exec,
      )),
      (error: unknown) => error instanceof GitCommitError && error.code === 'BAD_ARGUMENT',
    )
    const stored = await service.plansOf(plan.taskId)
    assert.equal(stored.find((p) => p.planId === plan.planId)?.approval, null)
  } finally {
    await fixture.cleanup()
  }
})

test('a repository change between prepare and apply fails closed after approval', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const { service, tools } = toolsWithAsker(fixture, () => ({ approved: true }))
    const exec = execContext()
    const plan = await prepareOne(tools, exec)
    const headBefore = git(fixture.root, ['rev-parse', 'HEAD']).trim()
    // The repository changes after the plan was bound to its snapshot.
    await writeFile(fixture.root, 'src/extra.ts', 'export const extra = 1\n')

    // The user approved, but the plan can no longer be applied safely: the
    // executor refuses and the plan loses its approval.
    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_apply_plan').execute(
        { planId: plan.planId, revision: plan.revision },
        exec,
      )),
      (error: unknown) => error instanceof GitCommitError && error.code === 'PLAN_STALE',
    )
    assert.equal(git(fixture.root, ['rev-parse', 'HEAD']).trim(), headBefore)
    const stored = await service.plansOf(plan.taskId)
    const version = stored.find((p) => p.planId === plan.planId && p.revision === plan.revision)
    assert.equal(version?.status, 'stale')
    assert.equal(version?.approval, null, 'a plan that can no longer be applied is not approved')
  } finally {
    await fixture.cleanup()
  }
})

test('the review document is deterministic and carries the digest and exclusions', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    await writeFile(fixture.root, 'b.txt', 'b\n')
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const tools = buildCommitAgentTools({ service, resolveWorkspace: async () => fixture.root })
    const exec = execContext()
    const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
    const entries = status['changes'] as Array<Record<string, unknown>>
    const prepared = (await toolNamed(tools, 'commit_agent_prepare_plan').execute(
      {
        commits: [{ message: 'feat: add a', rationale: 'because a', changes: [entries[0]?.['changeId']] }],
        excludedChanges: [{ changeId: entries[1]?.['changeId'], reason: 'separate concern' }],
      },
      exec,
    )) as Record<string, unknown>
    const plan = prepared['plan'] as Record<string, unknown>
    const plans = await service.plansOf(status['taskId'] as string)
    const version = plans.find((p) => p.planId === plan['planId'])
    assert.ok(version)

    const review = buildPlanReview(version)
    assert.ok(review.detail.includes('feat: add a'))
    assert.ok(review.detail.includes('because a'))
    assert.ok(review.detail.includes('separate concern'))
    assert.ok(review.detail.includes(version.planDigest.slice(0, 16)))
    // The file list comes from the frozen review detail: paths plus the
    // git/VSCode status symbol in porcelain XY form, and the never-truncated
    // stat — not content-addressed change ids. An untracked file renders `??`.
    assert.ok(review.detail.includes('a.txt'))
    assert.ok(review.detail.includes('??` a.txt'))
    assert.ok(review.detail.includes('_Status symbols: `XY`'))
    assert.ok(review.detail.includes('_Files: 1, +1/-0_'))
    assert.ok(!review.detail.includes(entries[0]?.['changeId'] as string))
    assert.equal(review.detail, buildPlanReview(version).detail, 'the review must be deterministic')
    assert.equal(review.approveLabel, 'Approve')
    assert.notEqual(review.declineLabel, review.approveLabel)
  } finally {
    await fixture.cleanup()
  }
})

test('a pre-upgrade plan without review detail falls back to change ids with a note', async () => {
  // A plan stored before the review-detail field existed has no paths. The
  // review must degrade explicitly instead of silently pretending.
  const legacy: PlanVersion = {
    schemaVersion: 1,
    planId: 'plan-legacy',
    revision: 1,
    taskId: 'task-1',
    sourceSessionId: null,
    agentSessionId: null,
    target: {
      repositoryId: 'repo',
      worktreePath: '/worktree',
      branch: 'main',
      head: '0123456789abcdef',
    },
    snapshotId: 'snap-1',
    indexStrategy: 'index-empty-whole-file',
    commits: [
      {
        id: 'c1',
        message: 'feat: legacy',
        rationale: '',
        dependsOn: [],
        changes: ['change-id-without-path'],
        expectedTree: 'abcdef0123456789',
      },
    ],
    excludedChanges: [],
    blockers: [],
    warnings: [],
    planDigest: 'd'.repeat(64),
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    approval: null,
    execution: null,
  }
  const review = buildPlanReview(legacy)
  assert.ok(review.detail.includes('change-id-without-path'))
  assert.ok(review.detail.includes('unavailable'))
})

test('the review document shows what changed since the previous revision', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const tools = buildCommitAgentTools({ service, resolveWorkspace: async () => fixture.root })
    const exec = execContext()
    const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
    const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string
    await toolNamed(tools, 'commit_agent_prepare_plan').execute(
      { commits: [{ message: 'feat: first wording', changes: [changeId] }] },
      exec,
    )
    const second = (await toolNamed(tools, 'commit_agent_prepare_plan').execute(
      { commits: [{ message: 'feat: better wording', changes: [changeId] }] },
      exec,
    )) as Record<string, unknown>
    const plan = second['plan'] as Record<string, unknown>
    const plans = await service.plansOf(status['taskId'] as string)
    const version = plans.find((p) => p.planId === plan['planId'] && p.revision === plan['revision'])
    assert.ok(version)
    const review = buildPlanReview(version)
    assert.ok(review.detail.includes('Changes since revision 1'))
    assert.ok(review.detail.includes('was reworded'))
    assert.ok(review.detail.includes('src/thing.ts'))
  } finally {
    await fixture.cleanup()
  }
})
/** One approval prompt as the apply tool would assemble it. */
function planApprovalPrompt(overrides: Partial<UserApprovalPrompt> = {}): UserApprovalPrompt {
  return {
    header: 'Plan review · 1 commit(s)',
    question: 'Approve this plan and allow the executor to create 1 commit?',
    detail: '## Plan revision 1 — 1 commit(s), 1 change(s)\n\n- `M` src/thing.ts\n',
    approveLabel: 'Approve',
    declineLabel: 'Keep planning',
    toolName: 'commit_agent_apply_plan',
    callId: 'call-1',
    agent: { id: 'session-git-commit-1', session: { id: 'session-git-commit-1' } },
    ...overrides,
  }
}

/** A recording fake of `ctx.get('approval')`. */
function fakeApproval(
  request: (req: Parameters<HostApprovalService['request']>[0]) => Promise<HostApprovalOutcome> | HostApprovalOutcome,
): { service: HostApprovalService; requests: Parameters<HostApprovalService['request']>[0][] } {
  const requests: Parameters<HostApprovalService['request']>[0][] = []
  return {
    service: {
      request(req) {
        requests.push(req)
        return Promise.resolve(request(req))
      },
    },
    requests,
  }
}

test('requestPlanApproval asks the approval service and maps allowed-once to approved', async () => {
  const approval = fakeApproval(() => 'allowed-once')
  const prompt = planApprovalPrompt()
  const decision = await requestPlanApproval(approval.service, prompt)
  assert.deepEqual(decision, { approved: true })

  // The request carries the initiating tool, the exact call id, the calling
  // agent and the abort signal, so the client can attach the ApprovalPanel to
  // the tool call and abort settles 'cancelled'.
  assert.equal(approval.requests.length, 1)
  const seen = approval.requests[0]
  assert.ok(seen)
  assert.equal(seen.agent, prompt.agent)
  assert.equal(seen.toolName, 'commit_agent_apply_plan')
  assert.equal(seen.callId, 'call-1')
  assert.equal(seen.reason, prompt.question)
  // Localized presentation copy: Chinese is the primary UI copy, the English
  // question stays as the fallback and as the persisted audit reason.
  assert.ok(seen.displayReason)
  assert.equal(seen.displayReason['en'], 'Approve this plan and allow the executor to create 1 commit?')
  assert.equal(seen.displayReason['zh'], '批准该提交计划并允许执行器创建 1 个提交？')
  assert.equal(seen.signal, prompt.signal)
})

test('requestPlanApproval maps every non-grant outcome to approved:false', async () => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
    const approval = fakeApproval(() => outcome)
    const decision = await requestPlanApproval(approval.service, planApprovalPrompt())
    assert.deepEqual(decision, { approved: false }, `${outcome} must close as not approved`)
  }
})

test('requestPlanApproval fails closed without an approval service or calling agent', async () => {
  await assert.rejects(
    () => requestPlanApproval(undefined, planApprovalPrompt()),
    (error: unknown) => error instanceof GitCommitError && error.code === 'BAD_ARGUMENT',
  )
  // A service-shaped value without request() is as unavailable as none.
  await assert.rejects(
    () => requestPlanApproval({} as HostApprovalService, planApprovalPrompt()),
    (error: unknown) => error instanceof GitCommitError && error.code === 'BAD_ARGUMENT',
  )
  // The host service requires the exact live agent; without one nothing is asked.
  await assert.rejects(
    () => requestPlanApproval({ request: async () => 'allowed-once' }, planApprovalPrompt({ agent: undefined })),
    (error: unknown) => error instanceof GitCommitError && error.code === 'BAD_ARGUMENT',
  )
})

test('requestPlanApproval forwards the abort signal: an aborted ask settles cancelled→false', async () => {
  // The service settles 'cancelled' immediately when the signal is already
  // aborted (user-approval/src/index.ts:269); the wiring must map that to
  // `{ approved: false }` and pass the request signal through untouched.
  const controller = new AbortController()
  controller.abort()
  const approval = fakeApproval((req) => (req.signal?.aborted === true ? 'cancelled' : 'allowed-once'))
  const prompt = planApprovalPrompt({ signal: controller.signal })
  const decision = await requestPlanApproval(approval.service, prompt)
  assert.deepEqual(decision, { approved: false })
  assert.equal(approval.requests[0]?.signal, controller.signal)
})

test('requestPlanApproval propagates a service failure (for example an idle-turn refusal) without approving', async () => {
  // ApprovalService.request throws when no turn is open
  // (user-approval/src/index.ts:215-223). The tool path always runs inside a
  // turn, but a host-side failure must still surface as a coded error instead
  // of silently degrading to an approval.
  const approval = fakeApproval(() => {
    throw new Error('approval.request() outside an open turn: the audit pair must be turn-enclosed')
  })
  await assert.rejects(
    () => requestPlanApproval(approval.service, planApprovalPrompt()),
    (error: unknown) => error instanceof GitCommitError && error.code === 'INTERNAL',
  )
})
