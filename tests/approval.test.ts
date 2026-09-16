/**
 * Human-approval tests.
 *
 * The approval path is the security boundary between "the model proposed
 * something" and "this may be committed". These tests pin that:
 *  - the decision comes from the host's question surface, not from the model;
 *  - declining leaves the plan unapproved and the repository untouched;
 *  - approving one revision does not approve another;
 *  - without an approval surface the tool refuses instead of self-approving.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitCommitError } from '../src/core/errors.js'
import { buildPlanReview } from '../src/core/review.js'
import { CommitAgentService } from '../src/core/service.js'
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

/** Publish a one-commit plan for a new file and return its identity. */
async function publishOne(
  tools: readonly HostToolDefinition[],
  exec: HostToolRunContext,
): Promise<{ taskId: string; planId: string; revision: number; planDigest: string }> {
  const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
  const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string
  const published = (await toolNamed(tools, 'commit_agent_publish_plan').execute(
    { commits: [{ message: 'feat: add the thing', changes: [changeId] }] },
    exec,
  )) as Record<string, unknown>
  const plan = published['plan'] as Record<string, unknown>
  return {
    taskId: status['taskId'] as string,
    planId: plan['planId'] as string,
    revision: plan['revision'] as number,
    planDigest: plan['planDigest'] as string,
  }
}

test('an approved plan can be executed', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const { service, tools, prompts } = toolsWithAsker(fixture, () => ({ approved: true, selected: ['Approve'] }))
    const exec = execContext()
    const plan = await publishOne(tools, exec)

    const decision = (await toolNamed(tools, 'commit_agent_request_approval').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(decision['approved'], true)
    assert.equal(prompts.length, 1)
    // The prompt carries the plan document the digest covers, with the intent
    // labels the host requires.
    assert.ok(prompts[0]?.detail.includes('feat: add the thing'))
    assert.equal(prompts[0]?.approveLabel, 'Approve')

    const stored = await service.plansOf(plan.taskId)
    const approved = stored.find((p) => p.planId === plan.planId && p.revision === plan.revision)
    assert.equal(approved?.approval?.approvedBy, 'user:plan-review')

    const result = (await toolNamed(tools, 'commit_agent_execute_plan').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(result['outcome'], 'completed')
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
    const { tools } = toolsWithAsker(fixture, () => ({ approved: false, selected: ['Keep planning'] }))
    const exec = execContext()
    const plan = await publishOne(tools, exec)

    const decision = (await toolNamed(tools, 'commit_agent_request_approval').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(decision['approved'], false)
    assert.deepEqual(decision['selected'], ['Keep planning'])

    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_execute_plan').execute({ planId: plan.planId, revision: plan.revision }, exec)),
      (error: unknown) => error instanceof GitCommitError && error.code === 'PLAN_NOT_APPROVED',
    )
    assert.equal(git(fixture.root, ['rev-parse', 'HEAD']).trim(), headBefore)
  } finally {
    await fixture.cleanup()
  }
})

test('a free-text answer is not an approval', async () => {
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
    const plan = await publishOne(tools, exec)
    const decision = (await toolNamed(tools, 'commit_agent_request_approval').execute(
      { planId: plan.planId, revision: plan.revision },
      exec,
    )) as Record<string, unknown>
    assert.equal(decision['approved'], false)
    assert.equal(decision['custom'], 'looks fine, go ahead')
  } finally {
    await fixture.cleanup()
  }
})

test('approving an older revision after a newer one exists is refused', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    const { tools } = toolsWithAsker(fixture, () => ({ approved: true, selected: ['Approve'] }))
    const exec = execContext()
    const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
    const taskId = status['taskId'] as string
    const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string

    const first = (await toolNamed(tools, 'commit_agent_publish_plan').execute(
      { commits: [{ message: 'feat: first wording', changes: [changeId] }] },
      exec,
    )) as Record<string, unknown>
    const firstPlan = first['plan'] as Record<string, unknown>
    // Publish a second revision (same plan id, revision 2).
    await toolNamed(tools, 'commit_agent_publish_plan').execute(
      { commits: [{ message: 'feat: second wording', changes: [changeId] }] },
      exec,
    )

    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_request_approval').execute(
        { planId: firstPlan['planId'], revision: firstPlan['revision'] },
        exec,
      )),
      (error: unknown) => error instanceof GitCommitError && error.code === 'APPROVAL_REVOKED',
    )
    assert.ok(taskId.length > 0)
  } finally {
    await fixture.cleanup()
  }
})

test('a plan with blockers cannot be submitted for approval', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    await writeFile(fixture.root, 'b.txt', 'b\n')
    const { tools } = toolsWithAsker(fixture, () => ({ approved: true, selected: ['Approve'] }))
    const exec = execContext()
    const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
    const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string
    // Leave one change uncovered -> blocker.
    const published = (await toolNamed(tools, 'commit_agent_publish_plan').execute(
      { commits: [{ message: 'feat: partial', changes: [changeId] }] },
      exec,
    )) as Record<string, unknown>
    const plan = published['plan'] as Record<string, unknown>
    assert.ok((plan['blockers'] as unknown[]).length > 0)

    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_request_approval').execute(
        { planId: plan['planId'], revision: plan['revision'] },
        exec,
      )),
      (error: unknown) => error instanceof GitCommitError && error.code === 'PLAN_INVALID',
    )
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
    const plan = await publishOne(tools, exec)
    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_request_approval').execute(
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
    const published = (await toolNamed(tools, 'commit_agent_publish_plan').execute(
      {
        commits: [{ message: 'feat: add a', rationale: 'because a', changes: [entries[0]?.['changeId']] }],
        excludedChanges: [{ changeId: entries[1]?.['changeId'], reason: 'separate concern' }],
      },
      exec,
    )) as Record<string, unknown>
    const plan = published['plan'] as Record<string, unknown>
    const plans = await service.plansOf(status['taskId'] as string)
    const version = plans.find((p) => p.planId === plan['planId'])
    assert.ok(version)

    const review = buildPlanReview(version)
    assert.ok(review.detail.includes('feat: add a'))
    assert.ok(review.detail.includes('because a'))
    assert.ok(review.detail.includes('separate concern'))
    assert.ok(review.detail.includes(version.planDigest.slice(0, 16)))
    assert.equal(review.detail, buildPlanReview(version).detail, 'the review must be deterministic')
    assert.equal(review.approveLabel, 'Approve')
    assert.notEqual(review.declineLabel, review.approveLabel)
  } finally {
    await fixture.cleanup()
  }
})
