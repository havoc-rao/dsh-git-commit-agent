/**
 * Restricted git CLI runner.
 *
 * Security contract:
 *  - the *host* constructs every argument array; no caller can inject a
 *    subcommand, a git option or a `--upload-pack`-style escape;
 *  - the process is spawned with `execFile` (never a shell);
 *  - the ambient git environment is scrubbed and replaced with a fixed,
 *    behaviour-pinning set (`GIT_PAGER`, `GIT_TERMINAL_PROMPT`,
 *    `GIT_LITERAL_PATHSPECS`, `LC_ALL`, …) *except* for the configuration
 *    locations, which are deliberately preserved so user identity, hooks and
 *    signing behave exactly as they do in the user's own terminal;
 *  - a temporary index file is only ever passed explicitly by the caller.
 *
 * Read-only analysis methods use `--no-filters` / `--no-ext-diff` /
 * `--no-textconv` so a hostile repository cannot make analysis execute code.
 * Staging uses `git update-index` with one literal path per call, which does
 * apply the user's own filters exactly like `git add <path>` — that is the
 * whole point, and it is verified afterwards against the approved tree.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stat as statFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { GitCommitError } from '../errors.js'

/** Environment variables removed before every git invocation. */
const SCRUBBED_ENV_KEYS = [
  // Repository/worktree/object plumbing: any of these would let a caller
  // redirect git at a different repository than the bound target.
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_TEMPLATE_DIR',
  // Diff/pager/editor escapes: never let the repository or the ambient shell
  // decide to run a program or open a pager.
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_TERMINAL_PROMPT',
  'GIT_OPTIONAL_LOCKS',
  'GIT_FLUSH',
  // Pathspec magic: force literal pathspecs ourselves.
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
]

/** Fixed environment applied to every git invocation. */
const FIXED_ENV: Readonly<Record<string, string>> = {
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_EDITOR: ':',
  GIT_SEQUENCE_EDITOR: ':',
  LC_ALL: 'C',
  LANG: 'C',
}

/** One completed git invocation. */
export interface GitResult {
  readonly args: readonly string[]
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

/** Options accepted by {@link GitRunner.exec}. */
export interface GitExecOptions {
  /** Feed `input` to stdin. */
  readonly input?: string | Buffer
  /** Use a temporary index file instead of `.git/index`. */
  readonly indexFile?: string
  /** Extra environment entries (already trusted, host-constructed). */
  readonly env?: Readonly<Record<string, string>>
  /** Per-command timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal
  /** Treat a non-zero exit as data instead of throwing. */
  readonly allowFailure?: boolean
}

/** Default read timeout. */
const DEFAULT_READ_TIMEOUT_MS = 30_000
/** Default write/commit timeout (hooks may legitimately be slow). */
const DEFAULT_WRITE_TIMEOUT_MS = 180_000
/** Hard cap on captured output per stream. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024

/** A parsed `--porcelain=v2 -z` status record. */
export interface RawStatusEntry {
  readonly kind: 'ordinary' | 'rename' | 'unmerged' | 'untracked' | 'ignored'
  readonly xy: string
  readonly sub: string
  readonly modeHead: string
  readonly modeIndex: string
  readonly modeWorktree: string
  readonly oidHead: string
  readonly oidIndex: string
  readonly path: string
  readonly origPath?: string
  readonly score?: string
}

/** Attributes observed for one path by `git check-attr`. */
export interface PathAttributes {
  readonly path: string
  readonly filter?: string
  readonly text?: string
  readonly eol?: string
  readonly diff?: string
}

/** True when `value` is an `unspecified`/`unset` attribute placeholder. */
export function isAttributeNoOpinion(v: string | undefined): boolean {
  return v === undefined || v === 'unspecified' || v === 'unset' || v === 'false'
}

/**
 * A git runner bound to one worktree.
 *
 * `workspaceRoot` is the directory the plugin was asked to operate on; git
 * itself resolves the real top level (which differs in a linked worktree).
 */
export class GitRunner {
  /** Directory git commands run in. */
  readonly workspaceRoot: string
  /** `git rev-parse --show-toplevel` result, set by {@link init}. */
  private topLevelValue = ''
  private gitDirValue = ''
  private commonDirValue = ''
  private isLinkedWorktreeValue = false

  private constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
  }

  /** Repository top level (absolute). */
  get topLevel(): string {
    return this.topLevelValue
  }

  /** Absolute `.git` directory for this worktree. */
  get gitDir(): string {
    return this.gitDirValue
  }

  /** Absolute common `.git` directory shared by every worktree. */
  get commonDir(): string {
    return this.commonDirValue
  }

  /** True when this checkout is a linked worktree. */
  get isLinkedWorktree(): boolean {
    return this.isLinkedWorktreeValue
  }

  /**
   * Bind a runner to `workspaceRoot` and resolve the repository layout.
   * @param workspaceRoot - directory to run git in (absolute).
   * @param signal - optional cancellation.
   */
  static async open(workspaceRoot: string, signal?: AbortSignal): Promise<GitRunner> {
    const runner = new GitRunner(workspaceRoot)
    let inside: GitResult
    try {
      inside = await runner.exec(['rev-parse', '--is-inside-work-tree'], { signal, timeoutMs: 15_000 })
    } catch (error) {
      const detail = error instanceof GitCommitError
        ? { cause: error.code, causeMessage: error.message, ...error.detail }
        : { causeMessage: String(error) }
      throw new GitCommitError('NOT_A_REPOSITORY', `not a git working tree: ${workspaceRoot}`, {
        workspaceRoot,
        ...detail,
      })
    }
    if (inside.stdout.toString('utf8').trim() !== 'true') {
      throw new GitCommitError('NOT_A_REPOSITORY', `not a git working tree: ${workspaceRoot}`, { workspaceRoot })
    }
    const top = await runner.exec(['rev-parse', '--show-toplevel'], { signal, timeoutMs: 15_000 })
    runner.topLevelValue = top.stdout.toString('utf8').trim()
    const gitDir = await runner.exec(['rev-parse', '--absolute-git-dir'], { signal, timeoutMs: 15_000 })
    runner.gitDirValue = gitDir.stdout.toString('utf8').trim()
    const commonDir = await runner.exec(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      signal,
      timeoutMs: 15_000,
    })
    runner.commonDirValue = commonDir.stdout.toString('utf8').trim()
    runner.isLinkedWorktreeValue = runner.gitDirValue !== runner.commonDirValue
    return runner
  }

  /**
   * Run one host-constructed git command.
   * @param args - arguments after the global option block.
   * @param options - stdin, index file, timeout and cancellation.
   * @returns the raw result (stdout as bytes so `-z` output stays intact).
   */
  async exec(args: readonly string[], options: GitExecOptions = {}): Promise<GitResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of SCRUBBED_ENV_KEYS) delete env[key]
    Object.assign(env, FIXED_ENV)
    if (options.indexFile !== undefined) env['GIT_INDEX_FILE'] = options.indexFile
    if (options.env !== undefined) Object.assign(env, options.env)

    const argv = [
      '-c',
      'core.quotepath=false',
      '-c',
      'core.fsmonitor=false',
      '--no-optional-locks',
      ...args,
    ]

    // Only a real AbortSignal may reach execFile; a structural look-alike would
    // make Node reject the whole spawn.
    const signal = options.signal instanceof AbortSignal ? options.signal : undefined

    const result = await new Promise<GitResult>((resolve, reject) => {
      const child = execFile(
        'git',
        argv,
        {
          cwd: this.workspaceRoot,
          env,
          encoding: 'buffer',
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          windowsHide: true,
          ...(signal === undefined ? {} : { signal }),
        },
        (error, stdout, stderr) => {
          const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout))
          const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr))
          if (error === null) {
            resolve({ args: argv, code: 0, stdout: out, stderr: err })
            return
          }
          const errno = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; name?: string }
          if (errno.name === 'AbortError') {
            if (options.allowFailure === true) {
              resolve({ args: argv, code: 1, stdout: out, stderr: Buffer.from('aborted') })
              return
            }
            reject(new GitCommitError('CANCELLED', `git ${args[0] ?? ''} was cancelled`, { args }))
            return
          }
          if (errno.code === 'ENOENT') {
            reject(
              new GitCommitError('GIT_NOT_FOUND', 'the git executable was not found on PATH', {
                command: 'git',
              }),
            )
            return
          }
          if (errno.killed === true) {
            reject(
              new GitCommitError('GIT_TIMEOUT', `git ${args[0] ?? ''} exceeded its ${timeoutMs}ms budget`, {
                args,
                timeoutMs,
                stderr: err.toString('utf8').slice(0, 4000),
              }),
            )
            return
          }
          resolve({ args: argv, code: typeof errno.code === 'number' ? errno.code : 1, stdout: out, stderr: err })
        },
      )
      if (options.input !== undefined) {
        child.stdin?.end(options.input)
      } else {
        child.stdin?.end()
      }
    })

    if (result.code !== 0 && options.allowFailure !== true) {
      throw new GitCommitError('GIT_FAILED', `git ${args[0] ?? ''} exited with ${result.code}`, {
        args,
        code: result.code,
        stderr: result.stderr.toString('utf8').slice(0, 4000),
        stdout: result.stdout.toString('utf8').slice(0, 4000),
      })
    }
    return result
  }

  /** Convenience: run and decode stdout as UTF-8 text (trimmed of the final newline). */
  private async text(args: readonly string[], options: GitExecOptions = {}): Promise<string> {
    const result = await this.exec(args, options)
    return result.stdout.toString('utf8').replace(/\n$/, '')
  }

  /** The git version string (`git version 2.x.y`). */
  async version(): Promise<string> {
    return await this.text(['version'])
  }

  /** Raw `--porcelain=v2 -z` status bytes, including untracked files. */
  async rawStatus(signal?: AbortSignal): Promise<Buffer> {
    const result = await this.exec(
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=no', '--no-ahead-behind'],
      { signal, timeoutMs: 60_000 },
    )
    return result.stdout
  }

  /** Parse `--porcelain=v2 -z` bytes into structured entries. */
  static parseStatus(raw: Buffer): RawStatusEntry[] {
    const entries: RawStatusEntry[] = []
    const parts: Buffer[] = []
    let start = 0
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === 0) {
        parts.push(raw.subarray(start, i))
        start = i + 1
      }
    }
    if (start < raw.length) parts.push(raw.subarray(start))
    const decode = (b: Buffer): string => b.toString('utf8')
    let i = 0
    while (i < parts.length) {
      const line = parts[i]
      if (line === undefined || line.length === 0) {
        i += 1
        continue
      }
      const s = decode(line)
      const kind = s[0]
      if (kind === '1') {
        const p = s.split(' ')
        entries.push({
          kind: 'ordinary',
          xy: p[1] ?? '..',
          sub: p[2] ?? '',
          modeHead: p[3] ?? '',
          modeIndex: p[4] ?? '',
          modeWorktree: p[5] ?? '',
          oidHead: p[6] ?? '',
          oidIndex: p[7] ?? '',
          path: decodePath(s.slice(p.slice(0, 8).join(' ').length + 1)),
        })
        i += 1
        continue
      }
      if (kind === '2') {
        const p = s.split(' ')
        // The rename record's `<path>` and `<origPath>` are two NUL-separated
        // fields in `-z` mode; `parts[i+1]` is the original path.
        const path = decodePath(s.slice(p.slice(0, 9).join(' ').length + 1))
        const orig = parts[i + 1] !== undefined ? decode(parts[i + 1] as Buffer) : undefined
        entries.push({
          kind: 'rename',
          xy: p[1] ?? '..',
          sub: p[2] ?? '',
          modeHead: p[3] ?? '',
          modeIndex: p[4] ?? '',
          modeWorktree: p[5] ?? '',
          oidHead: p[6] ?? '',
          oidIndex: p[7] ?? '',
          score: p[8] ?? '',
          path,
          ...(orig === undefined ? {} : { origPath: orig }),
        })
        i += 2
        continue
      }
      if (kind === 'u') {
        const p = s.split(' ')
        entries.push({
          kind: 'unmerged',
          xy: p[1] ?? '..',
          sub: p[2] ?? '',
          modeHead: p[3] ?? '',
          modeIndex: p[4] ?? '',
          modeWorktree: p[5] ?? '',
          oidHead: p[6] ?? '',
          oidIndex: p[7] ?? '',
          path: decodePath(s.slice(p.slice(0, 10).join(' ').length + 1)),
        })
        i += 1
        continue
      }
      if (kind === '?') {
        entries.push({
          kind: 'untracked',
          xy: '??',
          sub: '',
          modeHead: '',
          modeIndex: '',
          modeWorktree: '',
          oidHead: '',
          oidIndex: '',
          path: s.slice(2),
        })
        i += 1
        continue
      }
      if (kind === '!') {
        entries.push({
          kind: 'ignored',
          xy: '!!',
          sub: '',
          modeHead: '',
          modeIndex: '',
          modeWorktree: '',
          oidHead: '',
          oidIndex: '',
          path: s.slice(2),
        })
        i += 1
        continue
      }
      // Unknown record type: ignore rather than mis-parse a path.
      i += 1
    }
    return entries
  }

  /** `git ls-files -s -z`: every index entry as `mode oid stage\tpath`. */
  async lsFilesStaged(signal?: AbortSignal): Promise<Array<{ mode: string; oid: string; stage: number; path: string }>> {
    const result = await this.exec(['ls-files', '-s', '-z'], { signal, timeoutMs: 60_000 })
    const out: Array<{ mode: string; oid: string; stage: number; path: string }> = []
    for (const record of splitNul(result.stdout)) {
      if (record.length === 0) continue
      const tab = record.indexOf(9)
      if (tab < 0) continue
      const meta = record.subarray(0, tab).toString('utf8')
      const path = record.subarray(tab + 1).toString('utf8')
      const [mode, oid, stage] = meta.split(' ')
      out.push({ mode: mode ?? '', oid: oid ?? '', stage: Number.parseInt(stage ?? '0', 10), path })
    }
    return out
  }

  /** Tree oid of the real index (writes loose tree objects; touches nothing else). */
  async writeTree(indexFile?: string, signal?: AbortSignal): Promise<string> {
    return await this.text(['write-tree'], {
      ...(indexFile === undefined ? {} : { indexFile }),
      signal,
      timeoutMs: 60_000,
    })
  }

  /** The empty tree oid for this repository's hash algorithm. */
  async emptyTree(signal?: AbortSignal): Promise<string> {
    return await this.text(['hash-object', '-t', 'tree', '--stdin'], { input: '', signal })
  }

  /** Resolve a commit-ish to a full oid, or `null` when it does not exist. */
  async revParseVerify(rev: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.exec(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      signal,
      allowFailure: true,
    })
    if (result.code !== 0) return null
    const oid = result.stdout.toString('utf8').trim()
    return oid === '' ? null : oid
  }

  /** Resolve a tree-ish to a full tree oid, or `null`. */
  async revParseTree(rev: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.exec(['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], {
      signal,
      allowFailure: true,
    })
    if (result.code !== 0) return null
    const oid = result.stdout.toString('utf8').trim()
    return oid === '' ? null : oid
  }

  /** Current branch short name, or `null` when detached/unborn. */
  async currentBranch(signal?: AbortSignal): Promise<string | null> {
    const result = await this.exec(['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal, allowFailure: true })
    if (result.code !== 0) return null
    const name = result.stdout.toString('utf8').trim()
    return name === '' ? null : name
  }

  /** True when HEAD exists (a repository with at least one commit). */
  async hasHead(signal?: AbortSignal): Promise<boolean> {
    return (await this.revParseVerify('HEAD', signal)) !== null
  }

  /** Parent oids of one commit (empty for a root commit). */
  async commitParents(oid: string, signal?: AbortSignal): Promise<string[]> {
    const out = await this.text(['rev-list', '--parents', '-n', '1', oid], { signal, timeoutMs: 30_000 })
    const parts = out.trim().split(/\s+/).filter((p) => p !== '')
    return parts.slice(1)
  }

  /** One recent commit, as needed for reconciliation and style reference. */
  async recentCommits(
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<{ oid: string; tree: string; parents: string[]; subject: string }>> {
    const bounded = Math.max(1, Math.min(limit, 200))
    const result = await this.exec(['log', `-n${bounded}`, '--format=%H%x1f%T%x1f%P%x1f%s%x1e', '--no-color'], {
      signal,
      allowFailure: true,
      timeoutMs: 60_000,
    })
    if (result.code !== 0) return []
    const text = result.stdout.toString('utf8')
    const out: Array<{ oid: string; tree: string; parents: string[]; subject: string }> = []
    for (const chunk of text.split('\u001e')) {
      const trimmed = chunk.replace(/^\n+/, '')
      if (trimmed === '') continue
      const [oid = '', tree = '', parents = '', subject = ''] = trimmed.split('\u001f')
      if (oid === '') continue
      out.push({ oid, tree, parents: parents.split(' ').filter((p) => p !== ''), subject })
    }
    return out
  }

  /** Read a blob's bytes. */
  async catBlob(oid: string, signal?: AbortSignal): Promise<Buffer> {
    const result = await this.exec(['cat-file', 'blob', oid], { signal, timeoutMs: 60_000 })
    return result.stdout
  }

  /**
   * Stream several blobs in one process via `git cat-file --batch`.
   *
   * `maxTotalBytes` bounds how much content is buffered: entries beyond the
   * budget are reported as `null` so a repository full of huge binaries cannot
   * exhaust plugin memory during analysis.
   */
  async batchCatBlobs(
    oids: readonly string[],
    options: { maxTotalBytes?: number; signal?: AbortSignal } = {},
  ): Promise<Map<string, Buffer | null>> {
    const out = new Map<string, Buffer | null>()
    const unique = [...new Set(oids.filter((oid) => oid !== ''))]
    if (unique.length === 0) return out
    const budget = options.maxTotalBytes ?? 64 * 1024 * 1024
    const result = await this.exec(['cat-file', '--batch'], {
      input: `${unique.join('\n')}\n`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: 120_000,
    })
    const buf = result.stdout
    let cursor = 0
    let consumed = 0
    while (cursor < buf.length) {
      const nl = buf.indexOf(10, cursor)
      if (nl < 0) break
      const header = buf.subarray(cursor, nl).toString('utf8')
      cursor = nl + 1
      const [oid = '', type = '', sizeText = ''] = header.split(' ')
      if (type === 'missing' || type === '') {
        out.set(oid, null)
        continue
      }
      const size = Number.parseInt(sizeText, 10)
      if (!Number.isFinite(size) || size < 0) {
        out.set(oid, null)
        continue
      }
      if (consumed + size > budget) {
        // Still need to skip the payload to keep the stream in sync.
        cursor += size + 1
        consumed += size
        out.set(oid, null)
        continue
      }
      const body = buf.subarray(cursor, cursor + size)
      cursor += size + 1
      consumed += size
      out.set(oid, Buffer.from(body))
    }
    return out
  }

  /**
   * Deterministic content oid for a worktree file, ignoring clean/smudge
   * filters (`--no-filters`) so analysis never executes repository-supplied
   * programs. Analysis digests are not used as the staged object; staging goes
   * through {@link updateIndexAdd}, which does honour user filters.
   */
  async hashWorktreeFileOid(relPath: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.exec(['hash-object', '--no-filters', '--', relPath], {
      signal,
      allowFailure: true,
      timeoutMs: 60_000,
    })
    if (result.code !== 0) return null
    const oid = result.stdout.toString('utf8').trim()
    return oid === '' ? null : oid
  }

  /** Oid of an arbitrary in-memory buffer (no filters, nothing written). */
  async hashObjectBuffer(content: Buffer, signal?: AbortSignal): Promise<string> {
    return await this.text(['hash-object', '-t', 'blob', '--stdin'], { input: content, signal })
  }

  /**
   * Hash many worktree files in one process via `--stdin-paths`.
   *
   * Paths containing a newline cannot be expressed in the newline-delimited
   * stdin format, so they are reported as absent and the caller falls back to
   * the single-path method.
   */
  async hashWorktreeFilesOids(paths: readonly string[], signal?: AbortSignal): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const batchable = paths.filter((p) => !p.includes('\n') && !p.includes('\r'))
    if (batchable.length === 0) return out
    const result = await this.exec(['hash-object', '--no-filters', '--stdin-paths'], {
      input: `${batchable.join('\n')}\n`,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 180_000,
      allowFailure: true,
    })
    if (result.code !== 0) return out
    const lines = result.stdout.toString('utf8').split('\n')
    for (let i = 0; i < batchable.length; i += 1) {
      const oid = (lines[i] ?? '').trim()
      const path = batchable[i]
      if (path !== undefined && /^[0-9a-f]{40,64}$/.test(oid)) out.set(path, oid)
    }
    return out
  }

  /** `git check-attr` for the given attributes over the given paths. */
  async checkAttrs(paths: readonly string[], signal?: AbortSignal): Promise<Map<string, PathAttributes>> {
    const map = new Map<string, PathAttributes>()
    if (paths.length === 0) return map
    const result = await this.exec(['check-attr', '-z', 'filter', 'text', 'eol', 'diff', '--', ...paths], {
      signal,
      timeoutMs: 60_000,
    })
    const fields = splitNul(result.stdout).map((b) => b.toString('utf8'))
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const path = fields[i] ?? ''
      const attr = fields[i + 1] ?? ''
      const value = fields[i + 2] ?? ''
      const current = map.get(path) ?? { path }
      map.set(path, { ...current, [attr]: value } as PathAttributes)
    }
    return map
  }

  /** Initialize a temporary index from a tree. */
  async readTreeInto(indexFile: string, tree: string, signal?: AbortSignal): Promise<void> {
    await this.exec(['read-tree', tree], { indexFile, signal, timeoutMs: 60_000 })
  }

  /** Reset a temporary index to the empty tree. */
  async readEmptyTreeInto(indexFile: string, signal?: AbortSignal): Promise<void> {
    await this.exec(['read-tree', '--empty'], { indexFile, signal, timeoutMs: 60_000 })
  }

  /**
   * Stage one worktree path into an index (real or temporary), honouring the
   * user's filters exactly like `git add <path>`. Never recursive, never a
   * directory, never a pathspec glob (`GIT_LITERAL_PATHSPECS=1`).
   */
  async updateIndexAdd(relPath: string, indexFile?: string, signal?: AbortSignal): Promise<void> {
    await this.exec(['update-index', '--add', '--', relPath], {
      ...(indexFile === undefined ? {} : { indexFile }),
      signal,
      timeoutMs: 120_000,
    })
  }

  /** Remove one path from an index. */
  async updateIndexRemove(relPath: string, indexFile?: string, signal?: AbortSignal): Promise<void> {
    await this.exec(['update-index', '--force-remove', '--', relPath], {
      ...(indexFile === undefined ? {} : { indexFile }),
      signal,
      timeoutMs: 60_000,
    })
  }

  /** True when the path currently has an index entry. */
  async indexHasPath(relPath: string, indexFile?: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.exec(['ls-files', '-z', '--', relPath], {
      ...(indexFile === undefined ? {} : { indexFile }),
      signal,
      allowFailure: true,
      timeoutMs: 30_000,
    })
    return result.stdout.length > 0
  }

  /**
   * Create one commit from the current real index with `-m`. No `--no-verify`,
   * no `--amend`, no signing override: hooks, identity and signature settings
   * behave exactly as configured by the user.
   */
  async commit(message: string, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await this.exec(['commit', '-m', message], {
      signal,
      allowFailure: true,
      timeoutMs: DEFAULT_WRITE_TIMEOUT_MS,
    })
    return {
      code: result.code,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
    }
  }

  /** True when a merge/rebase/cherry-pick/revert/bisect is in progress. */
  async operationState(signal?: AbortSignal): Promise<{
    merge: boolean
    rebase: boolean
    cherryPick: boolean
    revert: boolean
    bisect: boolean
  }> {
    const gitDir = this.gitDir
    const commonDir = this.commonDir
    const [merge, rebaseMerge, rebaseApply, cherryPick, revert, bisect] = await Promise.all([
      pathExists(`${gitDir}/MERGE_HEAD`),
      pathExists(`${gitDir}/rebase-merge`),
      pathExists(`${gitDir}/rebase-apply`),
      pathExists(`${gitDir}/CHERRY_PICK_HEAD`),
      pathExists(`${gitDir}/REVERT_HEAD`),
      pathExists(`${commonDir}/BISECT_LOG`),
    ])
    void signal
    return { merge, rebase: rebaseMerge || rebaseApply, cherryPick, revert, bisect }
  }

  /** Count of unmerged (stage != 0) index entries. */
  async unmergedCount(signal?: AbortSignal): Promise<number> {
    const entries = await this.lsFilesStaged(signal)
    return entries.filter((e) => e.stage !== 0).length
  }

  /**
   * Absolute path of a repo-relative path.
   * @throws GitCommitError `PATH_ESCAPES_REPOSITORY` when the result leaves the worktree.
   */
  absolutePath(relPath: string): string {
    const abs = resolve(this.topLevelValue, relPath)
    const root = this.topLevelValue.endsWith(sep) ? this.topLevelValue : `${this.topLevelValue}${sep}`
    if (abs !== this.topLevelValue && !abs.startsWith(root)) {
      throw new GitCommitError('PATH_ESCAPES_REPOSITORY', `path escapes the worktree: ${relPath}`, { relPath })
    }
    return abs
  }

  /** Stat helper for a repo-relative path. */
  async statPath(relPath: string): Promise<{ size: number; isSymbolicLink: boolean; isDirectory: boolean } | null> {
    try {
      const info = await statFile(this.absolutePath(relPath))
      return { size: info.size, isSymbolicLink: info.isSymbolicLink(), isDirectory: info.isDirectory() }
    } catch {
      return null
    }
  }
}

/** Decode a possibly-quoted git path emitted in `-z` mode. */
function decodePath(raw: string): string {
  // In `-z` mode git never quotes, so the value is already literal.
  return raw
}

/** Split a NUL-terminated byte stream into its records. */
function splitNul(raw: Buffer): Buffer[] {
  const out: Buffer[] = []
  let start = 0
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === 0) {
      out.push(raw.subarray(start, i))
      start = i + 1
    }
  }
  if (start < raw.length) out.push(raw.subarray(start))
  return out
}

/** Non-following existence check. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await statFile(path)
    return true
  } catch {
    return false
  }
}

/** sha256 hex helper shared by the snapshot/keying code. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}
