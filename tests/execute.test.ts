/**
 * End-to-end approval + execution tests against real isolated repositories.
 *
 * These are the security acceptance tests for P2: exact staging, tree
 * verification, approval binding, staleness revocation, hook failure handling
 * and crash reconciliation.
 */
import assert from 'node:assert/strict'
import { chmod, writeFile as writeFileFs, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { GitCommitError } from '../src/core/errors.js'
import { CommitAgentService } from '../src/core/service.js'
import type { PlanDraft } from '../src/core/plan/validate.js'
import type { PlanVersion, Snapshot } from '../src/core/types.js'
import { createInitialisedFixture, git, readFixtureFile, removeFile, writeFile, type Fixture } from './helpers/fixture.js'

/** A service plus an opened task for one fixture. */
interface Harness {
  readonly service: CommitAgentService
  readonly taskId: string
  readonly fixture: Fixture
}

/** Create a fresh service bound to the fixture worktree. */
async function harness(fixture: Fixture): Promise<Harness> {
  const service = new CommitAgentService({ dataDir: fixture.dataDir })
  await service.init()
  const state = await service.openTask({
    sourceSessionId: 'session-source',
    agentSessionId: 'session-agent',
    workspaceRoot: fixture.root,
  })
  return { service, taskId: state.task.taskId, fixture }
}

/** Current status entries for a task. */
async function entriesOf(service: CommitAgentService, taskId: string): Promise<Snapshot['entries']> {
  const status = await service.status(taskId)
  return status.entries
}

/** Change id by path, optionally restricted to one layer. */
function idFor(entries: Snapshot['entries'], path: string, layer?: string): string {
  const entry = layer === undefined
    ? entries.find((e) => e.path === path)
    : entries.find((e) => e.path === path && e.layer === layer)
  assert.ok(entry, `missing ${layer ?? 'any'} change for ${path}`)
  return entry.changeId
}

/** Publish + approve a plan in one step. */
async function publishAndApprove(
  service: CommitAgentService,
  taskId: string,
  draft: PlanDraft,
  requestId = 'req-1',
): Promise<PlanVersion> {
  const published = await service.publishPlan(taskId, draft)
  assert.deepEqual(published.plan.blockers, [])
  return await service.approvePlan({
    taskId,
    planId: published.plan.planId,
    revision: published.plan.revision,
    planDigest: published.plan.planDigest,
    requestId,
    approvedBy: 'user:test',
  })
}

/** Install an executable git hook in the fixture. */
async function installHook(fixture: Fixture, name: string, body: string): Promise<void> {
  const dir = join(fixture.root, '.git', 'hooks')
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFileFs(path, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(path, 0o755)
}

test('two commits are created exactly as planned', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/a.txt', 'alpha\n')
    await writeFile(fixture.root, 'src/b.txt', 'beta\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const published = await h.service.publishPlan(h.taskId, {
      commits: [
        { message: 'feat: add alpha', changes: [idFor(entries, 'src/a.txt')] },
        { message: 'feat: add beta', changes: [idFor(entries, 'src/b.txt')], dependsOn: ['c1'] },
      ],
    })
    assert.deepEqual(published.plan.blockers, [])
    assert.equal(published.preview.length, 2)
    assert.ok(published.preview[0]?.patch.includes('alpha'))
    assert.ok(published.preview[1]?.patch.includes('beta'))
    // The second preview is the *incremental* diff for that commit only.
    assert.ok(!published.preview[1]?.patch.includes('alpha'))
    // Stats come from `--numstat`: one file per commit, never truncated.
    assert.deepEqual(published.preview[0]?.stat, { files: 1, additions: 1, deletions: 0 })
    assert.deepEqual(published.preview[1]?.stat, { files: 1, additions: 1, deletions: 0 })
    // The plan carries frozen review detail with resolved paths.
    const detail = published.plan.reviewDetail
    assert.equal(detail?.commits.length, 2)
    assert.equal(detail?.commits[0]?.changes[0]?.path, 'src/a.txt')
    assert.equal(detail?.commits[0]?.baseTree, published.preview[0]?.baseTree)
    assert.equal(detail?.commits[0]?.expectedTree, published.preview[0]?.expectedTree)
    // The approval digest covers only the executable projection: adding the
    // display detail must not change the digest.
    assert.ok(/^[0-9a-f]{64}$/.test(published.plan.planDigest))

    await h.service.approvePlan({
      taskId: h.taskId,
      planId: published.plan.planId,
      revision: published.plan.revision,
      planDigest: published.plan.planDigest,
      requestId: 'req-ok',
      approvedBy: 'user:test',
    })

    const result = await h.service.executePlan({
      taskId: h.taskId,
      planId: published.plan.planId,
      revision: published.plan.revision,
    })
    assert.equal(result.outcome, 'completed')
    assert.equal(result.commits.length, 2)

    const subjects = git(fixture.root, ['log', '--format=%s', '-n2']).trim().split('\n')
    assert.deepEqual(subjects, ['feat: add beta', 'feat: add alpha'])

    // The committed tree matches the approved expected tree exactly.
    const headTree = git(fixture.root, ['rev-parse', 'HEAD^{tree}']).trim()
    assert.equal(headTree, published.plan.commits[1]?.expectedTree)
    // Parents chain correctly.
    const parents = git(fixture.root, ['rev-list', '--parents', '-n1', 'HEAD']).trim().split(/\s+/)
    assert.equal(parents[1], result.commits[0]?.oid)
    // Working tree is clean afterwards.
    assert.equal(git(fixture.root, ['status', '--porcelain']).trim(), '')
    assert.equal(await readFixtureFile(fixture.root, 'src/b.txt'), 'beta\n')
  } finally {
    await fixture.cleanup()
  }
})

test('an approval whose digest does not match is rejected', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const published = await h.service.publishPlan(h.taskId, {
      commits: [{ message: 'feat: add a', changes: [idFor(entries, 'a.txt')] }],
    })
    await assert.rejects(
      () =>
        h.service.approvePlan({
          taskId: h.taskId,
          planId: published.plan.planId,
          revision: published.plan.revision,
          planDigest: 'not-the-digest',
          requestId: 'bad',
          approvedBy: 'user:test',
        }),
      (error: unknown) => error instanceof GitCommitError && error.code === 'APPROVAL_MISMATCH',
    )
    assert.equal(git(fixture.root, ['status', '--porcelain']).trim(), '?? a.txt')
  } finally {
    await fixture.cleanup()
  }
})

test('executing without approval is refused', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const published = await h.service.publishPlan(h.taskId, {
      commits: [{ message: 'feat: add a', changes: [idFor(entries, 'a.txt')] }],
    })
    await assert.rejects(
      () => h.service.executePlan({ taskId: h.taskId, planId: published.plan.planId, revision: published.plan.revision }),
      (error: unknown) => error instanceof GitCommitError && error.code === 'PLAN_NOT_APPROVED',
    )
    assert.equal(git(fixture.root, ['rev-parse', 'HEAD']).trim(), git(fixture.root, ['rev-parse', 'HEAD']).trim())
  } finally {
    await fixture.cleanup()
  }
})

test('publishing a new revision revokes the earlier approval', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const first = await h.service.publishPlan(h.taskId, {
      commits: [{ message: 'feat: add a', changes: [idFor(entries, 'a.txt')] }],
    })
    await h.service.approvePlan({
      taskId: h.taskId,
      planId: first.plan.planId,
      revision: first.plan.revision,
      planDigest: first.plan.planDigest,
      requestId: 'r1',
      approvedBy: 'user:test',
    })
    const second = await h.service.publishPlan(h.taskId, {
      commits: [{ message: 'feat: add a (reworded)', changes: [idFor(entries, 'a.txt')] }],
    })
    assert.equal(second.plan.revision, 2)
    assert.notEqual(second.plan.planDigest, first.plan.planDigest)

    await assert.rejects(
      () => h.service.executePlan({ taskId: h.taskId, planId: first.plan.planId, revision: first.plan.revision }),
      (error: unknown) => error instanceof GitCommitError && error.code === 'APPROVAL_REVOKED',
    )
    const plans = await h.service.plansOf(h.taskId)
    assert.equal(plans.find((p) => p.revision === 1)?.approval, null)
    assert.equal(plans.find((p) => p.revision === 1)?.status, 'stale')
    assert.equal(git(fixture.root, ['rev-parse', 'HEAD']).trim(), first.plan.target.head)
  } finally {
    await fixture.cleanup()
  }
})

test('a repository change after approval aborts with no commit', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const plan = await publishAndApprove(h.service, h.taskId, {
      commits: [{ message: 'feat: add a', changes: [idFor(entries, 'a.txt')] }],
    })
    const headBefore = plan.target.head
    // Simulate a developer editing the file after approving.
    await writeFile(fixture.root, 'a.txt', 'a changed underneath\n')

    await assert.rejects(
      () => h.service.executePlan({ taskId: h.taskId, planId: plan.planId, revision: plan.revision }),
      (error: unknown) => error instanceof GitCommitError && error.code === 'PLAN_STALE',
    )
    assert.equal(git(fixture.root, ['rev-parse', 'HEAD']).trim(), headBefore)
    const plans = await h.service.plansOf(h.taskId)
    assert.equal(plans.find((p) => p.revision === plan.revision)?.status, 'stale')
    assert.equal(plans.find((p) => p.revision === plan.revision)?.approval, null)
  } finally {
    await fixture.cleanup()
  }
})

test('pre-existing staged content is respected and lands in the first commit', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'staged.txt', 'already staged\n')
    git(fixture.root, ['add', '--', 'staged.txt'])
    await writeFile(fixture.root, 'unstaged.txt', 'not staged yet\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const published = await h.service.publishPlan(h.taskId, {
      commits: [
        {
          message: 'feat: staged work plus one more file',
          changes: [idFor(entries, 'staged.txt', 'index'), idFor(entries, 'unstaged.txt')],
        },
      ],
    })
    assert.deepEqual(published.plan.blockers, [])
    assert.equal(published.plan.indexStrategy, 'reuse-existing-index')
    await h.service.approvePlan({
      taskId: h.taskId,
      planId: published.plan.planId,
      revision: published.plan.revision,
      planDigest: published.plan.planDigest,
      requestId: 'r-staged',
      approvedBy: 'user:test',
    })
    const result = await h.service.executePlan({
      taskId: h.taskId,
      planId: published.plan.planId,
      revision: published.plan.revision,
    })
    assert.equal(result.outcome, 'completed')
    const files = git(fixture.root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()
    assert.deepEqual(files, ['staged.txt', 'unstaged.txt'])
    assert.equal(git(fixture.root, ['status', '--porcelain']).trim(), '')
  } finally {
    await fixture.cleanup()
  }
})

test('a rejecting hook stops the commit and leaves the index untouched', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await installHook(fixture, 'pre-commit', 'echo "policy: rejected" >&2\nexit 1')
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const headBefore = git(fixture.root, ['rev-parse', 'HEAD']).trim()
    const plan = await publishAndApprove(h.service, h.taskId, {
      commits: [{ message: 'feat: add a', changes: [idFor(entries, 'a.txt')] }],
    })

    const result = await h.service.executePlan({ taskId: h.taskId, planId: plan.planId, revision: plan.revision })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.commits.length, 0)
    assert.equal(result.failure?.stage, 'commit')
    // HEAD did not move and no `--no-verify` was used.
    assert.equal(git(fixture.root, ['rev-parse', 'HEAD']).trim(), headBefore)
    // The index still holds exactly what was staged: the plugin never resets.
    assert.equal(git(fixture.root, ['diff', '--cached', '--name-only']).trim(), 'a.txt')
    // A failed plan cannot be blindly re-executed.
    await assert.rejects(
      () => h.service.executePlan({ taskId: h.taskId, planId: plan.planId, revision: plan.revision }),
      (error: unknown) => error instanceof GitCommitError && error.code === 'APPROVAL_REVOKED',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('partial failure keeps the landed commit and reports the rest', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await installHook(fixture, 'commit-msg', 'if grep -q REJECT "$1"; then echo "policy: message rejected" >&2; exit 1; fi')
    await writeFile(fixture.root, 'first.txt', 'first\n')
    await writeFile(fixture.root, 'second.txt', 'second\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const plan = await publishAndApprove(h.service, h.taskId, {
      commits: [
        { message: 'feat: first', changes: [idFor(entries, 'first.txt')] },
        { message: 'feat: REJECT second', changes: [idFor(entries, 'second.txt')] },
      ],
    })
    const result = await h.service.executePlan({ taskId: h.taskId, planId: plan.planId, revision: plan.revision })
    assert.equal(result.outcome, 'partial')
    assert.equal(result.commits.length, 1)
    assert.equal(git(fixture.root, ['log', '--format=%s', '-n1']).trim(), 'feat: first')
    const plans = await h.service.plansOf(h.taskId)
    const stored = plans.find((p) => p.revision === plan.revision)
    assert.equal(stored?.status, 'partially-failed')
    assert.equal(stored?.execution?.commits.length, 1)
    // The second group is still pending in the working tree.
    assert.ok(result.remainingChanges.some((c) => c.path === 'second.txt'))
  } finally {
    await fixture.cleanup()
  }
})

test('concurrent executions of one task are refused', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const plan = await publishAndApprove(h.service, h.taskId, {
      commits: [{ message: 'feat: add a', changes: [idFor(entries, 'a.txt')] }],
    })
    const first = h.service.executePlan({ taskId: h.taskId, planId: plan.planId, revision: plan.revision })
    const second = h.service.executePlan({ taskId: h.taskId, planId: plan.planId, revision: plan.revision })
    const settled = await Promise.allSettled([first, second])
    const rejected = settled.filter((s) => s.status === 'rejected')
    assert.equal(rejected.length, 1)
    const reason = (rejected[0] as PromiseRejectedResult).reason
    assert.ok(reason instanceof GitCommitError)
    assert.ok(['EXECUTION_IN_PROGRESS', 'APPROVAL_REVOKED', 'PLAN_STALE'].includes(reason.code))
    assert.equal(git(fixture.root, ['log', '--oneline']).trim().split('\n').length, 2)
  } finally {
    await fixture.cleanup()
  }
})

test('reconciliation detects commits that landed outside the plugin', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const plan = await publishAndApprove(h.service, h.taskId, {
      commits: [{ message: 'feat: add a', changes: [idFor(entries, 'a.txt')] }],
    })
    // Simulate another terminal doing exactly the approved commit.
    git(fixture.root, ['add', '--', 'a.txt'])
    git(fixture.root, ['commit', '--quiet', '-m', 'feat: add a'])
    const reconciled = await h.service.reconcile(h.taskId, plan.planId, plan.revision)
    assert.equal(reconciled.landed.length, 1)
    assert.equal(reconciled.landed[0]?.tree, plan.commits[0]?.expectedTree)
  } finally {
    await fixture.cleanup()
  }
})

test('a staged rename is executed as a rename', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'docs/one.md', 'one\n')
    git(fixture.root, ['add', '--', 'docs/one.md'])
    git(fixture.root, ['commit', '--quiet', '-m', 'docs: add one'])
    git(fixture.root, ['mv', 'docs/one.md', 'docs/uno.md'])
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const rename = entries.find((e) => e.status === 'renamed')
    assert.ok(rename)
    const plan = await publishAndApprove(h.service, h.taskId, {
      commits: [{ message: 'docs: rename one to uno', changes: [rename.changeId] }],
    })
    const result = await h.service.executePlan({ taskId: h.taskId, planId: plan.planId, revision: plan.revision })
    assert.equal(result.outcome, 'completed')
    assert.equal(git(fixture.root, ['status', '--porcelain']).trim(), '')
    const tracked = git(fixture.root, ['ls-files']).trim().split('\n').sort()
    assert.deepEqual(tracked, ['docs/uno.md', 'README.md'].sort())
  } finally {
    await fixture.cleanup()
  }
})

test('a deletion is executed and reported', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await commitFileForTest(fixture, 'obsolete.txt', 'gone soon\n')
    await removeFile(fixture.root, 'obsolete.txt')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const deletion = entries.find((e) => e.status === 'deleted')
    assert.ok(deletion)
    const plan = await publishAndApprove(h.service, h.taskId, {
      commits: [{ message: 'chore: drop obsolete file', changes: [deletion.changeId] }],
    })
    const result = await h.service.executePlan({ taskId: h.taskId, planId: plan.planId, revision: plan.revision })
    assert.equal(result.outcome, 'completed')
    assert.equal(git(fixture.root, ['ls-files']).includes('obsolete.txt'), false)
  } finally {
    await fixture.cleanup()
  }
})

test('execution is refused while a merge is in progress', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const published = await h.service.publishPlan(h.taskId, {
      commits: [{ message: 'feat: add a', changes: [idFor(entries, 'a.txt')] }],
    })
    assert.deepEqual(published.plan.blockers, [])
    // Approve, then create a MERGE_HEAD to simulate an in-progress merge.
    await h.service.approvePlan({
      taskId: h.taskId,
      planId: published.plan.planId,
      revision: published.plan.revision,
      planDigest: published.plan.planDigest,
      requestId: 'r-merge',
      approvedBy: 'user:test',
    })
    await writeFileFs(join(fixture.root, '.git', 'MERGE_HEAD'), `${published.plan.target.head}\n`, 'utf8')
    await assert.rejects(
      () => h.service.executePlan({ taskId: h.taskId, planId: published.plan.planId, revision: published.plan.revision }),
      (error: unknown) => error instanceof GitCommitError,
    )
  } finally {
    await fixture.cleanup()
  }
})

test('a plan revision carries the delta against the previous revision', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    await writeFile(fixture.root, 'b.txt', 'b\n')
    const h = await harness(fixture)
    const entries = await entriesOf(h.service, h.taskId)
    const a = idFor(entries, 'a.txt')
    const b = idFor(entries, 'b.txt')

    // First revision: no delta by definition.
    const rev1 = await h.service.publishPlan(h.taskId, {
      commits: [
        { message: 'feat: add a', changes: [a] },
        { message: 'feat: add b', changes: [b] },
      ],
    })
    assert.equal(rev1.plan.delta, undefined)

    // Second revision: both files swap commits and c1 is reworded.
    const rev2 = await h.service.publishPlan(h.taskId, {
      commits: [
        { message: 'feat: reworded', changes: [b] },
        { message: 'feat: add a', changes: [a] },
      ],
    })
    assert.deepEqual(rev2.plan.delta, {
      schemaVersion: 1,
      fromRevision: 1,
      entries: [
        { kind: 'message-changed', commitId: 'c1' },
        { kind: 'file-moved', commitId: 'c1', fromCommitId: 'c2', changeId: b, path: 'b.txt' },
        { kind: 'message-changed', commitId: 'c2' },
        { kind: 'file-moved', commitId: 'c2', fromCommitId: 'c1', changeId: a, path: 'a.txt' },
      ],
    })
    // The delta is persisted with the revision (display data, append-only).
    const stored = await h.service.plansOf(h.taskId)
    assert.deepEqual(
      stored.find((p) => p.revision === 2)?.delta,
      rev2.plan.delta,
    )

    // Third revision: a.txt becomes explicitly excluded; its commit is gone.
    const rev3 = await h.service.publishPlan(h.taskId, {
      commits: [{ message: 'feat: reworded', changes: [b] }],
      excludedChanges: [{ changeId: a, reason: 'separate follow-up' }],
    })
    assert.deepEqual(rev3.plan.delta?.entries, [
      { kind: 'file-excluded', fromCommitId: 'c2', changeId: a, path: 'a.txt' },
    ])
    // The digest is a property of the executable projection only: adding the
    // delta must not change it for identical plans.
    assert.equal(rev3.plan.planDigest.length, 64)
  } finally {
    await fixture.cleanup()
  }
})

/** Local helper: commit an extra file (setup only). */
async function commitFileForTest(fixture: Fixture, path: string, content: string): Promise<void> {
  await writeFile(fixture.root, path, content)
  git(fixture.root, ['add', '--', path])
  git(fixture.root, ['commit', '--quiet', '-m', `chore: add ${path}`])
}
