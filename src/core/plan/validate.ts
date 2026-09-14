/**
 * Plan validation.
 *
 * The model proposes a grouping of *change ids*; this module decides whether
 * the grouping is expressible by the v1 executor. It is deliberately strict:
 * anything the executor cannot reproduce exactly becomes a blocker, and a plan
 * with blockers can never be approved.
 */
import { GitCommitError } from '../errors.js'
import type { ChangeRecord, ExcludedChange, IndexStrategy, PlanBlocker, PlannedCommit, Snapshot } from '../types.js'
import { findChange } from '../git/snapshot.js'

/** One commit as proposed by the model. */
export interface PlanDraftCommit {
  readonly message: string
  readonly rationale?: string
  readonly dependsOn?: readonly string[]
  readonly changes: readonly string[]
}

/** A plan as proposed by the model, before host validation. */
export interface PlanDraft {
  readonly commits: readonly PlanDraftCommit[]
  readonly excludedChanges?: readonly { readonly changeId: string; readonly reason: string }[]
}

/** Result of validation and normalisation. */
export interface ValidationOutcome {
  readonly blockers: PlanBlocker[]
  readonly warnings: string[]
  readonly normalized: {
    readonly commits: PlannedCommit[]
    readonly excluded: ExcludedChange[]
  }
}

/** Limits applied to a model-proposed plan. */
export interface ValidationLimits {
  readonly maxCommits: number
  readonly maxChangesPerCommit: number
  readonly maxMessageChars: number
}

/** Default plan limits. */
export const DEFAULT_VALIDATION_LIMITS: ValidationLimits = {
  maxCommits: 50,
  maxChangesPerCommit: 2000,
  maxMessageChars: 20_000,
}

/** Commit ids are positional (`c1`, `c2`, …) so the model can reference them. */
export function commitIdForIndex(index: number): string {
  return `c${index + 1}`
}

/**
 * Normalise a `dependsOn` reference: accepts `c3`, `3`, `#3` or `3` as a
 * number-as-string, always returning `c3`.
 */
function normalizeDependencyRef(raw: string): string | null {
  const trimmed = raw.trim().replace(/^#/, '')
  if (/^c\d+$/.test(trimmed)) return trimmed
  if (/^\d+$/.test(trimmed)) return `c${trimmed}`
  return null
}

/** True when two records address the same working-tree path. */
function samePathSplit(records: readonly ChangeRecord[]): string | null {
  const seen = new Map<string, string>()
  for (const record of records) {
    const previous = seen.get(record.path)
    if (previous !== undefined && previous !== record.layer) return record.path
    if (previous === undefined) seen.set(record.path, record.layer)
  }
  return null
}

/** Validate a draft against a snapshot and normalise it into plan commits. */
export function normalizeAndValidatePlan(
  snapshot: Snapshot,
  draft: PlanDraft,
  options: { indexStrategy: IndexStrategy; limits?: ValidationLimits },
): ValidationOutcome {
  const limits = options.limits ?? DEFAULT_VALIDATION_LIMITS
  const blockers: PlanBlocker[] = []
  const warnings: string[] = []

  const commits: PlannedCommit[] = []
  const excluded: ExcludedChange[] = []

  // ---- repository-level blockers -------------------------------------------
  const op = snapshot.operationState
  if (op.merge) blockers.push({ code: 'UNSUPPORTED_REPOSITORY_STATE', message: 'a merge is in progress (MERGE_HEAD exists)' })
  if (op.rebase) blockers.push({ code: 'UNSUPPORTED_REPOSITORY_STATE', message: 'a rebase is in progress' })
  if (op.cherryPick) blockers.push({ code: 'UNSUPPORTED_REPOSITORY_STATE', message: 'a cherry-pick is in progress' })
  if (op.revert) blockers.push({ code: 'UNSUPPORTED_REPOSITORY_STATE', message: 'a revert is in progress' })
  if (op.bisect) blockers.push({ code: 'UNSUPPORTED_REPOSITORY_STATE', message: 'a bisect is in progress' })
  if (op.unmergedEntries > 0) {
    blockers.push({
      code: 'UNSUPPORTED_UNMERGED',
      message: `${op.unmergedEntries} index path(s) are unmerged; resolve the conflicts first`,
    })
  }
  for (const entry of snapshot.entries) {
    if (entry.status === 'unmerged') {
      blockers.push({ code: 'UNSUPPORTED_UNMERGED', message: `unmerged path: ${entry.path}`, subject: entry.changeId })
    }
    if (entry.submodule) {
      blockers.push({
        code: 'UNSUPPORTED_SUBMODULE',
        message: `submodule changes are not supported in v1: ${entry.path}`,
        subject: entry.changeId,
      })
    }
    if (entry.status === 'typechange') {
      blockers.push({
        code: 'UNSUPPORTED_TYPECHANGE',
        message: `file type changes (file<->symlink) are not supported in v1: ${entry.path}`,
        subject: entry.changeId,
      })
    }
  }

  if (snapshot.indexEmpty && options.indexStrategy !== 'index-empty-whole-file') {
    blockers.push({
      code: 'INDEX_STRATEGY_MISMATCH',
      message: 'the index equals HEAD but the plan declares the reuse-existing-index strategy',
    })
  }
  if (!snapshot.indexEmpty && options.indexStrategy !== 'reuse-existing-index') {
    blockers.push({
      code: 'INDEX_STRATEGY_MISMATCH',
      message: 'the index already differs from HEAD; the plan must declare the reuse-existing-index strategy',
    })
  }

  // ---- shape of the proposed plan ------------------------------------------
  if (draft.commits.length === 0) {
    blockers.push({ code: 'EMPTY_PLAN', message: 'a plan must contain at least one commit' })
  }
  if (draft.commits.length > limits.maxCommits) {
    blockers.push({
      code: 'TOO_MANY_COMMITS',
      message: `the plan proposes ${draft.commits.length} commits, over the limit of ${limits.maxCommits}`,
    })
  }

  const known = new Map(snapshot.entries.map((entry) => [entry.changeId, entry]))
  const includedIds = new Set<string>()
  const assignedCommits: PlannedCommit[] = []

  draft.commits.forEach((proposed, index) => {
    const id = commitIdForIndex(index)
    const message = typeof proposed.message === 'string' ? proposed.message.replace(/\s+$/, '') : ''
    if (message.trim() === '') {
      blockers.push({ code: 'EMPTY_MESSAGE', message: `commit ${id} has an empty message`, subject: id })
    }
    if (message.length > limits.maxMessageChars) {
      blockers.push({
        code: 'MESSAGE_TOO_LONG',
        message: `commit ${id} message is ${message.length} characters, over the limit of ${limits.maxMessageChars}`,
        subject: id,
      })
    }
    if (message.includes('\u0000')) {
      blockers.push({ code: 'INVALID_MESSAGE', message: `commit ${id} message contains a NUL byte`, subject: id })
    }
    const firstLine = message.split('\n')[0] ?? ''
    if (firstLine.length > 72) {
      warnings.push(`commit ${id} subject line is ${firstLine.length} characters (convention: <= 72)`)
    }

    const changes = Array.isArray(proposed.changes) ? [...proposed.changes] : []
    if (changes.length === 0) {
      blockers.push({ code: 'EMPTY_COMMIT', message: `commit ${id} includes no changes`, subject: id })
    }
    if (changes.length > limits.maxChangesPerCommit) {
      blockers.push({
        code: 'TOO_MANY_CHANGES',
        message: `commit ${id} includes ${changes.length} changes, over the limit of ${limits.maxChangesPerCommit}`,
        subject: id,
      })
    }
    const resolved: string[] = []
    for (const raw of changes) {
      const record = known.get(raw)
      if (record === undefined) {
        blockers.push({
          code: 'UNKNOWN_CHANGE',
          message: `commit ${id} references unknown or stale change id ${raw}`,
          subject: id,
        })
        continue
      }
      if (includedIds.has(raw)) {
        blockers.push({
          code: 'DUPLICATE_CHANGE',
          message: `change ${record.path} (${record.layer}) is included more than once`,
          subject: raw,
        })
        continue
      }
      includedIds.add(raw)
      resolved.push(raw)
    }

    const dependsOn: string[] = []
    for (const raw of proposed.dependsOn ?? []) {
      const normalizedRef = normalizeDependencyRef(String(raw))
      if (normalizedRef === null) {
        blockers.push({
          code: 'UNKNOWN_DEPENDENCY',
          message: `commit ${id} depends on an unparseable reference ${String(raw)}`,
          subject: id,
        })
        continue
      }
      dependsOn.push(normalizedRef)
    }

    assignedCommits.push({
      id,
      message,
      rationale: typeof proposed.rationale === 'string' ? proposed.rationale : '',
      dependsOn,
      changes: resolved,
      expectedTree: '',
    })
  })

  // Same path in more than one commit is hunk splitting: out of scope for v1.
  const pathLayers = new Map<string, Set<string>>()
  for (const commit of assignedCommits) {
    for (const changeId of commit.changes) {
      const record = known.get(changeId)
      if (record === undefined) continue
      const set = pathLayers.get(record.path) ?? new Set<string>()
      set.add(commit.id)
      pathLayers.set(record.path, set)
    }
  }
  for (const [path, commitIds] of pathLayers) {
    if (commitIds.size > 1) {
      blockers.push({
        code: 'UNSUPPORTED_HUNK_SPLIT',
        message: `path ${path} is split across commits ${[...commitIds].join(', ')}; v1 stages whole files only`,
        subject: path,
      })
    }
  }

  // Dependency graph: existence, cycles, ordering.
  const ids = new Set(assignedCommits.map((c) => c.id))
  const orderIndex = new Map(assignedCommits.map((c, i) => [c.id, i]))
  for (const commit of assignedCommits) {
    for (const dep of commit.dependsOn) {
      if (!ids.has(dep)) {
        blockers.push({
          code: 'UNKNOWN_DEPENDENCY',
          message: `commit ${commit.id} depends on unknown commit ${dep}`,
          subject: commit.id,
        })
        continue
      }
      if ((orderIndex.get(dep) ?? 0) >= (orderIndex.get(commit.id) ?? 0)) {
        blockers.push({
          code: 'DEPENDENCY_ORDER',
          message: `commit ${commit.id} depends on ${dep}, which does not come before it`,
          subject: commit.id,
        })
      }
    }
  }
  const cycle = findDependencyCycle(assignedCommits)
  if (cycle !== null) {
    blockers.push({ code: 'DEPENDENCY_CYCLE', message: `dependency cycle: ${cycle.join(' -> ')}` })
  }

  // Exclusions.
  const excludedIds = new Set<string>()
  for (const raw of draft.excludedChanges ?? []) {
    const record = known.get(raw.changeId)
    if (record === undefined) {
      blockers.push({
        code: 'UNKNOWN_EXCLUDED_CHANGE',
        message: `excluded change id ${raw.changeId} is not part of the current snapshot`,
        subject: raw.changeId,
      })
      continue
    }
    if (includedIds.has(raw.changeId)) {
      blockers.push({
        code: 'CONFLICTING_EXCLUSION',
        message: `change ${record.path} is both included and excluded`,
        subject: raw.changeId,
      })
      continue
    }
    if (excludedIds.has(raw.changeId)) continue
    excludedIds.add(raw.changeId)
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
    if (reason === '') {
      blockers.push({
        code: 'MISSING_EXCLUSION_REASON',
        message: `excluded change ${record.path} has no reason`,
        subject: raw.changeId,
      })
    }
    excluded.push({ changeId: raw.changeId, path: record.path, reason })
  }

  for (const entry of snapshot.entries) {
    if (includedIds.has(entry.changeId) || excludedIds.has(entry.changeId)) continue
    blockers.push({
      code: 'UNCOVERED_CHANGE',
      message: `change not covered by the plan: ${entry.path} (${entry.layer}, ${entry.status})`,
      subject: entry.changeId,
    })
  }

  // Reuse-existing-index: everything already staged lands in the first commit.
  if (options.indexStrategy === 'reuse-existing-index') {
    const first = assignedCommits[0]
    const firstSet = new Set(first?.changes ?? [])
    for (const entry of snapshot.entries) {
      if (entry.layer !== 'index') continue
      if (!firstSet.has(entry.changeId)) {
        blockers.push({
          code: 'UNSTAGED_INDEX_SPLIT_UNSUPPORTED',
          message:
            `change ${entry.path} is already staged and would land in the first commit, `
            + 'but the plan does not include it there; v1 will not split the existing index',
          subject: entry.changeId,
        })
      }
    }
  }

  // Unsupported layers in later commits under reuse strategy.
  if (options.indexStrategy === 'reuse-existing-index') {
    for (const commit of assignedCommits.slice(1)) {
      for (const changeId of commit.changes) {
        const record = known.get(changeId)
        if (record !== undefined && record.layer === 'index') {
          blockers.push({
            code: 'UNSUPPORTED_HUNK_SPLIT',
            message: `change ${record.path} is an index-layer change placed after the first commit`,
            subject: changeId,
          })
        }
      }
    }
  }

  const splitPath = samePathSplit(snapshot.entries)
  if (splitPath !== null) {
    warnings.push(`path ${splitPath} has both staged and unstaged content`)
  }

  commits.push(...assignedCommits)

  return { blockers, warnings, normalized: { commits, excluded } }
}

/** Detect a cycle in the `dependsOn` graph, returning the cycle path. */
function findDependencyCycle(commits: readonly PlannedCommit[]): string[] | null {
  const graph = new Map(commits.map((c) => [c.id, c.dependsOn]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    const current = state.get(id)
    if (current === 'done') return null
    if (current === 'visiting') {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue
      const found = visit(dep)
      if (found !== null) return found
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }

  for (const commit of commits) {
    const found = visit(commit.id)
    if (found !== null) return found
  }
  return null
}

/** Assert that a plan is free of blockers, throwing on the first blocker. */
export function assertNoBlockers(blockers: readonly PlanBlocker[]): void {
  const first = blockers[0]
  if (first === undefined) return
  throw new GitCommitError('PLAN_INVALID', `plan has ${blockers.length} blocker(s): ${first.message}`, {
    blockers: blockers.map((b) => ({ code: b.code, message: b.message, subject: b.subject })),
  })
}

/** Changes referenced by a plan, in plan order. */
export function planChanges(snapshot: Snapshot, commits: readonly PlannedCommit[]): ChangeRecord[] {
  const out: ChangeRecord[] = []
  for (const commit of commits) {
    for (const changeId of commit.changes) {
      const record = findChange(snapshot, changeId)
      if (record !== undefined) out.push(record)
    }
  }
  return out
}
