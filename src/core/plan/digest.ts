/**
 * Plan digesting and approval binding.
 *
 * Approval is bound to a *content digest* of the executable part of a plan
 * version, not to a plan id and not to a UI button. Changing any message,
 * order, change set, excluded change or expected tree changes the digest and
 * therefore revokes the previous approval.
 */
import { createHash } from 'node:crypto'
import type { PlanVersion } from '../types.js'

/** Canonical JSON with object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

/** Recursively sort object keys so digests are stable across producers. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** The executable content of a plan version (everything approval covers). */
export interface PlanDigestInput {
  readonly schemaVersion: 1
  readonly planId: string
  readonly revision: number
  readonly target: PlanVersion['target']
  readonly snapshotId: string
  readonly indexStrategy: PlanVersion['indexStrategy']
  readonly commits: PlanVersion['commits']
  readonly excludedChanges: PlanVersion['excludedChanges']
}

/** Extract the digest-relevant projection of a plan version. */
export function digestInputOf(plan: PlanVersion): PlanDigestInput {
  return {
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    revision: plan.revision,
    target: plan.target,
    snapshotId: plan.snapshotId,
    indexStrategy: plan.indexStrategy,
    commits: plan.commits,
    excludedChanges: plan.excludedChanges,
  }
}

/** sha256 over the executable content of one plan version. */
export function computePlanDigest(plan: PlanVersion): string {
  return createHash('sha256').update(canonicalJson(digestInputOf(plan))).digest('hex')
}
