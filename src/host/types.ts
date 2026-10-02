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
 * one. Only `agent`, `signal` and `callId` are used.
 *
 * `callId` mirrors the host's `ToolRunContext.callId: ToolCallId` — a branded
 * string (`packages/llm/llm/src/brand.ts:29-31`) that correlates the tool call
 * in the transcript with the approval panel. The tools forward it verbatim to
 * the approval request so the client can attach the decision to the exact call.
 */
export interface HostToolRunContext {
  readonly agent?: HostAgent
  readonly callId?: string
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
 * One closed outcome of an approval request
 * (`packages/interaction/user-approval/src/types.ts:32`): a one-shot grant,
 * explicit rejection, withdrawn request, or unavailable answerer. Callers fail
 * closed on everything except `'allowed-once'`.
 */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * `ctx.approval` (`packages/interaction/user-approval/src/index.ts:150-234`,
 * registered as `super(ctx, 'approval')`).
 *
 * `request` asks the composed answerers for one decision while the requesting
 * session has an **open turn** — the audit pair (`approval/asked` +
 * `approval/decided`) must be turn-enclosed, so an idle ask rejects. Tool
 * execution always runs inside the model's turn, which is exactly why the
 * approval is requested from the tool path and never from the business API.
 * `agent` is the live host agent; the plugin passes it through untouched.
 */
export interface HostApprovalService {
  request(request: {
    readonly agent: unknown
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
    /** Localized presentation copy; never persisted in the audit events. */
    readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
    readonly signal?: AbortSignal
  }): Promise<HostApprovalOutcome>
}

/** One child plugin row of a preset composition (`PresetDefinition['plugins']`, definition.ts:5-11). */
export interface HostAgentPresetRow {
  readonly id?: string
  readonly name: string
  readonly config?: unknown
}

/**
 * `PresetDefinition` (`packages/preset/agent-preset-registry/src/definition.ts:5-11`).
 *
 * A preset declares an agent composition. The commit agent's composition is
 * intentionally empty: its capability set arrives from this plugin's own
 * `agent/created` + session-prefix installation, so declaring `plugins` rows
 * here would double-mount the plugin (a second `CommitAgentService` in the
 * preset scope) and fail the registry's root-realm leak audit
 * (`mount.ts` `leakedServices`).
 */
export interface HostPresetDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly HostAgentPresetRow[]
}

/**
 * `ctx.agentPresets` face (`packages/preset/agent-preset-registry/src/index.ts`).
 *
 * `register` eagerly activates the composition and returns a disposer the
 * declaring plugin owns; a duplicate id rejects. `mount` binds an unpublished
 * agent's scope to one preset revision so the session inherits that standing
 * composition (the only production caller is the webhook session creator).
 * Optional on the host: a host without the preset package has no registry, and
 * registration plus binding degrade to today's unbound behavior.
 */
export interface HostAgentPresetRegistry {
  register(definition: HostPresetDefinition): Promise<() => Promise<void>>
  mount?(agentCtx: unknown, id?: string): Promise<{ readonly id: string }>
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
  /** Dependency-owned child; reactivates when its required service becomes available. */
  inject?(names: readonly string[], callback: (ctx: HostPluginContext) => void): unknown
  readonly agentPresets?: HostAgentPresetRegistry
  readonly settings?: HostSettingsForms
  readonly logger?: {
    info?(message: string, ...rest: unknown[]): void
    warn?(message: string, ...rest: unknown[]): void
    error?(message: string, ...rest: unknown[]): void
  }
  effect?(fn: () => (() => void) | void): unknown
  provide?(name: string, value?: unknown): unknown
  on?(event: string, listener: (...args: unknown[]) => void): () => void
  /** The plugin instance's fiber; passed as the settings presentation owner. */
  readonly fiber?: unknown
}

/** One settings descriptor row returned by `settings.describe()` (`SettingsDescriptor`). */
export interface HostSettingsDescriptor {
  readonly ns: string
  /** Live value projected over the form schema (only volatile fields). */
  readonly value: unknown
}

/**
 * `ctx.settings` face (`packages/settings/settings/src/index.ts`). Only the
 * members this plugin reads: `describe` for live volatile values (the read
 * side of the prompt-language preference) and `configure` to opt out of
 * auto-generated settings pages. Optional on the host.
 */
export interface HostSettingsForms {
  describe?(options?: { readonly redactSecrets?: boolean }): readonly HostSettingsDescriptor[]
  configure?(presentation: { readonly auto?: boolean }, owner?: unknown): (() => void) | undefined
}

/** A Cordis plugin module (`apply(ctx, config)`). */
export interface HostPluginModule {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: HostPluginContext, config?: unknown): void
}
