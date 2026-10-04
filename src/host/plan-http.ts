/** Public authenticated read-only recovery route. Polling provides durable publication notification. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoredTask } from '../core/store/store.js'
import type { CommitAgentService } from '../core/service.js'
import type { HostPluginContext } from './types.js'
import { isPlanPresentation, readPlanPresentation, readPlanPresentationSession, type PlanPresentation } from './plan-presentation.js'

export interface PlanHttpHost {
  webServer: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void }
  connection: { admit(req: IncomingMessage): { peer: unknown } | { rejection: 401 | 403 } }
}
interface Persistence {
  open(id: string, access: 'read'): Promise<{
    readonly inheritedEventCount?: number
    read(offset?: number): Promise<{ events: readonly { type: string; data: unknown }[] }>
    close(): Promise<void>
  }>
}
const fields = ['taskId', 'planId', 'revision', 'digest'] as const
function query(url: URL, key: string): string {
  const all = url.searchParams.getAll(key)
  if (all.length !== 1 || all[0] === '' || all[0]!.length > 1024) throw new Error('bad query')
  return all[0]!
}
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}

/** Read historical full metadata through the public read handle; never resume an agent or write a log. */
async function historical(persistence: Persistence | undefined, sessionId: string): Promise<PlanPresentation[]> {
  if (persistence === undefined) return []
  let handle: Awaited<ReturnType<Persistence['open']>>
  try { handle = await persistence.open(sessionId, 'read') }
  catch (error) {
    if ((error as { code?: string }).code === 'SESSION_NOT_FOUND' || (error as Error).name === 'SessionPersistenceNotFoundError') return []
    throw error
  }
  try {
    const { events } = await handle.read(handle.inheritedEventCount ?? 0)
    const calls = new Set<string>()
    const result: PlanPresentation[] = []
    for (const event of events) {
      const data = event.data as { name?: string; callId?: string; meta?: unknown; message?: { toolCallId?: string; isError?: boolean } } | null
      if (event.type === 'tool/call' && data?.name === 'commit_agent_prepare_plan' && typeof data.callId === 'string') calls.add(data.callId)
      if (event.type !== 'tool/result' || data?.message?.isError === true || !calls.has(data?.message?.toolCallId ?? '')) continue
      if (isPlanPresentation(data?.meta)) result.push(data.meta)
    }
    return result
  } finally { await handle.close() }
}

type PlanIdentity = { taskId: string; planId: string; revision: number; digest: string }
function identity(plan: StoredTask['plans'][number]): PlanPresentation {
  return { taskId: plan.taskId, planId: plan.planId, revision: plan.revision, planDigest: plan.planDigest, commits: [], preview: [] }
}
function matches(p: PlanPresentation | StoredTask['plans'][number], wanted: PlanIdentity): boolean {
  return p.taskId === wanted.taskId && p.planId === wanted.planId && p.revision === wanted.revision && p.planDigest === wanted.digest
}

/** Read only: Store.init() can create directories and repair corruption. */
async function readTasks(service: Pick<CommitAgentService, 'directory'>): Promise<Record<string, StoredTask>> {
  try {
    const document = JSON.parse(await readFile(join(service.directory, 'store.json'), 'utf8')) as { schemaVersion?: number; tasks?: Record<string, StoredTask> }
    if (document.schemaVersion !== 1 || document.tasks === undefined || document.tasks === null || typeof document.tasks !== 'object' || Array.isArray(document.tasks)) throw new Error('invalid plan store')
    for (const [id, stored] of Object.entries(document.tasks)) {
      if (!stored?.task || stored.task.taskId !== id || !Array.isArray(stored.plans) || stored.plans.some(p => p.taskId !== id || !isPlanPresentation(identity(p)))) throw new Error('invalid plan store')
    }
    return document.tasks
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

// Legacy origin confirmation keeps only identities, never patches. A bounded
// per-persistence cache reads append-only log tails; inherited events are skipped.
// Eviction/restart may replay a legacy session once. New envelopes need no log.
interface OriginLog { offset?: number; calls: Set<string>; identities: Set<string>; pending?: Promise<void> }
const originLogs = new WeakMap<Persistence, Map<string, OriginLog>>()
function identityKey(p: PlanPresentation): string { return JSON.stringify([p.taskId, p.planId, p.revision, p.planDigest]) }
async function confirmedOrigin(persistence: Persistence | undefined, sessionId: string | null, p: PlanPresentation): Promise<string | null> {
  if (!persistence || !sessionId) return null
  let logs = originLogs.get(persistence)
  if (!logs) { logs = new Map(); originLogs.set(persistence, logs) }
  let log = logs.get(sessionId)
  if (!log) {
    if (logs.size >= 100) logs.delete(logs.keys().next().value!)
    log = { calls: new Set(), identities: new Set() }; logs.set(sessionId, log)
  }
  const key = identityKey(p)
  if (log.identities.has(key)) return sessionId
  const state = log
  state.pending ??= (async () => {
    let handle: Awaited<ReturnType<Persistence['open']>>
    try { handle = await persistence.open(sessionId, 'read') }
    catch (error) {
      if ((error as { code?: string }).code === 'SESSION_NOT_FOUND' || (error as Error).name === 'SessionPersistenceNotFoundError') return
      throw error
    }
    try {
      const offset = state.offset ?? handle.inheritedEventCount ?? 0
      const { events } = await handle.read(offset)
      for (const event of events) {
        const data = event.data as { name?: string; callId?: string; meta?: unknown; message?: { toolCallId?: string; isError?: boolean } } | null
        if (event.type === 'tool/call' && data?.name === 'commit_agent_prepare_plan' && typeof data.callId === 'string') state.calls.add(data.callId)
        if (event.type === 'tool/result' && data?.message?.isError !== true && state.calls.has(data?.message?.toolCallId ?? '') && isPlanPresentation(data?.meta)) state.identities.add(identityKey(data.meta))
      }
      state.offset = offset + events.length
    } finally { await handle.close() }
  })()
  try { await state.pending } finally { state.pending = undefined }
  return state.identities.has(key) ? sessionId : null
}

export interface PlanIndexEntry {
  sourceSessionId: string; taskId: string; planId: string; revision: number; digest: string; createdAt: string
  workspaceRoot: string; worktreePath: string; branch: string | null; status: StoredTask['plans'][number]['status']; commitCount: number
}
export async function recentPlanIndex(service: Pick<CommitAgentService, 'directory'>, options: { workspaceRoot?: string; limit?: number; offset?: number } = {}, persistence?: Persistence): Promise<{ schemaVersion: 1; plans: PlanIndexEntry[]; hasMore: boolean }> {
  const limit = options.limit ?? 50; const offset = options.offset ?? 0
  const tasks = await readTasks(service)
  const candidates = Object.values(tasks).flatMap(stored => stored.plans.map(plan => ({ task: stored.task, plan })))
    .filter(({ plan }) => options.workspaceRoot === undefined || plan.target.worktreePath === options.workspaceRoot)
    .sort((a, b) => b.plan.createdAt.localeCompare(a.plan.createdAt) || b.plan.revision - a.plan.revision || a.plan.taskId.localeCompare(b.plan.taskId) || a.plan.planId.localeCompare(b.plan.planId))
  const plans: PlanIndexEntry[] = []
  let skipped = 0
  for (const { task, plan } of candidates) {
    const p = identity(plan)
    const sourceSessionId = await readPlanPresentationSession(service.directory, p) ?? await confirmedOrigin(persistence, task.agentSessionId, p)
    if (sourceSessionId === null) continue
    if (skipped++ < offset) continue
    if (plans.length === limit) return { schemaVersion: 1, plans, hasMore: true }
    plans.push({ sourceSessionId, taskId: plan.taskId, planId: plan.planId, revision: plan.revision, digest: plan.planDigest, createdAt: plan.createdAt,
      workspaceRoot: plan.target.worktreePath, worktreePath: plan.target.worktreePath, branch: plan.target.branch, status: plan.status, commitCount: plan.commits.length })
  }
  return { schemaVersion: 1, plans, hasMore: false }
}

/** Exact recovery reads only the requested presentation, then verifies the store binding. */
export async function exactPlanPresentation(service: Pick<CommitAgentService, 'directory'>, sessionId: string, wanted: PlanIdentity, persistence?: Persistence): Promise<PlanPresentation | null> {
  const payload = await readPlanPresentation(service.directory, { ...wanted, planDigest: wanted.digest, commits: [], preview: [] }, sessionId)
  const tasks = await readTasks(service)
  if (!Object.hasOwn(tasks, wanted.taskId) || !tasks[wanted.taskId]!.plans.some(p => matches(p, wanted))) return null
  if (payload !== null) return payload
  return (await historical(persistence, sessionId)).find(p => matches(p, wanted)) ?? null
}

/** Lists publication snapshots in ascending durable revision order, scoped to the plan's originating session. */
export async function sessionPlanPresentations(
  service: Pick<CommitAgentService, 'directory'>, sessionId: string, persistence?: Persistence,
): Promise<PlanPresentation[]> {
  const tasks = await readTasks(service)
  const plans = Object.values(tasks).flatMap(stored => stored.plans)
  let history: PlanPresentation[] | undefined
  const result: PlanPresentation[] = []
  for (const plan of plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.revision - b.revision)) {
    const identity = { taskId: plan.taskId, planId: plan.planId, revision: plan.revision, planDigest: plan.planDigest, commits: [], preview: [] }
    let payload = await readPlanPresentation(service.directory, identity, sessionId)
    if (payload === null) {
      history ??= await historical(persistence, sessionId)
      payload = history.find(p => p.taskId === plan.taskId && p.planId === plan.planId && p.revision === plan.revision && p.planDigest === plan.planDigest) ?? null
    }
    // Never pretend an absent patch is an exact recovered presentation.
    if (payload !== null) result.push(payload)
  }
  return result
}

/** Uses existing public webServer route ownership and Connection Host/Origin + browser authentication admission. */
export function mountPlanHttpRoutes(owner: HostPluginContext, service: CommitAgentService): void {
  const host = owner as HostPluginContext & PlanHttpHost
  for (const [path, mode] of [['/git-commit-agent/api/plan', 'exact'], ['/git-commit-agent/api/plans', 'session'], ['/git-commit-agent/api/plan-index', 'index']] as const) {
    const exact = mode === 'exact'
    const dispose = host.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
      // Admission precedes even argument errors: no unauthenticated plan oracle.
      try {
        const admitted = host.connection.admit(req)
        if ('rejection' in admitted) { send(res, admitted.rejection, { error: admitted.rejection === 401 ? 'unauthorized' : 'forbidden' }); return }
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(res, 405, { error: 'method not allowed' }); return }
        const persistence = owner.get?.<Persistence>('sessionPersistence')
        if (mode === 'index') {
          let options: { workspaceRoot?: string; limit: number; offset: number }
          try {
            const url = new URL(req.url ?? '/', 'http://local')
            for (const key of url.searchParams.keys()) if (!['workspaceRoot', 'limit', 'offset'].includes(key)) throw new Error('unknown query')
            const integer = (key: string, fallback: number, min: number, max: number): number => {
              if (!url.searchParams.has(key)) return fallback
              const raw = query(url, key)
              if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error('bad integer')
              const n = Number(raw)
              if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('bad integer')
              return n
            }
            options = { limit: integer('limit', 50, 1, 100), offset: integer('offset', 0, 0, Number.MAX_SAFE_INTEGER) }
            if (url.searchParams.has('workspaceRoot')) options.workspaceRoot = query(url, 'workspaceRoot')
          } catch { send(res, 400, { error: 'invalid query' }); return }
          send(res, 200, await recentPlanIndex(service, options, persistence)); return
        }
        let sessionId: string
        let identity: PlanIdentity | undefined
        try {
          const url = new URL(req.url ?? '/', 'http://local')
          sessionId = query(url, 'sessionId')
          if (exact) {
            const revision = query(url, 'revision')
            if (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error('bad revision')
            identity = { taskId: query(url, 'taskId'), planId: query(url, 'planId'), revision: Number(revision), digest: query(url, 'digest') }
          }
          const allowed = new Set<string>(exact ? ['sessionId', ...fields] : ['sessionId'])
          for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new Error('unknown query')
        } catch { send(res, 400, { error: 'invalid query' }); return }
        if (identity === undefined) { send(res, 200, { schemaVersion: 1, sessionId, plans: await sessionPlanPresentations(service, sessionId, persistence) }); return }
        const plan = await exactPlanPresentation(service, sessionId, identity, persistence)
        if (plan === null) { send(res, 404, { error: 'plan not found' }); return }
        send(res, 200, plan)
      } catch (error) {
        owner.logger?.warn?.('dsh-git-commit-agent: plan recovery failed', error)
        if (!res.headersSent) send(res, 500, { error: 'plan recovery unavailable' })
        else res.destroy()
      }
    } })
    owner.effect?.(() => dispose)
  }
}
