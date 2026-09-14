/**
 * Runner hardening tests: environment scrubbing, cancellation and the absence
 * of any generic command surface.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitCommitError } from '../src/core/errors.js'
import { GitRunner } from '../src/core/git/runner.js'
import { createInitialisedFixture, git, writeFile } from './helpers/fixture.js'

test('the runner ignores ambient GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE', async () => {
  const fixture = await createInitialisedFixture()
  const saved = {
    GIT_DIR: process.env['GIT_DIR'],
    GIT_WORK_TREE: process.env['GIT_WORK_TREE'],
    GIT_INDEX_FILE: process.env['GIT_INDEX_FILE'],
  }
  process.env['GIT_DIR'] = '/nonexistent/git-dir'
  process.env['GIT_WORK_TREE'] = '/nonexistent/worktree'
  process.env['GIT_INDEX_FILE'] = '/nonexistent/index'
  try {
    await writeFile(fixture.root, 'README.md', 'changed\n')
    const runner = await GitRunner.open(fixture.root)
    const { realpath } = await import('node:fs/promises')
    assert.equal(runner.topLevel, await realpath(fixture.root))
    const snapshot = await runner.rawStatus()
    assert.ok(snapshot.toString('utf8').includes('README.md'))
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fixture.cleanup()
  }
})

test('the runner never invokes a shell', async () => {
  const fixture = await createInitialisedFixture()
  try {
    // A path that would be catastrophic under shell interpretation is just a
    // literal filename to the runner.
    await writeFile(fixture.root, '; touch pwned.txt', 'x\n')
    const runner = await GitRunner.open(fixture.root)
    const raw = await runner.rawStatus()
    assert.ok(raw.toString('utf8').includes('; touch pwned.txt'))
    const { access } = await import('node:fs/promises')
    await assert.rejects(access(`${fixture.root}/pwned.txt`))
  } finally {
    await fixture.cleanup()
  }
})

test('opening a non-repository fails with NOT_A_REPOSITORY', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gca-norepo-'))
  try {
    await assert.rejects(
      () => GitRunner.open(dir),
      (error: unknown) => error instanceof GitCommitError && error.code === 'NOT_A_REPOSITORY',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancellation aborts a running git command', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const runner = await GitRunner.open(fixture.root)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => runner.exec(['status', '--porcelain=v2', '-z'], { signal: controller.signal }),
      (error: unknown) => error instanceof GitCommitError && error.code === 'CANCELLED',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('check-attr reports filter attributes for a path', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, '.gitattributes', '*.txt text eol=lf\n')
    await writeFile(fixture.root, 'sample.txt', 'x\n')
    const runner = await GitRunner.open(fixture.root)
    const attrs = await runner.checkAttrs(['sample.txt'])
    assert.equal(attrs.get('sample.txt')?.text, 'set')
    assert.equal(attrs.get('sample.txt')?.eol, 'lf')
  } finally {
    await fixture.cleanup()
  }
})

test('staged rename detection works through porcelain v2 -z', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'docs/one.md', 'one\n')
    git(fixture.root, ['add', '--', 'docs/one.md'])
    git(fixture.root, ['commit', '--quiet', '-m', 'docs: add one'])
    git(fixture.root, ['mv', 'docs/one.md', 'docs/uno.md'])
    const runner = await GitRunner.open(fixture.root)
    const parsed = GitRunner.parseStatus(await runner.rawStatus())
    const rename = parsed.find((entry) => entry.kind === 'rename')
    assert.ok(rename, 'a rename record should be present')
    assert.equal(rename.path, 'docs/uno.md')
    assert.equal(rename.origPath, 'docs/one.md')
  } finally {
    await fixture.cleanup()
  }
})
