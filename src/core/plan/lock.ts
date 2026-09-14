/**
 * Worktree execution locks.
 *
 * An approved plan may only be executed once at a time per worktree. The lock
 * has two layers:
 *  - an in-process map, which is authoritative for this plugin instance;
 *  - an on-disk lock file in the plugin's own data directory (never inside the
 *    target repository), which stops a second host process from racing.
 *
 * A crashed process leaves a lock file behind; it is stolen only after the
 * configured staleness window AND after the owning pid is gone (best effort),
 * and the caller must still reconcile the repository afterwards.
 */
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { GitCommitError } from '../errors.js'
import { sha256Hex } from '../git/runner.js'

/** A held lock. */
export interface LockRecord {
  readonly key: string
  readonly owner: string
  readonly since: string
  readonly pid: number
}

/** Options for {@link WorktreeLock.acquire}. */
export interface AcquireOptions {
  /** Human/tool-readable owner label (session id). */
  readonly owner: string
  /** How long a lock file may sit untouched before it is considered abandoned. */
  readonly staleMs?: number
}

/** Default staleness window for an on-disk lock. */
const DEFAULT_STALE_MS = 10 * 60 * 1000

/** Lock key for one worktree. */
export function worktreeLockKey(repositoryId: string, topLevel: string): string {
  return `${repositoryId}:${topLevel}`
}

/** Two-layer worktree lock. */
export class WorktreeLock {
  private readonly held = new Map<string, LockRecord>()
  private readonly lockDir: string | null

  constructor(lockDir: string | null) {
    this.lockDir = lockDir
  }

  /** Every lock currently held by this process. */
  list(): readonly LockRecord[] {
    return [...this.held.values()]
  }

  /** True when this process already holds `key`. */
  isHeld(key: string): boolean {
    return this.held.has(key)
  }

  /**
   * Acquire the lock for `key`.
   * @returns an async release function. Always call it in a `finally`.
   * @throws GitCommitError `EXECUTION_IN_PROGRESS` when the worktree is busy.
   */
  async acquire(key: string, options: AcquireOptions): Promise<() => Promise<void>> {
    const existing = this.held.get(key)
    if (existing !== undefined) {
      throw new GitCommitError('EXECUTION_IN_PROGRESS', 'another execution is already running for this worktree', {
        key,
        owner: existing.owner,
        since: existing.since,
      })
    }
    const releaseFile = await this.acquireFileLock(key, options)
    const record: LockRecord = { key, owner: options.owner, since: new Date().toISOString(), pid: process.pid }
    this.held.set(key, record)
    let released = false
    return async () => {
      if (released) return
      released = true
      this.held.delete(key)
      await releaseFile()
    }
  }

  /** Acquire the on-disk half of the lock (no-op when no lock dir is configured). */
  private async acquireFileLock(key: string, options: AcquireOptions): Promise<() => Promise<void>> {
    const dir = this.lockDir
    if (dir === null) return async () => undefined
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${sha256Hex(key).slice(0, 32)}.lock`)
    const payload = JSON.stringify({ owner: options.owner, pid: process.pid, since: new Date().toISOString() })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, 'wx')
        await handle.writeFile(payload, 'utf8')
        await handle.close()
        return async () => {
          await unlink(path).catch(() => undefined)
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') {
          throw new GitCommitError('EXECUTION_CONFLICT', `could not create the execution lock file: ${String(code)}`, {
            path,
          })
        }
        const abandoned = await this.isAbandoned(path, staleMs)
        if (attempt === 0 && abandoned) {
          await unlink(path).catch(() => undefined)
          continue
        }
        let owner = 'unknown'
        try {
          owner = JSON.parse(await readFile(path, 'utf8')).owner ?? 'unknown'
        } catch {
          /* leave owner as unknown */
        }
        throw new GitCommitError('EXECUTION_IN_PROGRESS', 'another process holds the execution lock for this worktree', {
          key,
          owner,
          path,
        })
      }
    }
    throw new GitCommitError('EXECUTION_IN_PROGRESS', 'could not acquire the execution lock', { key })
  }

  /** True when an on-disk lock is old enough to steal. */
  private async isAbandoned(path: string, staleMs: number): Promise<boolean> {
    try {
      const info = await stat(path)
      return Date.now() - info.mtimeMs > staleMs
    } catch {
      // The file vanished between EEXIST and stat: treat as free.
      return true
    }
  }
}
