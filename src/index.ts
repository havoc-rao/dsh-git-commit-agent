/**
 * dsh-git-commit-agent — host plugin entry.
 *
 * A Cordis plugin (`apply(ctx, config)`) that mounts the commit-agent service,
 * registers the restricted tool surface, and exposes a small business API other
 * plugins (for example the GitLens entry in DSH-better-sidebar) call to open a
 * task, approve one plan revision, execute it, or navigate to the session.
 *
 * Packaging follows the verified DSH contract: `package.json.dsh.bundle.patch`
 * plus a `cordis.patch.yml` insert row. There is no `dsh.plugin.json` contract
 * in the verified DSH checkout.
 */
import { randomUUID } from 'node:crypto'
import { CommitAgentService, defaultDataDir } from './core/service.js'
import type { PlanDraft } from './core/plan/validate.js'
import type { ExecutionResult, PlanVersion, Snapshot } from './core/types.js'
import { GitCommitError } from './core/errors.js'
import {
  COMMIT_AGENT_TOOL_NAMES,
  registerCommitAgentTools,
  restrictCommitAgentScope,
  type ToolDependencies,
} from './host/tools.js'
import {
  buildCommitAgentSystemPrompt,
  buildInitialPlanRequest,
  createDedicatedCommitSession,
  requestInitialPlan,
  resumeDedicatedCommitSession,
  type DedicatedSession,
} from './host/session.js'
import type { HostAgentRegistry, HostPluginContext, HostScopedContext } from './host/types.js'

/** Plugin name, matching the cordis row and package name. */
export const name = 'dsh-git-commit-agent'

/** Services required before mounting. */
export const inject = ['tools']

/** Plugin configuration from the cordis row. */
export interface CommitAgentConfig {
  /** Where tasks/plans/executions are persisted. Defaults to `~/.dsh/git-commit-agent`. */
  readonly dataDir?: string
  /** Lock directory; `null` disables the on-disk lock (in-process lock still applies). */
  readonly lockDir?: string | null
  /** Model options for the dedicated session. */
  readonly agentOptions?: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly maxTokens?: number
  }
  /** Resolve a session's worktree when no task has been opened for it yet. */
  readonly resolveWorkspace?: (agentSessionId: string) => Promise<string | null>
  /** Resolve the coding session that dispatched a task. */
  readonly resolveSourceSession?: (agentSessionId: string) => string | null
}

/** The business API the GitLens entry and the plan card call. */
export interface GitCommitAgentApi {
  /** Open (or reuse) the task for a source session + worktree. */
  openTask(input: {
    sourceSessionId: string | null
    agentSessionId: string | null
    workspaceRoot: string
    signal?: AbortSignal
  }): Promise<{ taskId: string; snapshot: Snapshot; plans: readonly PlanVersion[] }>
  /** Current state, with a fresh snapshot and stale plans marked. */
  getState(taskId: string, options?: { passes?: number; signal?: AbortSignal }): Promise<{
    taskId: string
    target: { repositoryId: string; worktreePath: string; branch: string | null; head: string | null }
    snapshot: Snapshot
    plans: readonly PlanVersion[]
  }>
  /** Publish a new plan revision (the agent normally does this through its tool). */
  publishPlan(taskId: string, draft: PlanDraft, options?: { signal?: AbortSignal }): Promise<{
    plan: PlanVersion
    preview: unknown
  }>
  /** Approve one exact revision + digest. Call this only from a user-initiated surface. */
  approvePlan(input: {
    taskId: string
    planId: string
    revision: number
    planDigest: string
    requestId: string
    approvedBy: string
  }): Promise<PlanVersion>
  /** Withdraw an approval. */
  withdrawApproval(taskId: string, planId: string, revision: number): Promise<PlanVersion>
  /** Execute an approved revision. */
  executePlan(input: { taskId: string; planId: string; revision: number; signal?: AbortSignal }): Promise<ExecutionResult>
  /** Cancel a running execution. */
  cancel(taskId: string): boolean
  /** Reconcile a plan against real history. */
  reconcile(taskId: string, planId: string, revision: number, signal?: AbortSignal): Promise<unknown>
  /** Create the dedicated session and deliver the first planning request. */
  startDedicatedSession(input: {
    workspacePath: string
    sourceSessionId: string | null
    userConstraints?: string
    signal?: AbortSignal
  }): Promise<{ sessionId: string; taskId: string; prompt: string }>
  /** Resume a dedicated session after a restart (no approval is restored). */
  resumeDedicatedSession(resumeSessionId: string): Promise<DedicatedSession>
  /** The dedicated agent's system prompt. */
  systemPrompt(): string
  /** The names of every tool this plugin registers. */
  readonly toolNames: readonly string[]
}

/** The plugin instance created by {@link createCommitAgentPlugin}. */
export interface CommitAgentPlugin {
  readonly api: GitCommitAgentApi
  readonly service: CommitAgentService
  /** Dispose tools, service state and any created sessions. */
  dispose(): Promise<void>
}

/**
 * Build the plugin without mounting it. Useful for tests and for hosts that
 * wiring services explicitly.
 */
export function createCommitAgentPlugin(
  options: CommitAgentConfig & { readonly agents?: HostAgentRegistry; readonly newSessionId?: () => string } = {},
): CommitAgentPlugin {
  const service = new CommitAgentService({
    dataDir: options.dataDir ?? defaultDataDir(),
    ...(options.lockDir === undefined ? {} : { lockDir: options.lockDir }),
  })
  const sessions = new Map<string, DedicatedSession>()
  const newSessionId = options.newSessionId ?? (() => `session-${randomUUID()}`)

  const requireAgents = (): HostAgentRegistry => {
    if (options.agents === undefined) {
      throw new GitCommitError('INTERNAL', 'the host has no agent registry available for git commit sessions')
    }
    return options.agents
  }

  const api: GitCommitAgentApi = {
    toolNames: COMMIT_AGENT_TOOL_NAMES,

    async openTask(input) {
      const state = await service.openTask(input)
      return { taskId: state.task.taskId, snapshot: state.snapshot, plans: state.plans }
    },

    async getState(taskId, opts = {}) {
      const state = await service.getState(taskId, opts)
      return { taskId, target: state.task.target, snapshot: state.snapshot, plans: state.plans }
    },

    async publishPlan(taskId, draft, opts = {}) {
      const published = await service.publishPlan(taskId, draft, opts)
      return { plan: published.plan, preview: published.preview }
    },

    approvePlan: (input) => service.approvePlan(input),
    withdrawApproval: (taskId, planId, revision) => service.withdrawApproval(taskId, planId, revision),
    executePlan: (input) => service.executePlan(input),
    cancel: (taskId) => service.cancel(taskId),
    reconcile: (taskId, planId, revision, signal) => service.reconcile(taskId, planId, revision, signal),

    async startDedicatedSession(input) {
      const agents = requireAgents()
      const setup = (agentCtx: HostScopedContext): void => {
        restrictCommitAgentScope(agentCtx)
      }
      const session = await createDedicatedCommitSession(
        {
          agents,
          newSessionId,
          workspacePath: input.workspacePath,
          ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        setup,
      )
      sessions.set(session.sessionId, session)
      const state = await service.openTask({
        sourceSessionId: input.sourceSessionId,
        agentSessionId: session.sessionId,
        workspaceRoot: input.workspacePath,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      const prompt = buildInitialPlanRequest({
        taskId: state.task.taskId,
        worktreePath: state.task.target.worktreePath,
        branch: state.snapshot.head.branch,
        head: state.snapshot.head.commit,
        snapshot: state.snapshot,
        indexEmpty: state.snapshot.indexEmpty,
        ...(input.userConstraints === undefined ? {} : { userConstraints: input.userConstraints }),
      })
      await requestInitialPlan(session.handle, prompt)
      return { sessionId: session.sessionId, taskId: state.task.taskId, prompt }
    },

    async resumeDedicatedSession(resumeSessionId) {
      const agents = requireAgents()
      const setup = (agentCtx: HostScopedContext): void => {
        restrictCommitAgentScope(agentCtx)
      }
      const session = await resumeDedicatedCommitSession({ agents, resumeSessionId }, setup)
      sessions.set(session.sessionId, session)
      return session
    },

    systemPrompt: () => buildCommitAgentSystemPrompt(),
  }

  return {
    api,
    service,
    async dispose() {
      for (const session of sessions.values()) {
        await session.handle.dispose().catch(() => undefined)
      }
      sessions.clear()
    },
  }
}

/** Mount the plugin: register tools and expose the business API on the context. */
export function apply(ctx: HostPluginContext, config?: unknown): CommitAgentPlugin {
  const options = (config ?? {}) as CommitAgentConfig
  const agents = (ctx as unknown as { agents?: HostAgentRegistry }).agents
  const plugin = createCommitAgentPlugin({ ...options, ...(agents === undefined ? {} : { agents }) })

  const deps: ToolDependencies = {
    service: plugin.service,
    resolveWorkspace: async (agentSessionId) => {
      if (options.resolveWorkspace !== undefined) return await options.resolveWorkspace(agentSessionId)
      // Without a host callback, only an already-opened task can resolve a worktree.
      return null
    },
    ...(options.resolveSourceSession === undefined
      ? {}
      : { resolveSourceSession: options.resolveSourceSession }),
  }

  const disposeTools = registerCommitAgentTools(ctx, deps)
  const provide = (ctx as unknown as { provide?: (key: string, value: unknown) => void }).provide
  provide?.('gitCommitAgent', plugin.api)
  ctx.logger?.info?.('dsh-git-commit-agent mounted')

  ctx.effect?.(() => () => {
    disposeTools()
    void plugin.dispose()
  })

  return plugin
}
