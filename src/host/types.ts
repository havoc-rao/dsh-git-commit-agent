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
}

/** Client session controller face used for navigation (`ISessions`). */
export interface HostSessionsClient {
  create(options?: { readonly sessionId?: string; readonly cwd?: string; readonly workspaceId?: string }): Promise<string>
  open(id: string): void
  refresh(): Promise<void>
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
