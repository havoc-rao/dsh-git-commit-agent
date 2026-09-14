/**
 * Data-directory resolution tests.
 *
 * Regression cover for the isolation defect found on the live host: the plugin
 * ignored `$DSH_HOME` and wrote into the user's real `~/.dsh`, which a sandbox
 * turned into a raw `EPERM`. Resolution now mirrors
 * `@deepseek-ai/dsh-home-paths#resolveDshHome`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GitCommitError } from '../src/core/errors.js'
import { CommitAgentService, defaultDataDir, expandHomePath, resolveDshHome } from '../src/core/service.js'
import { createInitialisedFixture } from './helpers/fixture.js'

/** Run `fn` with `DSH_HOME` temporarily set (or deleted when `undefined`). */
async function withDshHome<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env['DSH_HOME']
  if (value === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  }
}

test('DSH_HOME overrides the default harness home', () => {
  assert.equal(defaultDataDir({ DSH_HOME: '/tmp/dsh-test-home' }), '/tmp/dsh-test-home/git-commit-agent')
})

test('a blank or whitespace-only DSH_HOME is treated as unset', () => {
  const expected = join(homedir(), '.dsh', 'git-commit-agent')
  assert.equal(defaultDataDir({ DSH_HOME: '' }), expected)
  assert.equal(defaultDataDir({ DSH_HOME: '   ' }), expected)
  assert.equal(defaultDataDir({}), expected)
})

test('a configured dataDir wins over DSH_HOME and expands a leading tilde', () => {
  assert.equal(resolveDshHome('/explicit/home', { DSH_HOME: '/ignored' }), '/explicit/home')
  assert.equal(expandHomePath('~/nested'), join(homedir(), 'nested'))
  assert.equal(expandHomePath('~'), homedir())
  assert.equal(expandHomePath('/absolute'), '/absolute')
})

test('the service resolves its data directory from DSH_HOME', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gca-home-'))
  try {
    await withDshHome(dir, async () => {
      const service = new CommitAgentService()
      assert.equal(service.directory, join(dir, 'git-commit-agent'))
      const explicit = new CommitAgentService({ dataDir: join(dir, 'custom') })
      assert.equal(explicit.directory, join(dir, 'custom'))
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unusable data directory fails loudly with DATA_DIR_UNAVAILABLE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gca-baddir-'))
  try {
    // A regular file used as a parent makes mkdir fail with ENOTDIR.
    const blocker = join(dir, 'not-a-directory')
    await writeFile(blocker, 'x', 'utf8')
    const service = new CommitAgentService({ dataDir: join(blocker, 'data'), lockDir: null })
    await assert.rejects(
      () => service.init(),
      (error: unknown) =>
        error instanceof GitCommitError
        && error.code === 'DATA_DIR_UNAVAILABLE'
        && String(error.message).includes('dataDir'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('startDedicatedSession validates the data directory before creating a session', async () => {
  const fixture = await createInitialisedFixture()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gca-order-'))
  try {
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'x', 'utf8')
    const { createCommitAgentPlugin } = await import('../src/index.js')
    let created = 0
    const plugin = createCommitAgentPlugin({
      dataDir: join(blocker, 'data'),
      lockDir: null,
      resolveAgents: () => ({
        async create() {
          created += 1
          throw new Error('should not be reached')
        },
        async resume() {
          throw new Error('not used')
        },
        get: () => undefined,
      }),
    })
    await assert.rejects(
      () => plugin.api.startDedicatedSession({ workspacePath: fixture.root, sourceSessionId: null }),
      (error: unknown) => (error as { code?: string }).code === 'DATA_DIR_UNAVAILABLE',
    )
    assert.equal(created, 0, 'no session may be created when the data dir is unusable')
    await plugin.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
    await fixture.cleanup()
  }
})
