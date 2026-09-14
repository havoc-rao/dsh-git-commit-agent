/**
 * Structural mirrors of the DSH host services this plugin consumes.
 *
 * These are intentionally *structural* types, not imports: the host provides
 * `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-agent`
 * at runtime, and the plugin must not pull them into its own dependency graph.
 * Every member below was read from the DSH 0.1.5-rc.2 source during the P0
 * verification pass; see `docs/P0-VERIFICATION.md` for the file:line evidence.
 *
 * Nothing here is a new host API — it is a mirror of the verified one.
 */

/** A JSON Schema node, as the host's tool registry accepts it. */
export type JsonSchemaNode = Record<string, unknown>

/** One content block returned to the model (mirror of dsh-llm's ContentBlock). */
export interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** The host's tool definition shape (`packages/core/tools/src/index.ts:214`). */
export interface HostToolDefinition {
  readonly name: string
  readonly description: string
  /** Raw JSON Schema for the parameter object. */
  readonly parameters: JsonSchemaNode
  readonly output: {
    readonly schema: JsonSchemaNode
    render(args: unknown, value: unknown): ContentBlock[]
    /**
     * Pure, replayable presentation metadata for direct top-level calls
     * (`packages/core/tools/src/index.ts:204-211`). The model never sees it; a
     * client-side view can. Must be JSON-serializable and must not throw on
     * obsolete logged arguments.
     */
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  execute(args: unknown, exec: HostToolRunContext): Promise<unknown>
}

/** The session face of the calling agent. */
export interface HostAgentSession {
  readonly id: string
}

/** The calling agent (only the members the tools read). */
export interface HostAgent {
  readonly id: string
  readonly session: HostAgentSession
  /**
   * The agent's own scoped context. This is where per-session tools are
   * registered (`agent.ctx.tools.register`) and where `restrict`/`guard` apply
   * to exactly this agent. Optional in this structural mirror because the tool
   * execution path never reads it — only the `agent/created` install path does.
   */
  readonly ctx?: HostScopedContext
}

/**
 * Tool execution context (`packages/core/tools/src/index.ts:397`).
 *
 * Verified on a live host: there is no `cwd` member, so the tools never read
 * one. Only `agent` and `signal` are used.
 */
export interface HostToolRunContext {
  readonly agent?: HostAgent
  readonly signal: { readonly aborted: boolean; throwIfAborted(): void }
}

/** Tool registry face (`tools.register` / `restrict` / `guard`). */
export interface HostToolRegistry {
  register(definition: HostToolDefinition): () => void
  restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void
  guard(guard: (execution: unknown) => string | undefined): () => void
}

/** A scoped context exposing the tool registry (an agent's `ctx`). */
export interface HostScopedContext {
  readonly tools: HostToolRegistry
}

/** Agent handle returned by `AgentRegistry.create` / `resume`. */
export interface HostAgentHandle {
  readonly agent: HostAgent & {
    /**
     * Enqueue one user message. The argument is a complete `UserMessage`
     * (`{ id, role: 'user', content, source }`, `packages/llm/llm/src/message.ts:131-145`);
     * pass a factory-produced object, not `{ text }`.
     */
    followup(message: unknown): void | Promise<void>
    /** Verified present and non-optional (`runtime-types.ts:191`). */
    whenIdle(): Promise<void>
  }
  dispose(): Promise<void>
}

/** `CreateAgentOptions` (subset actually used). */
export interface HostCreateAgentOptions {
  readonly sessionId: string
  readonly setup?: (agentCtx: HostScopedContext, agent: HostAgent) => void | Promise<void>
  readonly meta?: {
    readonly cwd?: string
    readonly agentPreset?: string
    readonly parentSession?: string
    /** Deliberately NOT set: our session must be a normal, sidebar-visible session. */
    readonly origin?: 'subagent'
  }
  readonly agentOptions?: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly maxTokens?: number
  }
  readonly signal?: AbortSignal
}

/** `ResumeAgentOptions` (subset actually used). */
export interface HostResumeAgentOptions {
  readonly resumeSessionId: string
  readonly setup?: (agentCtx: HostScopedContext, agent: HostAgent) => void | Promise<void>
}

/** Agent registry face (`ctx.agents`). */
export interface HostAgentRegistry {
  create(options: HostCreateAgentOptions): Promise<HostAgentHandle>
  resume(options: HostResumeAgentOptions): Promise<HostAgentHandle>
  get(id: string): HostAgent | undefined
  /**
   * Every live agent, used at mount time to install tools into commit sessions
   * that already exist (a plugin mounted after the first session).
   */
  list?(): readonly HostAgent[]
}

/** Client session controller face used for navigation (`ISessions`). */
export interface HostSessionsClient {
  create(options?: { readonly sessionId?: string; readonly cwd?: string; readonly workspaceId?: string }): Promise<string>
  open(id: string): void
  refresh(): Promise<void>
}

/**
 * Live session store face (`ctx.sessions`, `packages/core/session/src/index.ts:1177`).
 * `get` returns only live sessions; the header carries the authoritative cwd.
 */
export interface HostSessionStore {
  get(id: string): { readonly header?: { readonly cwd?: string } } | undefined
}

/**
 * One Workspace entity (`packages/workspace/workspace/src/types.ts:31-96`).
 *
 * The sidebar groups Sessions by Workspace membership (`Workspace.sessionIds`),
 * not by cwd; a Session created with only a `cwd` is never a member and falls
 * into the Ungrouped bucket. `attachSession` is the host-side way to join one,
 * and it validates that the Session's stored header cwd realpath-equals
 * {@link path} (`entity.ts:124-152`).
 */
export interface HostWorkspace {
  readonly id: string
  /** Canonical (`realpath`) directory the Workspace owns. */
  readonly path: string
  attachSession(sessionId: string): Promise<void>
}

/**
 * Workspace registry face (`ctx.workspaceRegistry`,
 * `packages/workspace/workspace/src/index.ts:114`, `resolveByPath` `:276`).
 *
 * Optional on the host: a host booted without the workspace package has no
 * registry, and grouping is then simply unavailable rather than fatal.
 */
export interface HostWorkspaceRegistry {
  /** The Workspace whose canonical path equals this path, if any. */
  resolveByPath(path: string): Promise<HostWorkspace | undefined>
}

/**
 * `ctx.userQuestions` (`packages/interaction/user-questions/src/index.ts:65-178`).
 *
 * `ask` is the host-owned human decision surface. The `plan-review` intent makes
 * a capable UI render the plans as a review panel; the answer encoding is the
 * same either way.
 */
export interface HostUserQuestionService {
  ask(request: {
    readonly questions: ReadonlyArray<{
      readonly id: string
      readonly question: string
      readonly detail?: string
      readonly header?: string
      readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
      readonly multiSelect?: boolean
      readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
    }>
    readonly agent?: unknown
    readonly signal?: AbortSignal
  }): Promise<{ readonly answers: ReadonlyArray<{ readonly id: string; readonly selected: string[]; readonly custom?: string }> }>
}

/** Minimal Cordis plugin context face. */
export interface HostPluginContext {
  readonly tools: HostToolRegistry
  /**
   * Lazy service lookup. Unlike property access, `get` returns `undefined` for
   * an unprovided service instead of throwing `cannot get property "X" without
   * inject` (verified live: `vendor/cordis/src/reflect.ts:233-243`). The plugin
   * uses it for `agents` so it still mounts on a host without an agent registry.
   */
  get?<T = unknown>(name: string): T | undefined
  readonly logger?: {
    info?(message: string, ...rest: unknown[]): void
    warn?(message: string, ...rest: unknown[]): void
    error?(message: string, ...rest: unknown[]): void
  }
  effect?(fn: () => (() => void) | void): unknown
  provide?(name: string, value?: unknown): unknown
  on?(event: string, listener: (...args: unknown[]) => void): () => void
}

/** A Cordis plugin module (`apply(ctx, config)`). */
export interface HostPluginModule {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: HostPluginContext, config?: unknown): void
}
