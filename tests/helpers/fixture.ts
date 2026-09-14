/**
 * Isolated git fixture repositories for the test suite.
 *
 * Every fixture lives in its own temp directory and is fully self-configuring:
 * it pins user identity, disables signing and forces `core.hooksPath` to its
 * own `.git/hooks`, so the developer's global git configuration can never
 * change what the tests exercise. No test touches a real user repository.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile as writeFileFs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** One isolated repository plus a private plugin data dir. */
export interface Fixture {
  readonly root: string
  readonly dataDir: string
  cleanup(): Promise<void>
}

/** Run git in a fixture (test setup only; never used by the plugin itself). */
export function git(root: string, args: readonly string[], options: { input?: string; allowFailure?: boolean } = {}): string {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      input: options.input,
      env: {
        ...process.env,
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        LANG: 'C',
      },
    })
  } catch (error) {
    if (options.allowFailure === true) {
      const e = error as { stdout?: string }
      return e.stdout ?? ''
    }
    throw error
  }
}

/** Create an empty fixture directory with git initialised and pinned config. */
export async function createFixture(prefix = 'dsh-gca-'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const dataDir = await mkdtemp(join(tmpdir(), `${prefix}data-`))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.name', 'Fixture Author'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  git(root, ['config', 'tag.gpgsign', 'false'])
  git(root, ['config', 'core.hooksPath', '.git/hooks'])
  git(root, ['config', 'core.autocrlf', 'false'])
  return {
    root,
    dataDir,
    async cleanup() {
      await rm(root, { recursive: true, force: true })
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

/** Write a UTF-8 file inside the fixture, creating parent directories. */
export async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = join(root, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFileFs(abs, content, 'utf8')
}

/** Write raw bytes inside the fixture. */
export async function writeBytes(root: string, relPath: string, content: Buffer): Promise<void> {
  const abs = join(root, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFileFs(abs, content)
}

/** Read a UTF-8 file from the fixture. */
export async function readFixtureFile(root: string, relPath: string): Promise<string> {
  return await readFile(join(root, relPath), 'utf8')
}

/** Remove a file from the fixture. */
export async function removeFile(root: string, relPath: string): Promise<void> {
  await rm(join(root, relPath), { force: true })
}

/** Create a symlink inside the fixture. */
export async function symlink(root: string, target: string, relPath: string): Promise<void> {
  const { symlink: symlinkFs } = await import('node:fs/promises')
  const abs = join(root, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await symlinkFs(target, abs)
}

/** Write a file and commit it in one step (setup helper). */
export async function commitFile(root: string, relPath: string, content: string, message: string): Promise<string> {
  await writeFile(root, relPath, content)
  git(root, ['add', '--', relPath])
  git(root, ['commit', '--quiet', '-m', message])
  return git(root, ['rev-parse', 'HEAD']).trim()
}

/** An initialised fixture with one committed file. */
export async function createInitialisedFixture(): Promise<Fixture> {
  const fixture = await createFixture()
  await commitFile(fixture.root, 'README.md', '# Fixture\n', 'chore: initial commit')
  return fixture
}
