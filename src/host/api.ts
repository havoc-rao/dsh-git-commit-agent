/** Public configuration and business API contracts for the host plugin. */
import type { CommitAgentService } from '../core/service.js'
import type { PlanDraft } from '../core/plan/validate.js'
import type { ExecutionResult, PlanVersion, Snapshot } from '../core/types.js'
import type { DedicatedSession } from './session.js'

/** Plugin configuration from the cordis row. */
export interface CommitAgentConfig {
  /** Where tasks/plans/executions are persisted. Defaults to `~/.dsh/git-commit-agent`. */
  readonly dataDir?: string
  /** Lock directory; `null` disables the on-disk lock (in-process lock still applies). */
  readonly lockDir?: string | null
  /** Model options for the dedicated session. A stored settings preference
   * (`defaultModel`) overrides the model/provider here when both exist; the
   * other options still apply. */
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
