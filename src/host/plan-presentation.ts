/** Durable, repository-independent review payloads. Transcript metadata is a fallback, not the database. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type PlanPresentation = Record<string, unknown> & {
  taskId: string; planId: string; revision: number; planDigest: string
}

/** The exact prepare_plan presentationMeta projection; shared by persistence and transcript. */
export function preparePlanPresentation(value: unknown): Record<string, unknown> {
  const v = value as Record<string, unknown>
  const plan = (v['plan'] as Record<string, unknown> | undefined) ?? {}
  const preview = (v['preview'] as Array<Record<string, unknown>> | undefined) ?? []
  return {
    taskId: v['taskId'] ?? null, planId: plan['planId'] ?? null,
    revision: plan['revision'] ?? null, planDigest: plan['planDigest'] ?? null,
    status: plan['status'] ?? null, indexStrategy: plan['indexStrategy'] ?? null,
    approved: plan['approved'] === true, blockers: plan['blockers'] ?? [],
    warnings: plan['warnings'] ?? [], commits: plan['commits'] ?? [],
    excludedChanges: plan['excludedChanges'] ?? [], reviewDetail: v['reviewDetail'] ?? null,
    delta: plan['delta'] ?? null, preview,
    previewTruncated: preview.some((block) => block['patchTruncated'] === true),
  }
}

export function isPlanPresentation(value: unknown): value is PlanPresentation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return ['taskId', 'planId', 'planDigest'].every(k => typeof v[k] === 'string' && v[k] !== '')
    && Number.isSafeInteger(v['revision']) && (v['revision'] as number) > 0
    && Array.isArray(v['commits']) && Array.isArray(v['preview'])
}

/** Hash filenames prevent task/plan identifiers from becoming filesystem paths. */
function payloadPath(directory: string, p: PlanPresentation): string {
  const key = createHash('sha256').update(JSON.stringify([p.taskId, p.planId, p.revision, p.planDigest])).digest('hex')
  return join(directory, 'presentations', `${key}.json`)
}

/** Await this before returning a successful prepare result; a failed write fails the tool closed. */
export async function persistPlanPresentation(directory: string, value: unknown, sessionId?: string): Promise<void> {
  if (!isPlanPresentation(value)) throw new Error('invalid plan presentation identity')
  const file = payloadPath(directory, value)
  await mkdir(join(directory, 'presentations'), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sessionId: sessionId ?? null, payload: value }), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}

/** Only selected index candidates are read; the full payload is never returned or retained. */
export async function readPlanPresentationSession(directory: string, identity: PlanPresentation): Promise<string | null> {
  try {
    const envelope = JSON.parse(await readFile(payloadPath(directory, identity), 'utf8')) as { schemaVersion?: number; sessionId?: unknown; payload?: unknown }
    if (envelope.schemaVersion !== 1) return null // legacy payload: confirm via read-only transcript instead
    const value = envelope.payload
    if (!isPlanPresentation(value) || ['taskId', 'planId', 'revision', 'planDigest'].some(k => value[k] !== identity[k])) {
      throw new Error('invalid persisted plan presentation')
    }
    return typeof envelope.sessionId === 'string' && envelope.sessionId !== '' ? envelope.sessionId : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function readPlanPresentation(directory: string, identity: PlanPresentation, sessionId?: string): Promise<PlanPresentation | null> {
  try {
    const stored: unknown = JSON.parse(await readFile(payloadPath(directory, identity), 'utf8'))
    const envelope = stored as { schemaVersion?: number; sessionId?: string | null; payload?: unknown }
    if (sessionId !== undefined && (envelope.schemaVersion !== 1 || envelope.sessionId !== sessionId)) return null
    const value = envelope.schemaVersion === 1 ? envelope.payload : stored
    if (!isPlanPresentation(value) || ['taskId', 'planId', 'revision', 'planDigest'].some(k => value[k] !== identity[k])) {
      throw new Error('invalid persisted plan presentation')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
