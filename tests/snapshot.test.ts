/**
 * Snapshot / status parsing tests against real isolated repositories.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitRunner } from '../src/core/git/runner.js'
import { assertSafeRepoPath, captureSnapshot, findChange } from '../src/core/git/snapshot.js'
import { commitFile, createFixture, createInitialisedFixture, removeFile, symlink, writeBytes, writeFile } from './helpers/fixture.js'

test('worktree modification produces one worktree-layer change', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'README.md', '# Fixture\nchanged\n')
    const runner = await GitRunner.open(fixture.root)
    const snapshot = await captureSnapshot(runner)
    const entries = snapshot.entries
    assert.equal(entries.length, 1)
    const entry = entries[0]
    assert.ok(entry)
    assert.equal(entry.layer, 'worktree')
    assert.equal(entry.status, 'modified')
    assert.equal(entry.path, 'README.md')
    assert.equal(entry.partiallyStaged, false)
    assert.equal(entry.worktreeMatchesIndex, true)
    assert.equal(snapshot.indexEmpty, true)
  } finally {
    await fixture.cleanup()
  }
})

test('content edit keeps status M but changes the changeId', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const runner = await GitRunner.open(fixture.root)
    await writeFile(fixture.root, 'README.md', '# Fixture\nfirst\n')
    const first = await captureSnapshot(runner)
    await writeFile(fixture.root, 'README.md', '# Fixture\nsecond\n')
    const second = await captureSnapshot(runner)
    assert.notEqual(first.entries[0]?.changeId, second.entries[0]?.changeId)
    assert.notEqual(first.statusDigest, second.statusDigest)
    assert.equal(first.entries[0]?.status, 'modified')
  } finally {
    await fixture.cleanup()
  }
})

test('staged content becomes an index-layer change', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'README.md', '# Fixture\nstaged\n')
    const { git } = await import('./helpers/fixture.js')
    git(fixture.root, ['add', '--', 'README.md'])
    const runner = await GitRunner.open(fixture.root)
    const snapshot = await captureSnapshot(runner)
    assert.equal(snapshot.indexEmpty, false)
    assert.equal(snapshot.entries.length, 1)
    assert.equal(snapshot.entries[0]?.layer, 'index')
    assert.equal(snapshot.entries[0]?.partiallyStaged, false)
  } finally {
    await fixture.cleanup()
  }
})

test('partially staged file yields two records', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const { git } = await import('./helpers/fixture.js')
    await writeFile(fixture.root, 'README.md', '# Fixture\nstaged\n')
    git(fixture.root, ['add', '--', 'README.md'])
    await writeFile(fixture.root, 'README.md', '# Fixture\nstaged\nunstaged\n')
    const runner = await GitRunner.open(fixture.root)
    const snapshot = await captureSnapshot(runner)
    assert.equal(snapshot.entries.length, 2)
    assert.ok(snapshot.entries.every((e) => e.partiallyStaged))
    assert.deepEqual(
      snapshot.entries.map((e) => e.layer).sort(),
      ['index', 'worktree'],
    )
  } finally {
    await fixture.cleanup()
  }
})

test('untracked, deleted and renamed paths are classified', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const { git } = await import('./helpers/fixture.js')
    await commitFile(fixture.root, 'docs/guide.md', 'guide\n', 'docs: add guide')
    await writeFile(fixture.root, 'new.txt', 'brand new\n')
    await removeFile(fixture.root, 'README.md')
    git(fixture.root, ['mv', 'docs/guide.md', 'docs/manual.md'])
    const runner = await GitRunner.open(fixture.root)
    const snapshot = await captureSnapshot(runner)
    const byPath = new Map(snapshot.entries.map((e) => [`${e.layer}:${e.path}`, e]))
    assert.equal(byPath.get('untracked:new.txt')?.status, 'untracked')
    assert.equal(byPath.get('worktree:README.md')?.status, 'deleted')
    const renamed = byPath.get('index:docs/manual.md')
    assert.ok(renamed, 'staged rename should be reported at the new path')
    assert.equal(renamed.status, 'renamed')
    assert.equal(renamed.oldPath, 'docs/guide.md')
  } finally {
    await fixture.cleanup()
  }
})

test('special characters in paths survive the -z round trip', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'weird name "quoted" \u00e9\u4e2d\u6587.txt', 'x\n')
    const runner = await GitRunner.open(fixture.root)
    const snapshot = await captureSnapshot(runner)
    const found = snapshot.entries.find((e) => e.path.startsWith('weird name'))
    assert.ok(found, `expected the special path in ${JSON.stringify(snapshot.entries.map((e) => e.path))}`)
    assert.equal(found.layer, 'untracked')
  } finally {
    await fixture.cleanup()
  }
})

test('binary content is flagged', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeBytes(fixture.root, 'logo.bin', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]))
    const runner = await GitRunner.open(fixture.root)
    const snapshot = await captureSnapshot(runner)
    const entry = snapshot.entries.find((e) => e.path === 'logo.bin')
    assert.ok(entry)
    assert.equal(entry.binary, true)
  } finally {
    await fixture.cleanup()
  }
})

test('symlink changes are represented by their target, not the target file', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'target.txt', 'target contents\n')
    await symlink(fixture.root, 'target.txt', 'link.txt')
    const runner = await GitRunner.open(fixture.root)
    const snapshot = await captureSnapshot(runner)
    const link = snapshot.entries.find((e) => e.path === 'link.txt')
    assert.ok(link)
    assert.equal(link.symlink, true)
    // Changing the target file must not change the symlink's own digest.
    const before = link.contentDigest
    await writeFile(fixture.root, 'target.txt', 'different contents\n')
    const second = await captureSnapshot(runner)
    const after = second.entries.find((e) => e.path === 'link.txt')
    assert.equal(after?.contentDigest, before)
  } finally {
    await fixture.cleanup()
  }
})

test('an unborn repository snapshots with a null HEAD', async () => {
  const fixture = await createFixture()
  try {
    await writeFile(fixture.root, 'first.txt', 'first\n')
    const runner = await GitRunner.open(fixture.root)
    const snapshot = await captureSnapshot(runner)
    assert.equal(snapshot.head.commit, null)
    assert.equal(snapshot.head.unborn, true)
    assert.equal(snapshot.entries.length, 1)
    assert.equal(snapshot.entries[0]?.status, 'untracked')
  } finally {
    await fixture.cleanup()
  }
})

test('change ids are stable across repeated captures', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'README.md', '# Fixture\nstable\n')
    const runner = await GitRunner.open(fixture.root)
    const a = await captureSnapshot(runner)
    const b = await captureSnapshot(runner)
    assert.equal(a.snapshotId, b.snapshotId)
    assert.equal(a.entries[0]?.changeId, b.entries[0]?.changeId)
  } finally {
    await fixture.cleanup()
  }
})

test('path safety rejects traversal and git metadata', () => {
  assert.throws(() => assertSafeRepoPath('../escape'), /traversal/)
  assert.throws(() => assertSafeRepoPath('/etc/passwd'), /absolute/)
  assert.throws(() => assertSafeRepoPath('.git/config'), /git metadata/)
  assert.throws(() => assertSafeRepoPath('a/../../b'), /traversal/)
  assert.doesNotThrow(() => assertSafeRepoPath('src/index.ts'))
  assert.doesNotThrow(() => assertSafeRepoPath('.gitignore'))
  assert.doesNotThrow(() => assertSafeRepoPath('a/.github/workflows/ci.yml'))
})

test('findChange resolves a snapshot entry', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'README.md', '# Fixture\nfind me\n')
    const runner = await GitRunner.open(fixture.root)
    const snapshot = await captureSnapshot(runner)
    const id = snapshot.entries[0]?.changeId ?? ''
    assert.equal(findChange(snapshot, id)?.path, 'README.md')
    assert.equal(findChange(snapshot, 'does-not-exist'), undefined)
  } finally {
    await fixture.cleanup()
  }
})
