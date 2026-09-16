/**
 * Plan validation tests: the rules that decide whether a model-proposed
 * grouping is expressible by the v1 executor.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitRunner } from '../src/core/git/runner.js'
import { captureSnapshot } from '../src/core/git/snapshot.js'
import { materializePlan } from '../src/core/plan/materialize.js'
import { normalizeAndValidatePlan } from '../src/core/plan/validate.js'
import type { IndexStrategy, Snapshot } from '../src/core/types.js'
import { createInitialisedFixture, git, writeFile } from './helpers/fixture.js'

/** Build a snapshot plus a path/layer lookup for one fixture state. */
async function snapshotOf(root: string): Promise<{ runner: GitRunner; snapshot: Snapshot }> {
  const runner = await GitRunner.open(root)
  const snapshot = await captureSnapshot(runner)
  return { runner, snapshot }
}

/** Change id for a given path, optionally restricted to one layer. */
function changeIdOf(snapshot: Snapshot, path: string, layer?: string): string {
  const entry = layer === undefined
    ? snapshot.entries.find((e) => e.path === path)
    : snapshot.entries.find((e) => e.path === path && e.layer === layer)
  assert.ok(entry, `no ${layer ?? 'any'} change for ${path}: ${JSON.stringify(snapshot.entries.map((e) => [e.layer, e.path]))}`)
  return entry.changeId
}

/** Strategy implied by a snapshot. */
function strategyOf(snapshot: Snapshot): IndexStrategy {
  return snapshot.indexEmpty ? 'index-empty-whole-file' : 'reuse-existing-index'
}

test('a complete single-commit plan validates and materials a tree', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const { runner, snapshot } = await snapshotOf(fixture.root)
    const outcome = normalizeAndValidatePlan(
      snapshot,
      { commits: [{ message: 'feat: add a', changes: [changeIdOf(snapshot, 'a.txt')] }] },
      { indexStrategy: strategyOf(snapshot) },
    )
    assert.deepEqual(outcome.blockers, [])
    const materialized = await materializePlan({
      runner,
      snapshot,
      commits: outcome.normalized.commits,
      indexStrategy: strategyOf(snapshot),
    })
    assert.deepEqual(materialized.blockers, [])
    assert.match(materialized.commits[0]?.expectedTree ?? '', /^[0-9a-f]{40,64}$/)
    assert.notEqual(materialized.commits[0]?.expectedTree, materialized.baseTree)
  } finally {
    await fixture.cleanup()
  }
})

test('an uncovered change blocks the plan', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    await writeFile(fixture.root, 'b.txt', 'b\n')
    const { snapshot } = await snapshotOf(fixture.root)
    const outcome = normalizeAndValidatePlan(
      snapshot,
      { commits: [{ message: 'feat: add a', changes: [changeIdOf(snapshot, 'a.txt')] }] },
      { indexStrategy: strategyOf(snapshot) },
    )
    assert.ok(outcome.blockers.some((b) => b.code === 'UNCOVERED_CHANGE'))
  } finally {
    await fixture.cleanup()
  }
})

test('explicitly excluded changes with a reason are accepted', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    await writeFile(fixture.root, 'b.txt', 'b\n')
    const { snapshot } = await snapshotOf(fixture.root)
    const outcome = normalizeAndValidatePlan(
      snapshot,
      {
        commits: [{ message: 'feat: add a', changes: [changeIdOf(snapshot, 'a.txt')] }],
        excludedChanges: [{ changeId: changeIdOf(snapshot, 'b.txt'), reason: 'belongs to a separate change' }],
      },
      { indexStrategy: strategyOf(snapshot) },
    )
    assert.deepEqual(outcome.blockers, [])
    assert.equal(outcome.normalized.excluded.length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('an exclusion without a reason blocks the plan', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'b.txt', 'b\n')
    const { snapshot } = await snapshotOf(fixture.root)
    const outcome = normalizeAndValidatePlan(
      snapshot,
      {
        commits: [{ message: 'chore: nothing', changes: [] }],
        excludedChanges: [{ changeId: changeIdOf(snapshot, 'b.txt'), reason: '   ' }],
      },
      { indexStrategy: strategyOf(snapshot) },
    )
    assert.ok(outcome.blockers.some((b) => b.code === 'MISSING_EXCLUSION_REASON'))
    assert.ok(outcome.blockers.some((b) => b.code === 'EMPTY_COMMIT'))
  } finally {
    await fixture.cleanup()
  }
})

test('duplicate and unknown change references are rejected', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const { snapshot } = await snapshotOf(fixture.root)
    const id = changeIdOf(snapshot, 'a.txt')
    const outcome = normalizeAndValidatePlan(
      snapshot,
      {
        commits: [
          { message: 'one', changes: [id] },
          { message: 'two', changes: [id, 'deadbeef'] },
        ],
      },
      { indexStrategy: strategyOf(snapshot) },
    )
    assert.ok(outcome.blockers.some((b) => b.code === 'DUPLICATE_CHANGE'))
    assert.ok(outcome.blockers.some((b) => b.code === 'UNKNOWN_CHANGE'))
  } finally {
    await fixture.cleanup()
  }
})

test('splitting one path across commits is rejected in v1', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const { git: gitCmd } = await import('./helpers/fixture.js')
    await writeFile(fixture.root, 'README.md', 'staged\n')
    gitCmd(fixture.root, ['add', '--', 'README.md'])
    await writeFile(fixture.root, 'README.md', 'staged\nunstaged\n')
    const { snapshot } = await snapshotOf(fixture.root)
    const indexId = changeIdOf(snapshot, 'README.md', 'index')
    const worktreeId = changeIdOf(snapshot, 'README.md', 'worktree')
    const outcome = normalizeAndValidatePlan(
      snapshot,
      {
        commits: [
          { message: 'one', changes: [indexId] },
          { message: 'two', changes: [worktreeId] },
        ],
      },
      { indexStrategy: 'reuse-existing-index' },
    )
    assert.ok(outcome.blockers.some((b) => b.code === 'UNSUPPORTED_HUNK_SPLIT'))
  } finally {
    await fixture.cleanup()
  }
})

test('dependency order and cycles are detected', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    await writeFile(fixture.root, 'b.txt', 'b\n')
    const { snapshot } = await snapshotOf(fixture.root)
    const bad = normalizeAndValidatePlan(
      snapshot,
      {
        commits: [
          { message: 'one', changes: [changeIdOf(snapshot, 'a.txt')], dependsOn: ['c2'] },
          { message: 'two', changes: [changeIdOf(snapshot, 'b.txt')] },
        ],
      },
      { indexStrategy: strategyOf(snapshot) },
    )
    assert.ok(bad.blockers.some((b) => b.code === 'DEPENDENCY_ORDER'))

    const cyclic = normalizeAndValidatePlan(
      snapshot,
      {
        commits: [
          { message: 'one', changes: [changeIdOf(snapshot, 'a.txt')], dependsOn: ['c2'] },
          { message: 'two', changes: [changeIdOf(snapshot, 'b.txt')], dependsOn: ['c1'] },
        ],
      },
      { indexStrategy: strategyOf(snapshot) },
    )
    assert.ok(cyclic.blockers.some((b) => b.code === 'DEPENDENCY_ORDER' || b.code === 'DEPENDENCY_CYCLE'))
  } finally {
    await fixture.cleanup()
  }
})

test('a non-empty index forces the reuse strategy and the first commit', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'staged.txt', 'staged\n')
    git(fixture.root, ['add', '--', 'staged.txt'])
    await writeFile(fixture.root, 'other.txt', 'other\n')
    const { snapshot } = await snapshotOf(fixture.root)
    assert.equal(snapshot.indexEmpty, false)

    const wrongStrategy = normalizeAndValidatePlan(
      snapshot,
      { commits: [{ message: 'one', changes: snapshot.entries.map((e) => e.changeId) }] },
      { indexStrategy: 'index-empty-whole-file' },
    )
    assert.ok(wrongStrategy.blockers.some((b) => b.code === 'INDEX_STRATEGY_MISMATCH'))

    const stagedElsewhere = normalizeAndValidatePlan(
      snapshot,
      {
        commits: [
          { message: 'one', changes: [changeIdOf(snapshot, 'other.txt')] },
          { message: 'two', changes: [changeIdOf(snapshot, 'staged.txt', 'index')] },
        ],
      },
      { indexStrategy: 'reuse-existing-index' },
    )
    // One violation, one code: a staged change placed after the first commit is
    // exactly UNSTAGED_INDEX_SPLIT_UNSUPPORTED. It must NOT be re-reported as
    // UNSUPPORTED_HUNK_SPLIT as well (that double-reporting is what made the
    // original dotfiles retry confusing).
    const codes = stagedElsewhere.blockers.map((b) => b.code)
    assert.ok(codes.includes('UNSTAGED_INDEX_SPLIT_UNSUPPORTED'), `expected the staged-split blocker, got ${codes.join(', ')}`)
    assert.ok(!codes.includes('UNSUPPORTED_HUNK_SPLIT'), `the same violation must not be double-reported, got ${codes.join(', ')}`)
    const stagedBlocker = stagedElsewhere.blockers.find((b) => b.code === 'UNSTAGED_INDEX_SPLIT_UNSUPPORTED')
    assert.match(stagedBlocker?.message ?? '', /first commit/)
  } finally {
    await fixture.cleanup()
  }
})

test('an empty commit message is rejected', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const { snapshot } = await snapshotOf(fixture.root)
    const outcome = normalizeAndValidatePlan(
      snapshot,
      { commits: [{ message: '   ', changes: [changeIdOf(snapshot, 'a.txt')] }] },
      { indexStrategy: strategyOf(snapshot) },
    )
    assert.ok(outcome.blockers.some((b) => b.code === 'EMPTY_MESSAGE'))
  } finally {
    await fixture.cleanup()
  }
})
