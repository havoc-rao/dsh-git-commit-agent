/**
 * Plan materialisation.
 *
 * The host — never the model — computes the tree every planned commit must
 * produce. Materialisation runs against a *temporary* index file
 * (`GIT_INDEX_FILE` in a private temp dir), starting from HEAD (or from the
 * user's real index when the plan reuses staged content) and applying each
 * commit's whole-file changes in order with `git update-index --add` /
 * `--force-remove`, which honour the user's own filters exactly like
 * `git add <path>` would.
 *
 * This writes loose git objects and one temp file. It never touches the
 * worktree, the real index or any ref.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitCommitError } from '../errors.js'
import type { ChangeRecord, DiffStat, IndexStrategy, PlanBlocker, PlannedCommit, Snapshot } from '../types.js'
import { findChange } from '../git/snapshot.js'
import type { GitRunner } from '../git/runner.js'

/** Input to {@link materializePlan}. */
export interface MaterializeInput {
  readonly runner: GitRunner
  readonly snapshot: Snapshot
  readonly commits: readonly PlannedCommit[]
  readonly indexStrategy: IndexStrategy
  readonly signal?: AbortSignal
}

/** Per-commit trees produced by materialisation. */
export interface MaterializedStep {
  readonly commitId: string
  /** Tree this commit starts from. */
  readonly baseTree: string
  /** Tree this commit must produce. */
  readonly expectedTree: string
}

/** Result of materialising a plan. */
export interface MaterializeResult {
  readonly steps: readonly MaterializedStep[]
  /** Commits with `expectedTree` filled in. */
  readonly commits: readonly PlannedCommit[]
  readonly blockers: readonly PlanBlocker[]
  /** Tree the first commit starts from. */
  readonly baseTree: string
}

/** Stage one change record into an index, in the direction the record implies. */
export async function stageChangeRecord(
  runner: GitRunner,
  record: ChangeRecord,
  indexFile: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const isDelete = record.status === 'deleted'
  if (isDelete) {
    await runner.updateIndexRemove(record.path, indexFile, signal)
    if (record.oldPath !== undefined && record.oldPath !== record.path) {
      await runner.updateIndexRemove(record.oldPath, indexFile, signal)
    }
    return
  }
  if (record.status === 'renamed' && record.oldPath !== undefined && record.oldPath !== record.path) {
    await runner.updateIndexAdd(record.path, indexFile, signal)
    await runner.updateIndexRemove(record.oldPath, indexFile, signal)
    return
  }
  await runner.updateIndexAdd(record.path, indexFile, signal)
}

/**
 * Materialise a plan into exact expected trees.
 *
 * @returns the per-commit steps plus any blockers discovered while applying
 *  changes (a missing worktree file, a vanished path, an empty commit).
 */
export async function materializePlan(input: MaterializeInput): Promise<MaterializeResult> {
  const { runner, snapshot, indexStrategy, signal } = input
  const blockers: PlanBlocker[] = []
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-git-commit-agent-'))
  const indexFile = join(tempDir, 'index')
  try {
    const headTree = snapshot.head.commit === null ? await runner.emptyTree(signal) : await runner.revParseTree('HEAD', signal)
    const resolvedHeadTree = headTree ?? (await runner.emptyTree(signal))
    // `buildBase` is the state the temporary index starts from; `parentTree` is
    // the tree of the commit that will actually be the parent (HEAD for the
    // first commit, the previous planned commit after that). They differ under
    // the reuse strategy, where the first commit's parent is HEAD but its
    // content already includes the user's staged changes.
    const buildBase = indexStrategy === 'reuse-existing-index' ? snapshot.indexTree : resolvedHeadTree

    await runner.readTreeInto(indexFile, buildBase, signal)

    const steps: MaterializedStep[] = []
    const commits: PlannedCommit[] = []
    let parentTree = resolvedHeadTree

    for (let index = 0; index < input.commits.length; index += 1) {
      const commit = input.commits[index]
      if (commit === undefined) continue
      for (const changeId of commit.changes) {
        const record = findChange(snapshot, changeId)
        if (record === undefined) {
          blockers.push({
            code: 'UNKNOWN_CHANGE',
            message: `commit ${commit.id} references change ${changeId}, which is not in the snapshot`,
            subject: commit.id,
          })
          continue
        }
        // Under the reuse strategy the first commit starts from the real index,
        // so index-layer content is already present.
        if (indexStrategy === 'reuse-existing-index' && index === 0 && record.layer === 'index') continue
        try {
          await stageChangeRecord(runner, record, indexFile, signal)
        } catch (error) {
          const detail = error instanceof GitCommitError ? error.message : String(error)
          blockers.push({
            code: 'MATERIALIZE_FAILED',
            message: `could not stage ${record.path} for commit ${commit.id}: ${detail}`,
            subject: changeId,
          })
        }
      }

      let tree: string
      try {
        tree = await runner.writeTree(indexFile, signal)
      } catch (error) {
        const detail = error instanceof GitCommitError ? error.message : String(error)
        blockers.push({
          code: 'MATERIALIZE_FAILED',
          message: `could not compute the tree for commit ${commit.id}: ${detail}`,
          subject: commit.id,
        })
        tree = parentTree
      }

      if (tree === parentTree) {
        blockers.push({
          code: 'EMPTY_TREE_COMMIT',
          message: `commit ${commit.id} would not change the tree (it duplicates its parent state)`,
          subject: commit.id,
        })
      }

      // `baseTree` is the parent commit's tree, so previews show exactly what
      // this commit adds relative to its parent — including pre-staged content
      // in the reuse strategy.
      steps.push({ commitId: commit.id, baseTree: parentTree, expectedTree: tree })
      commits.push({ ...commit, expectedTree: tree })
      parentTree = tree
    }

    return { steps, commits, blockers, baseTree: resolvedHeadTree }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Render a read-only unified diff between two trees.
 *
 * Uses `--no-ext-diff`, `--no-textconv` and a bounded output so repository
 * configuration cannot run a program or flood the model context.
 */
export async function treeDiff(
  runner: GitRunner,
  baseTree: string,
  targetTree: string,
  options: { maxBytes?: number; paths?: readonly string[]; signal?: AbortSignal } = {},
): Promise<{ patch: string; truncated: boolean }> {
  const maxBytes = options.maxBytes ?? 256 * 1024
  const args = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--find-renames',
    '--find-copies',
    '--unified=3',
    baseTree,
    targetTree,
  ]
  if (options.paths !== undefined && options.paths.length > 0) args.push('--', ...options.paths)
  const result = await runner.exec(args, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    allowFailure: true,
    timeoutMs: 60_000,
  })
  const full = result.stdout
  if (full.length <= maxBytes) return { patch: full.toString('utf8'), truncated: false }
  return { patch: full.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/**
 * Authoritative diff stat between two trees.
 *
 * `--numstat` output is line-based and tiny, so the counts are never subject to
 * the byte cap that truncates a patch — a truncated preview must not claim to
 * be the full change. Binary rows report `-` for both counts and still count
 * as one file.
 */
export async function treeNumstat(
  runner: GitRunner,
  baseTree: string,
  targetTree: string,
  options: { paths?: readonly string[]; signal?: AbortSignal } = {},
): Promise<DiffStat> {
  const args = ['diff', '--numstat', '--no-ext-diff', '--no-textconv', baseTree, targetTree]
  if (options.paths !== undefined && options.paths.length > 0) args.push('--', ...options.paths)
  const result = await runner.exec(args, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    allowFailure: true,
    timeoutMs: 60_000,
  })
  let files = 0
  let additions = 0
  let deletions = 0
  for (const line of result.stdout.toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    const [addRaw, delRaw] = line.split('\t')
    if (addRaw === undefined || delRaw === undefined) continue
    const add = addRaw === '-' ? 0 : Number(addRaw)
    const del = delRaw === '-' ? 0 : Number(delRaw)
    if (Number.isNaN(add) || Number.isNaN(del)) continue
    files += 1
    additions += add
    deletions += del
  }
  return { files, additions, deletions }
}
