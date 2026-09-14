/**
 * Durable task/plan storage.
 *
 * The transcript is not the business database: tasks, every plan revision,
 * approvals and every execution record live in one JSON file in the *plugin's*
 * data directory (never inside the target repository, so planning never
 * dirties the worktree it is analysing).
 *
 * Writes are copy-on-write: the whole document is serialised to a temporary
 * file and atomically renamed, so a crash mid-write leaves the previous
 * document intact. Plan versions are append-only — an old revision and its
 * execution record are never overwritten.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GitCommitError } from '../errors.js'
import type { CommitTask, ExecutionRecord, PlanApproval, PlanStatus, PlanVersion } from '../types.js'

/** One task plus its append-only plan/execution history. */
export interface StoredTask {
  task: CommitTask
  plans: PlanVersion[]
  executions: ExecutionRecord[]
}

/** On-disk document shape. */
interface StoreDocument {
  schemaVersion: 1
  tasks: Record<string, StoredTask>
}

/** Serialise mutations behind one promise chain. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => undefined)
    return next
  }
}

/** Durable store for commit tasks. */
export class CommitAgentStore {
  private readonly file: string
  private readonly mutex = new Mutex()
  private document: StoreDocument = { schemaVersion: 1, tasks: {} }
  private loaded = false

  constructor(dataDir: string) {
    this.file = join(dataDir, 'store.json')
  }

  /** Path of the backing file (for diagnostics). */
  get storePath(): string {
    return this.file
  }

  /** Load the document, tolerating a missing file. */
  async init(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.loaded) return
      await mkdir(dirname(this.file), { recursive: true })
      try {
        const raw = await readFile(this.file, 'utf8')
        const parsed = JSON.parse(raw) as StoreDocument
        if (parsed.schemaVersion === 1 && parsed.tasks !== undefined) this.document = parsed
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          // A corrupt store must not silently become an empty store: move it
          // aside so the operator can inspect it, then start clean.
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined)
        }
      }
      this.loaded = true
    })
  }

  /** Persist the document atomically. */
  private async flush(): Promise<void> {
    const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temporary, JSON.stringify(this.document, null, 2), 'utf8')
    await rename(temporary, this.file)
  }

  /** Find the open task bound to one source session + worktree, if any. */
  async findOpenTask(sourceSessionId: string | null, repositoryId: string, worktreePath: string): Promise<StoredTask | null> {
    await this.init()
    return this.mutex.run(async () => {
      for (const stored of Object.values(this.document.tasks)) {
        if (stored.task.status !== 'open') continue
        if (stored.task.sourceSessionId !== sourceSessionId) continue
        if (stored.task.target.repositoryId !== repositoryId) continue
        if (stored.task.target.worktreePath !== worktreePath) continue
        return structuredClone(stored)
      }
      return null
    })
  }

  /** Find the open task bound to one agent session, if any. */
  async findOpenTaskByAgentSession(agentSessionId: string): Promise<StoredTask | null> {
    await this.init()
    return this.mutex.run(async () => {
      for (const stored of Object.values(this.document.tasks)) {
        if (stored.task.status !== 'open') continue
        if (stored.task.agentSessionId === agentSessionId) return structuredClone(stored)
      }
      return null
    })
  }

  /** Insert a new task. */
  async insertTask(task: CommitTask): Promise<StoredTask> {
    await this.init()
    return this.mutex.run(async () => {
      if (this.document.tasks[task.taskId] !== undefined) {
        throw new GitCommitError('INTERNAL', `task ${task.taskId} already exists`)
      }
      const stored: StoredTask = { task, plans: [], executions: [] }
      this.document.tasks[task.taskId] = stored
      await this.flush()
      return structuredClone(stored)
    })
  }

  /** Read one task. */
  async getTask(taskId: string): Promise<StoredTask | null> {
    await this.init()
    return this.mutex.run(async () => {
      const stored = this.document.tasks[taskId]
      return stored === undefined ? null : structuredClone(stored)
    })
  }

  /** List every task, newest first. */
  async listTasks(): Promise<CommitTask[]> {
    await this.init()
    return this.mutex.run(async () =>
      Object.values(this.document.tasks)
        .map((stored) => stored.task)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    )
  }

  /** Append a new immutable plan revision. */
  async appendPlan(taskId: string, plan: PlanVersion): Promise<PlanVersion> {
    await this.init()
    return this.mutex.run(async () => {
      const stored = this.requireTask(taskId)
      if (stored.plans.some((p) => p.planId === plan.planId && p.revision === plan.revision)) {
        throw new GitCommitError('INTERNAL', `plan ${plan.planId} revision ${plan.revision} already exists`)
      }
      stored.plans.push(plan)
      stored.task = {
        ...stored.task,
        latestRevision: plan.revision,
        updatedAt: plan.createdAt,
      }
      await this.flush()
      return structuredClone(plan)
    })
  }

  /** Fetch one plan revision (latest when `revision` is omitted). */
  async getPlan(taskId: string, planId: string, revision?: number): Promise<PlanVersion | null> {
    await this.init()
    return this.mutex.run(async () => {
      const stored = this.document.tasks[taskId]
      if (stored === undefined) return null
      const matches = stored.plans.filter((p) => p.planId === planId)
      if (matches.length === 0) return null
      if (revision === undefined) {
        return structuredClone(matches.reduce((a, b) => (a.revision >= b.revision ? a : b)))
      }
      const found = matches.find((p) => p.revision === revision)
      return found === undefined ? null : structuredClone(found)
    })
  }

  /** The newest plan of a task. */
  async getLatestPlan(taskId: string): Promise<PlanVersion | null> {
    await this.init()
    return this.mutex.run(async () => {
      const stored = this.document.tasks[taskId]
      if (stored === undefined || stored.plans.length === 0) return null
      return structuredClone(stored.plans.reduce((a, b) => (a.revision >= b.revision ? a : b)))
    })
  }

  /** Mutate one plan revision in place (status/approval/execution only). */
  async patchPlan(
    taskId: string,
    planId: string,
    revision: number,
    patch: { status?: PlanStatus; approval?: PlanApproval | null; execution?: ExecutionRecord | null },
  ): Promise<PlanVersion> {
    await this.init()
    return this.mutex.run(async () => {
      const stored = this.requireTask(taskId)
      const target = stored.plans.find((p) => p.planId === planId && p.revision === revision)
      if (target === undefined) {
        throw new GitCommitError('PLAN_NOT_FOUND', `plan ${planId} revision ${revision} was not found`, {
          taskId,
          planId,
          revision,
        })
      }
      const updated: PlanVersion = {
        ...target,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.approval === undefined ? {} : { approval: patch.approval }),
        ...(patch.execution === undefined ? {} : { execution: patch.execution }),
      }
      const index = stored.plans.indexOf(target)
      stored.plans[index] = updated
      stored.task = { ...stored.task, updatedAt: new Date().toISOString() }
      await this.flush()
      return structuredClone(updated)
    })
  }

  /** Append an execution record to the task history. */
  async appendExecution(taskId: string, record: ExecutionRecord): Promise<void> {
    await this.init()
    await this.mutex.run(async () => {
      const stored = this.requireTask(taskId)
      stored.executions.push(record)
      stored.task = { ...stored.task, updatedAt: new Date().toISOString() }
      await this.flush()
    })
  }

  /** Mark every still-open plan of a task stale (target moved underneath it). */
  async markPlansStale(taskId: string, exceptPlanId?: string): Promise<void> {
    await this.init()
    await this.mutex.run(async () => {
      const stored = this.requireTask(taskId)
      let changed = false
      stored.plans = stored.plans.map((plan) => {
        if (plan.planId === exceptPlanId) return plan
        if (plan.status !== 'ready' && plan.status !== 'draft') return plan
        changed = true
        return { ...plan, status: 'stale' as PlanStatus, approval: null }
      })
      if (changed) {
        stored.task = { ...stored.task, updatedAt: new Date().toISOString() }
        await this.flush()
      }
    })
  }

  /**
   * Revoke the approval and executable status of every plan revision except
   * the one just published. Publishing a new revision therefore invalidates
   * all older cards, exactly as the design requires.
   */
  async revokeOtherRevisions(taskId: string, keepRevision: number): Promise<void> {
    await this.init()
    await this.mutex.run(async () => {
      const stored = this.requireTask(taskId)
      let changed = false
      stored.plans = stored.plans.map((plan) => {
        if (plan.revision === keepRevision) return plan
        if (plan.approval === null && plan.status !== 'ready') return plan
        changed = true
        return { ...plan, status: 'stale' as PlanStatus, approval: null }
      })
      if (changed) {
        stored.task = { ...stored.task, updatedAt: new Date().toISOString() }
        await this.flush()
      }
    })
  }

  /** Mark a task closed. */
  async closeTask(taskId: string): Promise<void> {    await this.init()
    await this.mutex.run(async () => {
      const stored = this.requireTask(taskId)
      stored.task = { ...stored.task, status: 'closed', updatedAt: new Date().toISOString() }
      await this.flush()
    })
  }

  /** Every execution record across all tasks (diagnostics/reconciliation). */
  async allExecutions(): Promise<ExecutionRecord[]> {
    await this.init()
    return this.mutex.run(async () => Object.values(this.document.tasks).flatMap((t) => t.executions))
  }

  /** Look up a task or throw. */
  private requireTask(taskId: string): StoredTask {
    const stored = this.document.tasks[taskId]
    if (stored === undefined) {
      throw new GitCommitError('PLAN_NOT_FOUND', `task ${taskId} was not found`, { taskId })
    }
    return stored
  }
}
