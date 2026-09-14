/**
 * Repository snapshotting.
 *
 * A snapshot is the only thing a plan may be built from, and it is captured
 * with a full content digest per change — not just the porcelain status
 * letters, because editing a file again leaves `M` unchanged. Capture runs the
 * whole read twice and only returns when both passes agree, so a repository
 * being edited underneath the plugin yields `SNAPSHOT_UNSTABLE` instead of a
 * plan bound to a half-observed state.
 */
import { lstat, open as openFile, readlink } from 'node:fs/promises'
import { GitCommitError } from '../errors.js'
import type {
  ChangeLayer,
  ChangeMode,
  ChangeRecord,
  ChangeStatus,
  RepositoryIdentity,
  RepositoryOperationState,
  Snapshot,
  SnapshotHead,
} from '../types.js'
import { GitRunner, sha256Hex, type RawStatusEntry } from './runner.js'

/** Bytes inspected when guessing whether content is binary (git's own heuristic). */
const BINARY_SNIFF_BYTES = 8000
/** Cap on analysed change records. */
const DEFAULT_MAX_ENTRIES = 5000
/** Cap on bytes buffered from index blobs during one snapshot. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024

/** Options for {@link captureSnapshot}. */
export interface CaptureOptions {
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal
  /** Maximum change records to analyse (default 5000). */
  readonly maxEntries?: number
  /** How many consecutive agreeing capture passes are required (default 2). */
  readonly agreeingPasses?: number
}

/** Deterministic identity of the repository behind one worktree. */
export function repositoryIdentity(runner: GitRunner): RepositoryIdentity {
  return {
    workspaceRoot: runner.workspaceRoot,
    topLevel: runner.topLevel,
    gitDir: runner.gitDir,
    commonDir: runner.commonDir,
    isLinkedWorktree: runner.isLinkedWorktree,
    repositoryId: sha256Hex(runner.commonDir).slice(0, 16),
  }
}

/** Map a porcelain XY code to a normalised status. */
function statusFromCode(code: string): ChangeStatus {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    case 'U':
      return 'unmerged'
    case '?':
      return 'untracked'
    default:
      return 'unknown'
  }
}

/**
 * Reject any path that could escape the repository or address git metadata.
 * Git itself never emits such paths; this is defence in depth for the literal
 * pathspec staging calls.
 */
export function assertSafeRepoPath(path: string): void {
  if (path === '' || path.includes('\u0000')) {
    throw new GitCommitError('PATH_ESCAPES_REPOSITORY', 'empty or NUL-containing repository path', { path })
  }
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
    throw new GitCommitError('PATH_ESCAPES_REPOSITORY', `absolute path is not a repository-relative path: ${path}`, {
      path,
    })
  }
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new GitCommitError('PATH_ESCAPES_REPOSITORY', `path contains a traversal segment: ${path}`, { path })
    }
  }
  if (segments[0] === '.git') {
    throw new GitCommitError('PATH_ESCAPES_REPOSITORY', `path addresses git metadata: ${path}`, { path })
  }
}

/** A draft record before cross-layer flags and digests are attached. */
interface DraftRecord {
  layer: ChangeLayer
  status: ChangeStatus
  path: string
  oldPath?: string
  mode?: ChangeMode
  binary: boolean
  submodule: boolean
  symlink: boolean
  contentKey: string
  sizeBytes?: number
}

/** Guess binary by NUL byte in the leading window (git's own heuristic). */
function looksBinary(sample: Buffer): boolean {
  const end = Math.min(sample.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i += 1) if (sample[i] === 0) return true
  return false
}

/** Read the leading bytes of a file without loading it whole. */
async function readSample(absPath: string, bytes: number): Promise<Buffer> {
  const handle = await openFile(absPath, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Content key for a deletion, tied to the exact content being removed. */
function deletionKey(mode: string, oid: string): string {
  return `del:${mode}:${oid}`
}

/** Determine the file mode git would use for a new worktree file. */
function untrackedMode(executable: boolean): string {
  return executable ? '100755' : '100644'
}

/** One full analysis pass over repository state. */
async function captureOnce(runner: GitRunner, options: CaptureOptions): Promise<Snapshot> {
  const signal = options.signal
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES

  const operationState = await runner.operationState(signal)
  const unmergedEntries = await runner.unmergedCount(signal)
  const headCommit = await runner.revParseVerify('HEAD', signal)
  const branch = await runner.currentBranch(signal)
  const headTree = headCommit === null ? null : await runner.revParseTree('HEAD', signal)

  let indexTree = ''
  try {
    indexTree = await runner.writeTree(undefined, signal)
  } catch (error) {
    if (unmergedEntries === 0) throw error
    // An unmerged index cannot be written; leave it empty and let the
    // validator block the plan with a concrete reason.
  }
  const emptyTree = await runner.emptyTree(signal)
  const indexEmpty = headCommit === null ? indexTree === emptyTree : indexTree === headTree

  const raw = await runner.rawStatus(signal)
  const parsed = GitRunner.parseStatus(raw)
  if (parsed.length > maxEntries) {
    throw new GitCommitError(
      'BUDGET_EXCEEDED',
      `the working tree has ${parsed.length} pending changes, over the ${maxEntries} entry analysis budget`,
      { entries: parsed.length, maxEntries },
    )
  }
  for (const entry of parsed) {
    assertSafeRepoPath(entry.path)
    if (entry.origPath !== undefined) assertSafeRepoPath(entry.origPath)
  }

  const head: SnapshotHead = {
    commit: headCommit,
    branch,
    unborn: headCommit === null,
    detached: headCommit !== null && branch === null,
  }

  const operation: RepositoryOperationState = { ...operationState, unmergedEntries }

  const drafts: DraftRecord[] = []
  for (const entry of parsed) drafts.push(...draftsFor(entry))

  // Resolve content keys that need filesystem or object access.
  await resolveContentKeys(runner, drafts, signal)

  const records = finaliseRecords(drafts)

  const statusDigest = digestOf(records, operation, head, indexTree)
  const snapshotId = sha256Hex(
    `${repositoryIdentity(runner).repositoryId}|${head.commit ?? 'unborn'}|${indexTree}|${statusDigest}`,
  ).slice(0, 32)

  return {
    schemaVersion: 1,
    snapshotId,
    repository: repositoryIdentity(runner),
    head,
    indexTree,
    indexEmpty,
    statusDigest,
    entries: records,
    operationState: operation,
    capturedAt: new Date().toISOString(),
  }
}

/** Convert one raw porcelain entry into layer drafts. */
function draftsFor(entry: RawStatusEntry): DraftRecord[] {
  const drafts: DraftRecord[] = []
  if (entry.kind === 'untracked') {
    drafts.push({
      layer: 'untracked',
      status: 'untracked',
      path: entry.path,
      binary: false,
      submodule: false,
      symlink: false,
      contentKey: '',
      mode: { new: '100644' },
    })
    return drafts
  }
  if (entry.kind === 'ignored') return drafts
  if (entry.kind === 'unmerged') {
    drafts.push({
      layer: 'index',
      status: 'unmerged',
      path: entry.path,
      binary: false,
      submodule: entry.modeIndex === '160000',
      symlink: entry.modeIndex === '120000',
      contentKey: `unmerged:${entry.oidHead}:${entry.oidIndex}`,
      mode: { old: entry.modeHead || undefined, new: entry.modeIndex || undefined },
    })
    return drafts
  }

  const x = entry.xy[0] ?? '.'
  const y = entry.xy[1] ?? '.'
  const indexStatus = x !== '.' && x !== '?' ? statusFromCode(x) : null
  const worktreeStatus = y !== '.' && y !== '?' ? statusFromCode(y) : null

  if (indexStatus !== null) {
    const deleted = indexStatus === 'deleted'
    drafts.push({
      layer: 'index',
      status: indexStatus,
      path: entry.path,
      ...(entry.origPath === undefined ? {} : { oldPath: entry.origPath }),
      mode: { ...(entry.modeHead === '' ? {} : { old: entry.modeHead }), ...(entry.modeIndex === '' ? {} : { new: entry.modeIndex }) },
      binary: false,
      submodule: entry.modeIndex === '160000' || entry.modeHead === '160000',
      symlink: entry.modeIndex === '120000' || entry.modeHead === '120000',
      contentKey: deleted ? deletionKey(entry.modeHead, entry.oidHead) : entry.oidIndex,
    })
  }
  if (worktreeStatus !== null) {
    const deleted = worktreeStatus === 'deleted'
    const baseMode = entry.modeWorktree !== '' ? entry.modeWorktree : entry.modeIndex !== '' ? entry.modeIndex : entry.modeHead
    drafts.push({
      layer: 'worktree',
      status: worktreeStatus,
      path: entry.path,
      ...(entry.origPath === undefined ? {} : { oldPath: entry.origPath }),
      mode: { ...(entry.modeIndex === '' ? {} : { old: entry.modeIndex }), ...(baseMode === '' ? {} : { new: baseMode }) },
      binary: false,
      submodule: baseMode === '160000',
      symlink: baseMode === '120000',
      contentKey: deleted
        ? deletionKey(entry.modeIndex || entry.modeHead, entry.oidIndex || entry.oidHead)
        : '',
    })
  }
  return drafts
}

/** Fill `contentKey`, `binary` and `sizeBytes` using the filesystem and object store. */
async function resolveContentKeys(runner: GitRunner, drafts: DraftRecord[], signal?: AbortSignal): Promise<void> {
  const fileDrafts = drafts.filter(
    (d) => (d.layer === 'worktree' || d.layer === 'untracked') && !d.contentKey.startsWith('del:') && !d.submodule,
  )

  // lstat first: symlinks must not be hash-object'ed (git would follow them).
  const stats = await Promise.all(
    fileDrafts.map(async (draft) => {
      try {
        return await lstat(runner.absolutePath(draft.path))
      } catch {
        return null
      }
    }),
  )

  const symlinkDrafts: Array<{ draft: DraftRecord; target: string }> = []
  const regularPaths: string[] = []
  for (let i = 0; i < fileDrafts.length; i += 1) {
    const draft = fileDrafts[i]
    const info = stats[i]
    if (draft === undefined) continue
    if (info === null || info === undefined) {
      // The path disappeared between status and analysis; keep an explicit
      // marker so the digest still changes and the snapshot is rejected as
      // unstable by the next pass.
      draft.contentKey = 'missing'
      continue
    }
    if (info.isSymbolicLink()) {
      // Git stores the link target string (mode 120000), never the bytes of
      // the file the link points at; `git hash-object` would follow the link.
      draft.symlink = true
      draft.mode = { new: '120000' }
      draft.sizeBytes = info.size
      try {
        symlinkDrafts.push({ draft, target: await readlink(runner.absolutePath(draft.path)) })
      } catch {
        draft.contentKey = 'missing'
      }
      continue
    }
    if (draft.mode !== undefined && draft.mode.new === undefined) {
      draft.mode = { ...draft.mode, new: untrackedMode((info.mode & 0o111) !== 0) }
    }
    if (draft.layer === 'untracked') {
      draft.mode = { new: untrackedMode((info.mode & 0o111) !== 0) }
    }
    draft.sizeBytes = info.size
    if (info.size <= BINARY_SNIFF_BYTES * 4) {
      try {
        draft.binary = looksBinary(await readSample(runner.absolutePath(draft.path), BINARY_SNIFF_BYTES))
      } catch {
        draft.binary = false
      }
    }
    regularPaths.push(draft.path)
  }

  const oids = await runner.hashWorktreeFilesOids(regularPaths, signal)
  for (const draft of fileDrafts) {
    if (draft.contentKey !== '') continue
    const oid = oids.get(draft.path)
    if (oid === undefined) {
      // Fall back to a per-file call (path with a newline, or a transient
      // read error). A failure here leaves the snapshot unstable on purpose.
      const single = await runner.hashWorktreeFileOid(draft.path, signal)
      draft.contentKey = single ?? 'missing'
      continue
    }
    draft.contentKey = oid
  }
  for (const { draft, target } of symlinkDrafts) {
    draft.contentKey = await runner.hashObjectBuffer(Buffer.from(target, 'utf8'), signal)
  }

  // Index-layer entries deleted from the index carry their own key already;
  // entries still present use the index blob oid as the key.
  const indexOids = drafts
    .filter((d) => d.layer === 'index' && d.contentKey !== '' && !d.contentKey.startsWith('del:') && !d.contentKey.startsWith('unmerged:'))
    .map((d) => d.contentKey)
  if (indexOids.length > 0) {
    const blobs = await runner.batchCatBlobs(indexOids, { maxTotalBytes: MAX_BLOB_BYTES, signal })
    for (const draft of drafts) {
      if (draft.layer !== 'index') continue
      const blob = blobs.get(draft.contentKey)
      if (blob === undefined || blob === null) continue
      draft.binary = looksBinary(blob)
      draft.sizeBytes = blob.length
    }
  }
}

/** Attach layer flags and content-addressed ids, sorted for determinism. */
function finaliseRecords(drafts: DraftRecord[]): ChangeRecord[] {
  const byPath = new Map<string, DraftRecord[]>()
  for (const draft of drafts) {
    const list = byPath.get(draft.path) ?? []
    list.push(draft)
    byPath.set(draft.path, list)
  }
  const records: ChangeRecord[] = []
  for (const [path, list] of byPath) {
    const partial = list.length > 1 && list.some((d) => d.layer === 'index') && list.some((d) => d.layer === 'worktree')
    for (const draft of list) {
      const modeOld = draft.mode?.old ?? ''
      const modeNew = draft.mode?.new ?? ''
      const changeId = sha256Hex(
        [
          draft.layer,
          draft.status,
          draft.oldPath ?? '',
          path,
          modeOld,
          modeNew,
          draft.contentKey,
        ].join('\u0000'),
      ).slice(0, 24)
      records.push({
        changeId,
        layer: draft.layer,
        status: draft.status,
        path,
        ...(draft.oldPath === undefined ? {} : { oldPath: draft.oldPath }),
        ...(draft.mode === undefined ? {} : { mode: draft.mode }),
        binary: draft.binary,
        submodule: draft.submodule,
        symlink: draft.symlink,
        contentDigest: sha256Hex(`${draft.layer}\u0000${draft.contentKey}`),
        ...(draft.contentKey.startsWith('del:') || draft.contentKey.startsWith('unmerged:') || draft.contentKey === 'missing'
          ? {}
          : { blobOid: draft.contentKey }),
        ...(draft.sizeBytes === undefined ? {} : { sizeBytes: draft.sizeBytes }),
        partiallyStaged: partial,
        worktreeMatchesIndex: !partial,
      })
    }
  }
  records.sort((a, b) => (a.path === b.path ? a.layer.localeCompare(b.layer) : a.path.localeCompare(b.path)))
  return records
}

/** Canonical digest over everything a plan depends on. */
function digestOf(
  records: readonly ChangeRecord[],
  operation: RepositoryOperationState,
  head: SnapshotHead,
  indexTree: string,
): string {
  const canonical = JSON.stringify({
    head: head.commit,
    branch: head.branch,
    indexTree,
    operation,
    records: records.map((r) => [
      r.changeId,
      r.layer,
      r.status,
      r.oldPath ?? '',
      r.path,
      r.mode?.old ?? '',
      r.mode?.new ?? '',
      r.contentDigest,
      r.binary,
      r.submodule,
      r.symlink,
    ]),
  })
  return sha256Hex(canonical)
}

/** True when two snapshots describe the same repository state. */
export function sameSnapshotState(a: Snapshot, b: Snapshot): boolean {
  return a.statusDigest === b.statusDigest && a.indexTree === b.indexTree && a.head.commit === b.head.commit && a.snapshotId === b.snapshotId
}

/**
 * Capture a consistent snapshot.
 *
 * The repository is read repeatedly until two consecutive passes agree; any
 * continuously changing worktree raises `SNAPSHOT_UNSTABLE` rather than
 * producing a plan against a moving target.
 */
export async function captureSnapshot(runner: GitRunner, options: CaptureOptions = {}): Promise<Snapshot> {
  const agreeingPasses = Math.max(1, options.agreeingPasses ?? 2)
  let previous = await captureOnce(runner, options)
  for (let pass = 1; pass < agreeingPasses; pass += 1) {
    const next = await captureOnce(runner, options)
    if (sameSnapshotState(previous, next)) return next
    previous = next
  }
  if (agreeingPasses === 1) return previous
  throw new GitCommitError('SNAPSHOT_UNSTABLE', 'the working tree kept changing while it was being analysed', {
    snapshotId: previous.snapshotId,
    passes: agreeingPasses,
  })
}

/** Result of re-validating a snapshot against live repository state. */
export interface SnapshotCheck {
  readonly current: Snapshot
  readonly changed: readonly string[]
  readonly indexTreeChanged: boolean
  readonly headChanged: boolean
}

/**
 * Re-capture and compare against an existing snapshot.
 * @returns the live snapshot plus the list of differences (empty = still valid).
 */
export async function checkSnapshot(
  runner: GitRunner,
  snapshot: Snapshot,
  options: CaptureOptions = {},
): Promise<SnapshotCheck> {
  const current = await captureSnapshot(runner, { ...options, agreeingPasses: 1 })
  const changed: string[] = []
  const indexTreeChanged = current.indexTree !== snapshot.indexTree
  const headChanged = current.head.commit !== snapshot.head.commit
  if (headChanged) changed.push('head')
  if (indexTreeChanged) changed.push('indexTree')
  if (current.head.branch !== snapshot.head.branch) changed.push('branch')
  const before = new Map(snapshot.entries.map((e) => [e.changeId, e]))
  const after = new Map(current.entries.map((e) => [e.changeId, e]))
  for (const [id, entry] of before) if (!after.has(id)) changed.push(`removed:${entry.path}:${entry.layer}`)
  for (const [id, entry] of after) if (!before.has(id)) changed.push(`added:${entry.path}:${entry.layer}`)
  return { current, changed, indexTreeChanged, headChanged }
}

/** Look up one change record by id. */
export function findChange(snapshot: Snapshot, changeId: string): ChangeRecord | undefined {
  return snapshot.entries.find((entry) => entry.changeId === changeId)
}

/**
 * Validate an untrusted model-supplied string as a repository-relative path.
 * Used by read tools; throws `PATH_ESCAPES_REPOSITORY` when unsafe.
 */
export function assertSafeModelPath(path: string): string {
  assertSafeRepoPath(path)
  return path
}
