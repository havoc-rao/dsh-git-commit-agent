import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommitAgentService } from '../src/core/service.js'
import { createInitialisedFixture, writeFile } from './helpers/fixture.js'

test('workspace operation leases exclude edits and Git execution and release idempotently', async () => {
  const f = await createInitialisedFixture()
  try {
    await writeFile(f.root, 'a.txt', 'a\n')
    const service = new CommitAgentService({ dataDir: f.dataDir })
    const state = await service.openTask({ sourceSessionId: null, agentSessionId: 's', workspaceRoot: f.root })
    const published = await service.publishPlan(state.task.taskId, {
      commits: [{ message: 'add a', changes: [state.snapshot.entries.find(e => e.path === 'a.txt')!.changeId] }],
    })
    const plan = await service.approvePlan({ taskId: state.task.taskId, planId: published.plan.planId,
      revision: published.plan.revision, planDigest: published.plan.planDigest, requestId: 'r', approvedBy: 'user' })
    const release = service.acquireWorkspaceEdit(f.root)
    assert.equal(service.isWorkspaceBusy(f.root), true)
    assert.throws(() => service.acquireWorkspaceEdit(f.root), /in progress/)
    await assert.rejects(service.executePlan({ taskId: state.task.taskId, planId: plan.planId, revision: plan.revision }), /in progress/)
    release()
    release()
    assert.equal(service.isWorkspaceBusy(f.root), false)
    await service.invalidatePlansAfterEdit(state.task.taskId)
    const invalidated = (await service.plansOf(state.task.taskId))[0]!
    assert.equal(invalidated.status, 'stale')
    assert.equal(invalidated.approval, null)
    await assert.rejects(service.approvePlan({ taskId: state.task.taskId, planId: plan.planId,
      revision: plan.revision, planDigest: plan.planDigest, requestId: 'r-again', approvedBy: 'user' }), /invalidated/)
    await assert.rejects(service.executePlan({ taskId: state.task.taskId, planId: plan.planId, revision: plan.revision }))
    assert.equal(service.isWorkspaceBusy(f.root), false)
  } finally { await f.cleanup() }
})
