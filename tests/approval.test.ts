/**
 * Human-approval tests.
 *
 * The approval path is the security boundary between "the model proposed
 * something" and "this may be committed". `commit_agent_apply_plan` is the
 * single place the model crosses it: the host shows the plan in its own
 * plan-review panel, records the decision, and only then may the executor run.
 * These tests pin that:
 *  - the decision comes from the host's question surface, not from the model;
 *  - declining leaves the plan unapproved and the repository untouched, and the
 *    user's free-text feedback reaches the model;
 *  - a stale revision is refused BEFORE the user is asked;
 *  - without an approval surface the tool refuses instead of self-approving;
 *  - a repository change between prepare and apply fails closed after approval.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitCommitError } from '../src/core/errors.js'
import { buildPlanReview } from '../src/core/review.js'
import { CommitAgentService } from '../src/core/service.js'
import type { PlanVersion } from '../src/core/types.js'
import { buildCommitAgentTools, type UserApprovalDecision, type UserApprovalPrompt } from '../src/host/tools.js'
import type { HostToolDefinition, HostToolRunContext } from '../src/host/types.js'
import { createInitialisedFixture, git, type Fixture } from './helpers/fixture.js'
import { writeFile } from './helpers/fixture.js'

/** Tool lookup by name. */
function toolNamed(tools: readonly HostToolDefinition[], name: string): HostToolDefinition {
  const tool = tools.find((t) => t.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

/** A fake tool execution context. */
function execContext(sessionId = 'session-agent'): HostToolRunContext {
  return { agent: { id: sessionId, session: { id: sessionId } }, signal: new AbortController().signal }
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

test('apply_plan asks the user once, records the approval and executes', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const { service, tools, prompts } = toolsWithAsker(fixture, () => ({ approved: true, selected: ['Approve'] }))
    const exec = execContext()
    const plan = await prepareOne(tools, exec)

    const result = (await toolNamed(tools, 'commit_agent_apply_plan').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(result['approved'], true)
    assert.equal(result['outcome'], 'completed')
    assert.equal(prompts.length, 1)
    // The prompt carries the plan document the digest covers, with the intent
    // labels the host requires. The file list is rendered from the plan's
    // frozen review detail: a path, not a content-addressed change id.
    assert.ok(prompts[0]?.detail.includes('feat: add the thing'))
    assert.ok(prompts[0]?.detail.includes('src/thing.ts'))
    assert.ok(prompts[0]?.detail.includes('+1/-0'))
    assert.equal(prompts[0]?.approveLabel, 'Approve')

    const stored = await service.plansOf(plan.taskId)
    const approved = stored.find((p) => p.planId === plan.planId && p.revision === plan.revision)
    assert.equal(approved?.approval?.approvedBy, 'user:plan-review')
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
    const { service, tools } = toolsWithAsker(fixture, () => ({ approved: false, selected: ['Keep planning'] }))
    const exec = execContext()
    const plan = await prepareOne(tools, exec)

    const decision = (await toolNamed(tools, 'commit_agent_apply_plan').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(decision['approved'], false)
    assert.deepEqual(decision['selected'], ['Keep planning'])

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

test('a free-text answer is not an approval, and the model sees the feedback', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    // A UI may return custom text with no selected option, or an unrelated label.
    const { tools } = toolsWithAsker(fixture, () => ({
      approved: false,
      selected: [],
      custom: 'looks fine, go ahead',
    }))
    const exec = execContext()
    const plan = await prepareOne(tools, exec)
    const decision = (await toolNamed(tools, 'commit_agent_apply_plan').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(decision['approved'], false)
    assert.equal(decision['custom'], 'looks fine, go ahead')
    // The render projection must carry the free text, or the model could never
    // react to the user's actual words.
    const rendered = toolNamed(tools, 'commit_agent_apply_plan').output.render({}, decision)
    const text = rendered.map((b) => b.text).join('\n')
    assert.match(text, /looks fine, go ahead/)
    assert.match(text, /NOT approve/i)
  } finally {
    await fixture.cleanup()
  }
})

test('applying an older revision after a newer one exists is refused before asking', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const { tools, prompts } = toolsWithAsker(fixture, () => ({ approved: true, selected: ['Approve'] }))
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
    const { tools, prompts } = toolsWithAsker(fixture, () => ({ approved: true, selected: ['Approve'] }))
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
    const { service, tools } = toolsWithAsker(fixture, () => ({ approved: true, selected: ['Approve'] }))
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