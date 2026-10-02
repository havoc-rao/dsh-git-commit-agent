/**
 * dsh-git-commit-agent — host plugin entry.
 *
 * A Cordis plugin (`apply(ctx, config)`) that mounts the commit-agent service,
 * installs the restricted tool surface into commit sessions only, and exposes a
 * small business API other plugins (for example the GitLens entry in
 * DSH-better-sidebar) call to open a task, approve one plan revision, execute
 * it, or navigate to the session.
 *
 * Packaging follows the verified DSH contract: `package.json.dsh.bundle.patch`
 * plus a `cordis.patch.yml` insert row. There is no `dsh.plugin.json` contract
 * in the verified DSH checkout.
 */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { CommitAgentService, defaultDataDir } from './core/service.js'
import {
  COMMIT_AGENT_DEFAULT_MODEL_FIELD,
  COMMIT_AGENT_PROMPT_LANGUAGE_FIELD,
  PROMPT_LANGUAGE_PATTERN,
  isDefaultModelPreference,
  resolvePromptLanguage,
  type DefaultModelPreference,
  type PromptLanguagePreference,
} from './config.js'
import type { PlanDraft } from './core/plan/validate.js'
import type { ExecutionResult, PlanVersion, Snapshot } from './core/types.js'
import { GitCommitError, asGitCommitError } from './core/errors.js'
import {
  buildCommitAgentTools,
  COMMIT_AGENT_SESSION_PREFIX,
  COMMIT_AGENT_TOOL_NAMES,
  installCommitAgentScope,
  isCommitAgentSession,
  type ToolDependencies,
  type UserApprovalDecision,
  type UserApprovalPrompt,
} from './host/tools.js'
import {
  buildCommitAgentSystemPrompt,
  buildInitialPlanRequest,
  createDedicatedCommitSession,
  requestInitialPlan,
  resumeDedicatedCommitSession,
  type DedicatedSession,
  type DedicatedSetup,
  type UserMessageFactory,
} from './host/session.js'
import type {
  HostAgent,
  HostAgentPresetRegistry,
  HostAgentRegistry,
  HostApprovalOutcome,
  HostApprovalService,
  HostPluginContext,
  HostScopedContext,
  HostSessionStore,
  HostSettingsForms,
  HostWorkspaceRegistry,
} from './host/types.js'

/** Plugin name, matching the cordis row and package name. */
export const name = 'dsh-git-commit-agent'

/**
 * Volatile settings schema for this plugin's profile entry (`git-commit-agent`).
 *
 * Following the locale preference template (`packages/client/locale`): only
 * the volatile fields are editable live; everything else stays in the cordis
 * row. The schema instance comes from this plugin's own schemastery
 * dependency (same version as the host), and the host settings service reads
 * it structurally (`meta`, `dict`, `toJSON`), so no host package import is
 * needed on the plugin side.
 */
export const Config = z.object({
  /** Prompt language applied to newly admitted sessions; `follow-ui` delegates to the UI locale. */
  [COMMIT_AGENT_PROMPT_LANGUAGE_FIELD]: z.string().pattern(PROMPT_LANGUAGE_PATTERN).volatile(),
  /**
   * Default LLM route (provider/model from the model catalog) applied to newly
   * created dedicated sessions. Optional on purpose: when the field is absent
   * the deployment `agentOptions` row applies, and when that is absent too the
   * host default model is used.
   */
  [COMMIT_AGENT_DEFAULT_MODEL_FIELD]: z.object({
    provider: z.string(),
    model: z.string(),
  }).volatile(),
})

/**
 * The settings namespace = the profile entry id (the cordis row `id` in
 * `cordis.patch.yml`, NOT the module name). The host settings service finds an
 * entry by `entry.options.id` and rejects every other key with
 * "No configurable plugin entry", so this must match the patch row exactly.
 * Kept in sync by hand with `cordis.patch.yml` and `client/client.js`
 * (`SETTINGS_NAMESPACE`).
 */
export const PROFILE_ENTRY_ID = 'git-commit-agent'

/** The settings field name; re-exported for the client half and tests. */
export { COMMIT_AGENT_DEFAULT_MODEL_FIELD, COMMIT_AGENT_PROMPT_LANGUAGE_FIELD }

/** Prompt-language resolution; re-exported so embedders and tests share one resolver. */
export {
  PROMPT_LANGUAGE_IDS,
  PROMPT_LANGUAGE_PATTERN,
  resolvePromptLanguage,
  type PromptLanguagePreference,
  type ResolvedPromptLanguage,
} from './config.js'

/** Default-model preference; re-exported so embedders and tests share one validator. */
export {
  isDefaultModelPreference,
  type DefaultModelPreference,
} from './config.js'

/**
 * Agent-preset identity this plugin registers into the host's preset registry.
 *
 * The preset appears in the settings roster (AgentPresetSection) and is what
 * dedicated sessions are bound to and recorded under (`meta.agentPreset`). Its
 * composition is empty by design: the commit-agent capability set is installed
 * by this plugin's `agent/created` + session-prefix path, and declaring the
 * plugin as a composition row would double-mount it inside the preset scope and
 * fail the registry's service-leak audit.
 */
export const COMMIT_AGENT_PRESET_ID = 'git-commit'

/** Services required before mounting. */
export const inject = ['tools']

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

/**
 * Build the plugin without mounting it. Useful for tests and for hosts that
 * wiring services explicitly.
 */
export function createCommitAgentPlugin(
  options: CommitAgentConfig & {
    readonly agents?: HostAgentRegistry
    /**
     * Lazy agent-registry lookup. Preferred over `agents`: it is resolved at
     * call time, so the plugin does not depend on `ctx.agents` being injectable
     * (or even present) at mount time.
     */
    readonly resolveAgents?: () => HostAgentRegistry | undefined
    /**
     * Lazy agent-preset lookup, resolved at call time like `resolveAgents`.
     * When it yields a registry, dedicated sessions are bound to
     * {@link COMMIT_AGENT_PRESET_ID} at create/resume time (`setup` +
     * `agentPresets.mount`, the webhook session creator's pattern) and the
     * session header records the preset. A missing registry or a failed mount
     * degrades to today's unbound behavior — binding never fails session
     * creation.
     */
    readonly resolveAgentPresets?: () => HostAgentPresetRegistry | undefined
    /**
     * Lazy settings lookup, resolved at call time like `resolveAgents`. When
     * it yields a settings service, the prompt-language preference is read
     * from this plugin's own namespace for each newly admitted session. A
     * missing service degrades to the default language.
     */
    readonly resolveSettings?: () => HostSettingsForms | undefined
    /**
     * Where mount failures are reported. Absent on embedder-created plugins
     * (binding then stays fully silent); `apply` passes `ctx.logger` so live
     * hosts see the reason while session creation still proceeds unbound.
     */
    readonly logger?: { readonly warn?: (message: string, ...rest: unknown[]) => void }
    readonly newSessionId?: () => string
    readonly createUserMessage?: UserMessageFactory
    /**
     * Best-effort host hook that attaches a freshly created session to the
     * Workspace that owns `workspacePath`, so the sidebar groups it under the
     * original workspace instead of the Ungrouped bucket. A missing registry or
     * an unattachable path is a no-op; grouping must never fail session creation.
     */
    readonly attachWorkspaceSession?: (sessionId: string, workspacePath: string) => Promise<void>
  } = {},
): CommitAgentPlugin {
  const service = new CommitAgentService({
    dataDir: options.dataDir ?? defaultDataDir(),
    ...(options.lockDir === undefined ? {} : { lockDir: options.lockDir }),
  })
  const sessions = new Map<string, DedicatedSession>()
  const newSessionId =
    options.newSessionId ?? (() => `${COMMIT_AGENT_SESSION_PREFIX}${randomUUID()}`)

  const requireAgents = (): HostAgentRegistry => {
    const agents = options.resolveAgents?.() ?? options.agents
    if (agents === undefined) {
      throw new GitCommitError(
        'INTERNAL',
        'no agent registry is available: the host did not provide an "agents" service',
      )
    }
    return agents
  }

  /**
   * Setup that binds a dedicated session to {@link COMMIT_AGENT_PRESET_ID},
   * mirroring the webhook session creator (`webhook/src/session.ts:139-142`).
   *
   * Binding is metadata plus the standing composition; the five tools arrive
   * through the `agent/created` listener regardless, so a missing registry or
   * a failed mount must never fail session creation — the session then simply
   * stays unbound, exactly like before this registration existed.
   */
  const bindAgentPreset = async (agentCtx: HostScopedContext): Promise<void> => {
    const agentPresets = options.resolveAgentPresets?.()
    if (agentPresets === undefined || typeof agentPresets.mount !== 'function') return
    try {
      await agentPresets.mount(agentCtx, COMMIT_AGENT_PRESET_ID)
    } catch (error) {
      options.logger?.warn?.(
        `dsh-git-commit-agent: session stays without an agent preset: `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }
  const presetBindingSetup = (): DedicatedSetup | undefined => {
    const agentPresets = options.resolveAgentPresets?.()
    return agentPresets !== undefined && typeof agentPresets.mount === 'function' ? bindAgentPreset : undefined
  }

  /**
   * Read the stored prompt-language preference from the plugin's own settings
   * namespace. Hosts without the settings service report `undefined`, which
   * resolves to the default language (`en` on the host plane, which has no UI
   * locale to follow).
   */
  const readStoredPromptLanguage = (): PromptLanguagePreference | undefined => {
    const settings = options.resolveSettings?.()
    if (settings === undefined || typeof settings.describe !== 'function') return undefined
    const row = settings.describe().find((entry) => entry.ns === PROFILE_ENTRY_ID)
    const value = row?.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const field = (value as Record<string, unknown>)[COMMIT_AGENT_PROMPT_LANGUAGE_FIELD]
    return typeof field === 'string' ? field as PromptLanguagePreference : undefined
  }
  const promptLanguage = (): 'zh' | 'en' => resolvePromptLanguage(readStoredPromptLanguage(), 'en')

  /**
   * Read the stored default-model preference from the plugin's own settings
   * namespace, with the same entry-id addressing as
   * {@link readStoredPromptLanguage}. Hosts without the settings service (or
   * with a malformed stored value) report no default.
   */
  const readStoredDefaultModel = (): DefaultModelPreference | undefined => {
    const settings = options.resolveSettings?.()
    if (settings === undefined || typeof settings.describe !== 'function') return undefined
    const row = settings.describe().find((entry) => entry.ns === PROFILE_ENTRY_ID)
    const value = row?.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const field = (value as Record<string, unknown>)[COMMIT_AGENT_DEFAULT_MODEL_FIELD]
    return isDefaultModelPreference(field) ? field : undefined
  }

  /**
   * Model route for a dedicated session, in precedence order:
   *
   * 1. the **stored settings preference** (the user's explicit choice in the
   *    preset-card configure surface) — it overrides the deployment row;
   * 2. the deployment `agentOptions` row (other fields such as
   *    `reasoningEffort` / `maxTokens` are preserved), when no preference is
   *    stored;
   * 3. nothing — the host default model applies.
   */
  const resolveAgentOptions = (): CommitAgentConfig['agentOptions'] | undefined => {
    const stored = readStoredDefaultModel()
    if (stored === undefined) return options.agentOptions
    return { ...options.agentOptions, provider: stored.provider, model: stored.model }
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
      // Make sure the data directory is usable *before* creating a session, so
      // a bad dataDir cannot leave an orphaned session behind.
      await service.init()
      // The five tools are installed by the `agent/created` listener in
      // `apply`, matched on the reserved session-id prefix that `newSessionId`
      // mints. No tool is installed here — a session created by the plugin and
      // one created by the GitLens button take the exact same tool path. The
      // only thing added here is the preset binding (`setup` + header record);
      // it is metadata, never the tool surface.
      const setup = presetBindingSetup()
      // The stored default-model preference wins over the deployment row; an
      // absent preference delegates to the row, and an absent row leaves the
      // host default untouched (`resolveAgentOptions`).
      const agentOptions = resolveAgentOptions()
      const session = await createDedicatedCommitSession({
        agents,
        newSessionId,
        workspacePath: input.workspacePath,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(setup === undefined ? {} : { agentPresetId: COMMIT_AGENT_PRESET_ID }),
      }, ...(setup === undefined ? [] : [setup]))
      sessions.set(session.sessionId, session)
      // Group the session under the Workspace that owns its directory. The
      // sidebar groups by Workspace membership, not by cwd, so a session that is
      // never attached lands in 未分组 even when its cwd is a registered
      // Workspace. Grouping is cosmetic: a failure here must not block planning.
      if (options.attachWorkspaceSession !== undefined) {
        await options.attachWorkspaceSession(session.sessionId, input.workspacePath).catch(() => undefined)
      }
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
      }, promptLanguage())
      await requestInitialPlan(
        session.handle,
        prompt,
        ...(options.createUserMessage === undefined ? [] : [options.createUserMessage]),
      )
      return { sessionId: session.sessionId, taskId: state.task.taskId, prompt }
    },

    async resumeDedicatedSession(resumeSessionId) {
      const agents = requireAgents()
      const setup = presetBindingSetup()
      const session = await resumeDedicatedCommitSession(
        { agents, resumeSessionId },
        ...(setup === undefined ? [] : [setup]),
      )
      sessions.set(session.sessionId, session)
      return session
    },

    systemPrompt: () => buildCommitAgentSystemPrompt(promptLanguage()),
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

/** The English plan-approval question for a single-commit plan (`src/core/review.ts`). */
const APPROVE_QUESTION_SINGLE = 'Approve this plan and allow the executor to create 1 commit?'

/** Chinese presentation of the generated plan-approval question. */
function approvalQuestionZh(question: string): string {
  if (question === APPROVE_QUESTION_SINGLE) {
    return '批准该提交计划并允许执行器创建 1 个提交？'
  }
  const many = /^Approve this plan and allow the executor to create (\d+) commits\?$/.exec(question)
  return many === null ? question : `批准该提交计划并允许执行器创建 ${many[1]} 个提交？`
}

/**
 * Ask the host's `approval` service for one plan-approval decision.
 *
 * This is the single place the plugin crosses into the standard approval
 * channel (`approval/request` → `approval/decided` on the agent's session log,
 * rendered client-side by the host's ui-approval ApprovalPanel). It replaces
 * the old user-questions `plan-review` call: the decision now travels as an
 * approval event and only `ctx.get('approval').request()` produces it.
 *
 * Design notes, all verified against the host sources:
 *
 * - `ApprovalRequest` has no detail field: the full plan document stays in the
 *   transcript (`commit_agent_prepare_plan` already presented it) and the
 *   approval panel receives a short reason plus localized display copy. The
 *   panel can additionally render `conversation.approval.detail` correlation
 *   through `callId`, which the apply tool forwards when the host execution
 *   carries one.
 * - The audit pair must be turn-enclosed (`user-approval/src/index.ts:84-92`):
 *   the `approval/asked` + `approval/decided` events are only durable inside an
 *   open turn. The ONLY caller of this function is the `commit_agent_apply_plan`
 *   tool, whose execution always runs inside the model's turn, so the
 *   precondition holds. The business API (`api.approvePlan`) never goes through
 *   this path — it is a programmatic entry for other host integrations.
 * - Failing closed: a host without the service, a non-function service, or an
 *   execution without a calling agent rejects with a coded error before
 *   anything is asked; every outcome except `'allowed-once'` maps to
 *   `{ approved: false }`.
 *
 * @param approval - the live `ctx.get('approval')` value (may be absent).
 * @param prompt - the approval prompt assembled by the apply tool.
 * @returns the closed decision the apply tool consumes.
 */
export async function requestPlanApproval(
  approval: HostApprovalService | undefined,
  prompt: UserApprovalPrompt,
): Promise<UserApprovalDecision> {
  if (approval === undefined || typeof approval.request !== 'function') {
    throw new GitCommitError(
      'BAD_ARGUMENT',
      'this host has no approval service, so an interactive approval cannot be requested; '
      + 'approve through the business API instead',
    )
  }
  if (prompt.agent === undefined) {
    throw new GitCommitError(
      'BAD_ARGUMENT',
      'the approval service requires the calling agent, which is missing from this tool execution',
    )
  }
  let outcome: HostApprovalOutcome
  try {
    outcome = await approval.request({
      agent: prompt.agent,
      toolName: prompt.toolName,
      ...(prompt.callId === undefined ? {} : { callId: prompt.callId }),
      // The audit events persist `reason` verbatim; the client shows
      // `displayReason` (localized) when present. Chinese is the primary
      // presentation copy; the English question stays as the stable audit text.
      reason: prompt.question,
      displayReason: { en: prompt.question, zh: approvalQuestionZh(prompt.question) },
      ...(prompt.signal === undefined ? {} : { signal: prompt.signal }),
    })
  } catch (error) {
    // A service failure (for example the idle-turn refusal) must fail the ask
    // closed as a coded error; the tool boundary normalizes it for the model.
    throw asGitCommitError(error)
  }
  return { approved: outcome === 'allowed-once' }
}

/** Mount the plugin: register tools and expose the business API on the context. */
export function apply(ctx: HostPluginContext, config?: unknown): CommitAgentPlugin {
  const options = (config ?? {}) as CommitAgentConfig

  /**
   * Resolve a host service lazily.
   *
   * `ctx.agents` (property access) throws `cannot get property "agents" without
   * inject` when `agents` is not declared in `inject` and its provider is a
   * sibling row — verified on a live host, and it aborted the whole boot. `get`
   * returns `undefined` instead (`vendor/cordis/src/reflect.ts:233-243`), which
   * keeps this plugin mountable on hosts without an agent registry and removes
   * any ordering dependency on the `agents` row.
   */
  const getService = <T>(name: string): T | undefined => {
    const get = ctx.get
    if (typeof get !== 'function') return undefined
    return get.call(ctx, name) as T | undefined
  }

  const plugin = createCommitAgentPlugin({
    ...options,
    resolveAgents: () => getService<HostAgentRegistry>('agents'),
    resolveAgentPresets: () => getService<HostAgentPresetRegistry>('agentPresets'),
    resolveSettings: () => getService<HostSettingsForms>('settings'),
    logger: ctx.logger,
    /**
     * Attach a newly created dedicated session to the Workspace that owns its
     * directory. Without this the session has a cwd but no Workspace
     * membership, and the sidebar's workspace tree shows it under 未分组
     * (`ui-workspace/src/client/tree.ts` `owningGroupKey`).
     */
    attachWorkspaceSession: async (sessionId, workspacePath) => {
      const registry = getService<HostWorkspaceRegistry>('workspaceRegistry')
      if (registry === undefined || typeof registry.resolveByPath !== 'function') return
      const workspace = await registry.resolveByPath(workspacePath)
      if (workspace === undefined || typeof workspace.attachSession !== 'function') return
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        ctx.logger?.warn?.(
          `dsh-git-commit-agent: session ${sessionId} stays ungrouped: `
          + (error instanceof Error ? error.message : String(error)),
        )
      }
    },
  })

  const deps: ToolDependencies = {
    service: plugin.service,
    resolveWorkspace: async (agentSessionId) => {
      if (options.resolveWorkspace !== undefined) return await options.resolveWorkspace(agentSessionId)
      // Fall back to the live session's authoritative cwd. The only sessions
      // that ever reach these tools are the commit sessions, whose cwd is the
      // planned worktree, so this is the same directory the task was opened on.
      const sessions = getService<HostSessionStore>('sessions')
      const cwd = sessions?.get?.(agentSessionId)?.header?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : null
    },
    ...(options.resolveSourceSession === undefined
      ? {}
      : { resolveSourceSession: options.resolveSourceSession }),
    askUserApproval: async (prompt) => requestPlanApproval(
      getService<HostApprovalService>('approval'),
      prompt,
    ),
  }

  const definitions = buildCommitAgentTools(deps)

  /**
   * Install the five tools into one commit-agent session.s scope.
   *
   * `agent/created` is emitted while the agent is being registered — before
   * `agent/session-start` and the first prompt assembly — for both `create` and
   * `resume`, so a session created by the GitLens button and one created
   * through the business API take the exact same path. The reserved session-id
   * prefix is the whole contract, because it is the only thing the host knows
   * about a session the client created (see `COMMIT_AGENT_SESSION_PREFIX`).
   *
   * Nothing is registered on the plugin's own context: a global registration
   * would put the tools in every session's model surface.
   */
  const installed = new Map<string, () => void>()
  const installAgent = (agent: HostAgent | undefined): void => {
    if (agent === undefined || installed.has(agent.id) || !isCommitAgentSession(agent.id)) return
    const agentCtx = agent.ctx
    if (agentCtx === undefined) return
    try {
      installed.set(agent.id, installCommitAgentScope(agentCtx, definitions))
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-git-commit-agent: could not install tools for ${agent.id}: `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }
  const uninstallAgent = (agent: HostAgent | undefined): void => {
    if (agent === undefined) return
    installed.get(agent.id)?.()
    installed.delete(agent.id)
  }
  const payloadAgent = (payload: unknown): HostAgent | undefined =>
    (payload as { agent?: HostAgent } | undefined)?.agent

  // Sessions that already exist when the plugin mounts (a late row, or HMR).
  for (const agent of getService<HostAgentRegistry>('agents')?.list?.() ?? []) installAgent(agent)
  ctx.on?.('agent/created', (payload) => installAgent(payloadAgent(payload)))
  ctx.on?.('agent/disposed', (payload) => uninstallAgent(payloadAgent(payload)))

  if (typeof ctx.provide === 'function') ctx.provide('gitCommitAgent', plugin.api)
  ctx.logger?.info?.('dsh-git-commit-agent mounted')

  /**
   * Register this agent as a DSH agent preset, the standard way.
   *
   * The registry is the host's single roster: the settings page
   * (`ui-agent-preset` AgentPresetSection) renders `agentPresets.list()`, so
   * an entry here appears as a card that can be viewed and set as the default
   * with zero client changes. Registration is the same call the declarative
   * `@deepseek-ai/dsh-agent-preset` plugin wraps, just executed from the
   * plugin's own mount so the definition cannot drift from this plugin's code.
   *
   * The composition is empty on purpose — see {@link HostPresetDefinition}.
   * The registry is optional: a host without the preset package simply has no
   * roster, and a duplicate id (a second mount of this plugin, HMR) means the
   * earlier registration already owns the entry.
   */
  const registerPreset = (owner: HostPluginContext, agentPresets: HostAgentPresetRegistry): void => {
    let retired = false
    let unregister: (() => Promise<void>) | undefined
    const release = (dispose: () => Promise<void>): void => {
      void dispose().catch((error: unknown) => {
        ctx.logger?.warn?.(`dsh-git-commit-agent: preset disposal failed: ${String(error)}`)
      })
    }
    owner.effect?.(() => () => {
      retired = true
      if (unregister !== undefined) release(unregister)
      unregister = undefined
    })
    void agentPresets
      .register({
        id: COMMIT_AGENT_PRESET_ID,
        name: 'Git Commit Agent',
        description:
          'Dedicated Git commit planning and execution agent: analyses status and diff, materialises an exact '
          + 'add/commit plan, binds your approval to one plan revision, and runs a restricted git executor.',
        order: 30,
        plugins: [],
      })
      .then((dispose) => {
        if (retired) {
          release(dispose)
          return
        }
        unregister = dispose
        ctx.logger?.info?.(`dsh-git-commit-agent: preset ${COMMIT_AGENT_PRESET_ID} registered`)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('Duplicate agent preset')) {
          ctx.logger?.info?.(`dsh-git-commit-agent: preset ${COMMIT_AGENT_PRESET_ID} already registered`)
        } else {
          ctx.logger?.warn?.(`dsh-git-commit-agent: preset registration failed: ${message}`)
        }
      })
  }

  // Cordis activation is asynchronous: patch order is not service readiness.
  // Let a dependency-owned child wait for the registry and own its registration.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentPresets'], (child) => {
      const registry = child.agentPresets
      if (registry === undefined) throw new Error('agentPresets injection resolved without its service')
      registerPreset(child, registry)
    })
    // Following the locale template (`packages/client/locale`): opt this
    // entry out of an auto-generated settings page while keeping its volatile
    // fields editable through the forms/slots pipeline.
    ctx.inject(['settings'], (child) => {
      const declared = child.settings?.configure?.({ auto: false }, ctx.fiber)
      if (declared !== undefined) child.effect?.(() => declared)
    })
  } else {
    // Minimal embedders without Cordis injection retain one-shot compatibility.
    const registry = getService<HostAgentPresetRegistry>('agentPresets')
    if (registry !== undefined && typeof registry.register === 'function') registerPreset(ctx, registry)
    else ctx.logger?.info?.('dsh-git-commit-agent: no agentPresets service; preset registration skipped')
  }

  ctx.effect?.(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    void plugin.dispose()
  })

  // NOTE: Cordis invokes `export function apply` through `new` and discards the
  // returned value, so returning the plugin is safe for embedders/tests. This
  // relies on `apply` remaining a *function declaration*: an arrow function or
  // method shorthand that returns an object would make Cordis treat the return
  // value as an effect and fail with `Invalid effect`.
  return plugin
}
