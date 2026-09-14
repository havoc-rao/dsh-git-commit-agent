> Provenance: this is the raw read-only audit produced during the P0 pass against the
> local DSH checkout (`0.1.5-rc.2`), kept verbatim as primary evidence. The consolidated,
> decision-oriented summary is [`P0-VERIFICATION.md`](./P0-VERIFICATION.md).

# DSH host-plugin API contract report (read-only verification)

Checkout: `/Users/havoc/Documents/Projects/tools/deepseek-harness` (TS source only; no `lib/`/`dist/`).

## 0. Versions and package identities — CONFIRMED

- Root `package.json:2-3` → `"name": "@deepseek-ai/dsh-root"`, `"version": "0.1.5-rc.2"`.
- `packages/core/agent/package.json:2-4` → `@deepseek-ai/dsh-agent` @ `0.1.5-rc.2`.
- `packages/core/tools/package.json:2-4` → `@deepseek-ai/dsh-tools` @ `0.1.5-rc.2`.
- `@deepseek-ai/dsh-agent-loop`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-package-manifest` are all `0.1.5-rc.2`.

Packages a host plugin depends on / peer-depends on:
`@deepseek-ai/cordis` (must be in BOTH peerDependencies and devDependencies, same range),
`@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-session`;
for `resume`: type-only `@deepseek-ai/dsh-session-persistence`; for composition you also need
`@deepseek-ai/dsh-agent-loop` loaded at runtime (the factory provider, see §1).

---

## 1. Agent API — CONFIRMED (exact signatures)

`packages/core/agent/src/index.ts`

- Registry class: `export class AgentRegistry extends Service` (`:245`); augments `Context` with `agents: AgentRegistry` (`:26-30`).
- `setFactory(factory: AgentFactory): () => void` (`:355`).
- `async create(options: CreateAgentOptions): Promise<AgentHandle>` (`:388`).
- `async resume(options: ResumeAgentOptions): Promise<AgentHandle>` (`:407`).
- `register(agent: Agent): () => void` (`:434`); `enter(agent, owner)` (`:458`); `announce(agent)` (`:533`).
- `get(id: SessionId): Agent | undefined` (`:567`); `isOwnedBy(id, owner)` (`:579`); `list(): Agent[]` (`:587`); `roots(): Agent[]` (`:597`).

`CreateAgentOptions` (`:62-119`) — verbatim required/optional fields:
```
readonly sessionId: SessionId            // :64  REQUIRED — caller-supplied identity
readonly parentAgent?: Agent             // :66
readonly meta?: { cwd?; parentSession?; isSeeded?; origin?: 'subagent';
                  delegationDepth?; agentPreset? }   // :78-85
readonly inheritedEventCount?: SessionLogOffset  // :87
readonly seed?: readonly SessionEvent[]  // :95
readonly agentOptions?: AgentOptions     // :97
readonly signal?: AbortSignal            // :99
readonly setup?: AgentSetup              // :118
```
`ResumeAgentOptions` (`:125-144`): `readonly resumeSessionId: SessionId` (`:127`), `parentAgent?` (`:129`),
`agentOptions?` (`:131`), `signal?` (`:133`), `setup?` (`:143`).
`AgentHandle` (`:160-163`): `{ agent: Agent; dispose(): Promise<void> }`.
`AgentSetup` (`:50-53`):
```
export type AgentSetup = (
  agentCtx: Context,
  agent: Agent,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void
```
`AgentFactory` (`:171-203`): `createAgent(ownerCtx, options): Promise<AgentHandle>` (`:190`),
`resume(ownerCtx, options): Promise<AgentHandle>` (`:202`).

`AgentOptions` (`packages/core/agent/src/runtime-types.ts:26-35`):
`{ provider?: string; model?: string; reasoningEffort?: ReasoningEffortId; maxTokens?: number }`.

Agent runtime object: base `Agent` is just `{ readonly id: SessionId }` (`types.ts:13-16`), augmented in
`runtime-types.ts:163-243` with `options`, `session: Session`, `inbox: Inbox`, `status: 'idle'|'running'`,
`ctx: Context`, plus:
- `cancel(cause: AgentCancelCause, options?: CancelOptions): void` (`:183`)
- `whenIdle(): Promise<void>` (`:191`)
- `runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>` (`:202`)
- `send(message, target, wakeup): void` (`:215`)
- `followup(message: UserMessage): void` (`:222`)
- `steer(message: UserMessage): void` (`:231`)
- `inject(message: UserMessage): void` (`:241`)

**Verdicts**
- `create` requires: loaded agent-loop factory + `sessionId` + `setup` (optional but needed for scoped tools/restrictions).
  `create` itself needs no `sessionPersistence`; `createStoredSession` returns `undefined` without a backend
  (`agent-loop/src/index.ts:730-732`), but the session is then memory-only.
- **Session id is caller-supplied, not returned**: `create()` returns `AgentHandle`; `handle.agent.id === handle.agent.session.id`
  (enforced at `agent/src/index.ts:459-462`). Generate with `brandString<SessionId>(\`session-${randomUUID()}\`)`
  (`SessionId(id: string)` at `packages/core/session/src/types.ts:19-27`). Reads like the repo's own
  `bundle/headless/src/index.ts:185-193` and `api/session-controller/src/commands.ts:91`.
- `setup(agentCtx, agent)` composes only; it receives the **unpublished** agent's scoped ctx. All registrations
  (scoped tools, `restrict()`, prompt sections, listeners) exist before `agent/created` / first prompt
  (`agent/src/index.ts:100-118`).
- **`resume` takes `resumeSessionId`** and requires `sessionPersistence`; it opens the persisted log for write,
  reads + repairs it, then re-runs `setup` (`agent-loop/src/index.ts:844-889`). Without persistence it throws
  `cannot resume: session persistence is not configured (load a dsh-session-persistence backend)` (`:847`).
- **No factory → hard error**: `no agent factory registered (load an agent-loop plugin)` (`agent/src/index.ts:206`).
- **Client wiring — PARTIALLY CONFIRMED.** There is no separate "host session" object: the `SessionId` is the join
  key. `create()` publishes a live `Session` in `ctx.sessions` (keyed by `SessionId`, `packages/core/session/src/index.ts:1177`)
  and writes durable events through persistence. The web client creates/opens sessions via
  `ApiSessionController.create({ sessionId?, cwd?/workspaceId?, agentPreset? })`
  (`api/session-controller/src/commands.ts:87-126`, types at `types.ts:265-276`): passing an existing `sessionId`
  with `checkPersistedIdentity=true` makes it adopt the live agent (`ensureSession` → `createOrAdopt`,
  `agent.ts:232-269,437-488`), otherwise `ctx.agents.resume(...)` (`agent.ts:430-434`). So a session created by a
  plugin is openable by the web client iff it is live in `ctx.sessions` or persisted and reachable by `sessionQuery`.
- **Session-list visibility gotcha**: `ApiSessionList.list()` reads `sessionQuery.listSessions()`; live sessions are
  summarized directly, while **cold (persisted-only) sessions are skipped when `header.cwd === undefined`**
  (`api/session-controller/src/list.ts:126-141`, esp. `:138`). Set `meta.cwd` if the session must remain visible to
  the web client after restart.

---

## 2. Tools API — CONFIRMED (exact signatures)

`packages/core/tools/src/index.ts`

- `register(definition: ToolDefinition): () => void` (`:1027`). Throws `TypeError` unless `definition.output` is
  `{ render, schema, presentationMeta? }` (`:1029-1034`); rejects the reserved name `run_code` (`:1044-1046`);
  scoped vs global is decided by the calling `ctx` (agent scope shadows global; duplicate name in one layer throws).
- `restrict(filter: ToolRestriction): () => void` (`:1061`).
- `guard(guard: ToolGuard): () => void` (`:1100`).
- `get(name, scope?): ToolDefinition | undefined` (`:1194`); `schemas(scope?): ToolSchema[]` (`:1224`);
  `executionMode(exec)` (`:1266`); `async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>` (`:1332`).

Types:
- `ToolRestriction` (`:673-678`): `{ readonly allow?: readonly string[]; readonly deny?: readonly string[] }`.
- `ToolGuard` (`:704`): `(execution: Readonly<ToolExecution>) => string | undefined` — a returned string denies.
- `ToolDefinition extends ToolSchema` (`:214-280`): `name`, `description`, `parameters` (from `ToolSchema`) plus
  ```ts
  readonly output: ToolOutputDefinition            // :216
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>   // :227
  finalizeContent?(exec, result): ContentBlock[] | undefined       // :239
  timeoutMs?: number                                // :247
  isConcurrencySafe?(args: unknown): boolean        // :261
  presentCall?(args): ToolCallView | undefined      // :271
  presentResult?(args, result): ToolResultView | undefined  // :279
  ```
- `ToolOutputDefinition` (`:204-211`): `{ readonly schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }`.
- `ToolRunContext extends ToolExecution` (`:397-414`): adds `deferContext(context: UserMessage): void` and `concludeTurn(): void`.

**Schema format — CONFIRMED.** `ToolSchema` lives in `@deepseek-ai/dsh-llm` (`packages/llm/llm/src/types.ts:411-416`):
`name: string; description: string; parameters: Record<string, unknown>` — i.e. **raw JSON Schema** on the
wire/`ToolDefinition`. Authors normally write the SDK DSL `ValueSchemaSpec`/`ParameterSchemaSpec`
(`tools/src/schema.ts:12-106`), which `defineTool` compiles to the enforced JSON Schema subset:
`defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S,O>): ToolDefinition`
(`schema.ts:545-547`; options `:483-536`). Not zod. `ToolRuntime.Config` uses schemastery (`index.ts:783-786`).

**Result return to the model — CONFIRMED.** `execute` returns the canonical JSON value declared by `output.schema`;
the registry validates/snapshots it and calls `output.render(args, value)` to produce the model-facing
`ContentBlock[]` (`ToolExecutionSuccess`, `:549-559`; `ToolExecutionResult` discriminant `:573`). Policy waterfalls
`tools/pre-execute`, `tools/execute`, `tools/post-execute`, `tools/result` (`:129-200`) can rewrite the outcome.
Failure: throw inside `execute` → `ToolExecutionFailure { isError: true, error, content }`.

**`restrict` scoping — CONFIRMED, with self-scope exemption.** `restrict` throws on a plain (global) context:
`tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent`
(`:1064`). Empty `{}` throws (`:1069`); `run_code` cannot be named (`:1076`); every named tool must be a currently
known **inherited** (global/ancestor) name, else `tools.restrict() names unknown global tool ...` (`:1078-1082`).
Restrictions **intersect** along the scope chain and filter only the inherited surface; **the scope's own
registrations are exempt and always visible** (`view()`, `:1127-1138` doc + `:1159-1173` code). Canonical use:
`childCtx.tools.restrict(composition.toolFilter)` in `subagent/src/child-agent.ts:217`, documented at
`subagent/src/types.ts:185-192` ("the named tools vanish from the child's prompt AND refuse to execute").
`guard` is monotonic deny-only: any guard may deny, none can force-allow (`:696-704`, `:1108-1118`).

---

## 3. Plugin packaging and loading — CONFIRMED

- **There is NO `dsh.plugin.json` contract in this checkout.** `find . -name 'dsh.plugin.json'` (excluding
  `node_modules`) returns nothing. The parent plugin's `package.json` `files` entry naming `dsh.plugin.json` is
  unsupported. (`cordis.patch.yml` + `dsh.bundle` is the real mechanism.)
- **`package.json.dsh` field**: typed in `packages/util/package-manifest/src/types.ts:8-82`:
  `DshManifest = { manifestVersion?: 1; bundle?: { patch: string }; profile?: { bundles?: string[]; patchReload?: 'live'|'startup' }; client?: { platform; inject?; immediately?; external? } }`.
  A host plugin needs only `dsh.bundle` **if it ships an installable configuration layer**; `dsh.client` is for
  web/client modules only.
- **Cordis plugin export shape** (three accepted forms) — `docs/cordis-tutorial/01-first-plugin.md`:
  `export function apply(ctx: Context, config?)`, an object with an `apply` method, or a `Service` subclass
  (class form). Optional exports: `name` (diagnostic label) and `inject` (required service names; Cordis holds the
  plugin PENDING until they exist — `docs/cordis-tutorial/03-services.md`). `Config` (schemastery) is an optional
  named export. In-repo example: `packages/schedule/schedule/src/index.ts:35-40` exports
  `name = 'schedule'`, `inject = ['agents','sessions','tools','sessionPersistence']`.
- **Loading** is Cordis Loader over a `cordis.yml`/`cordis.patch.yml` list of entries
  (`{ id?, name, config?, disabled? }`). `name` is a module specifier (package name or relative path).
  Install path: `dsh plugin --profile <name> add <pkg>` forwards to pnpm in the profile dir and reconciles
  `dsh.profile.bundles` by whether the package declares `dsh.bundle` (`apps/cli/src/plugin.ts:36-91`).
  **A package without `dsh.bundle` installs only as a plain dependency and activates no layer** (`plugin.ts:70-75`).
- **Minimal working host plugin (bundle) file set** — `docs/user/develop/basic/publish.md`:
  ```
  hello-plugin/package.json   # { "type":"module", "main":"index.js", "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
  hello-plugin/index.js       # export const name; export function apply(ctx, config)
  hello-plugin/cordis.patch.yml  # - insert: [{ id: hello, name: dsh-hello-plugin }]
  ```
  With TypeScript, add `tsconfig.json` + `src/index.ts`, build to `lib/`, and point `main`/`exports` at `lib/`.
  The repo's own package invariants (`docs/cookbook/adding-a-package.md`): `type: module`, `main: lib/index.js`,
  `types: lib/types/index.d.ts`, `exports["."]`, version pinned to root, `@deepseek-ai/cordis` in peer+dev.
- **Injected services a host plugin needs**: `tools` (`ToolRuntime`, itself `inject = ['systemPrompt']`,
  `tools/src/index.ts:781`), `agents`, `sessions`; for resume `sessionPersistence`. Optional deps use
  `ctx.inject(['x'], childCtx => ...)` or `ctx.get('x')`.
- **Confirmed plugin examples to copy**: `packages/schedule/schedule/src/index.ts`,
  `packages/subagent/subagent-in-process-driver/src/index.ts:122-152` (`setup` + `ctx.agents.create` + drive),
  `packages/bundle/headless/src/index.ts:185-213` (`create` → `followup` → `whenIdle` → `sessions.flush`),
  `packages/webhook/webhook/src/session.ts:133`.

---

## 4. Verdict summary

| Question | Verdict |
|---|---|
| `AgentRegistry.create/resume/get/list/roots/isOwnedBy` signatures | CONFIRMED (§1) |
| `create` requires caller-supplied `sessionId`; returns `AgentHandle` | CONFIRMED |
| `create` optional fields: `setup`, `agentOptions`, `meta`, `parentAgent`, `seed`, `inheritedEventCount`, `signal` | CONFIRMED |
| `setup(agentCtx, agent)` composes scoped tools/restrictions before publication | CONFIRMED |
| `resume` takes `resumeSessionId`, requires `sessionPersistence`, reloads/re-pairs log, re-runs `setup` | CONFIRMED |
| `create` needs an agent-loop factory; no factory = throw | CONFIRMED |
| Agent runtime object has `id`, `session`, `inbox`, `status`, `ctx`, `followup`, `steer`, `send`, `inject`, `cancel`, `whenIdle`, `runMaintenance` | CONFIRMED |
| `create` makes a live+persisted session openable by the web client via `SessionId` | CONFIRMED (needs persistence; `cwd` for cold list visibility) |
| `tools.register/restrict/guard` signatures | CONFIRMED |
| Tool schema = raw JSON Schema (`ToolSchema`), author DSL via `defineTool` | CONFIRMED (not zod) |
| `register` requires `output {schema, render}` | CONFIRMED |
| `restrict` scope + self-scope exemption | CONFIRMED |
| `dsh.plugin.json` manifest | **ABSENT — does not exist in this checkout** |
| package.json `dsh` block contract | CONFIRMED (`dsh.bundle.patch` for bundles; `dsh.client` only for client plugins) |
| Cordis `apply(ctx, config)` plugin shape + `inject` | CONFIRMED |

Key gotchas for the git-commit-agent plugin:
1. Drop `dsh.plugin.json`; the real manifest is `dsh.bundle.patch` + `cordis.patch.yml`.
2. Tools need `output.schema` + `output.render`; a bare `{name,description,parameters,execute}` throws at `register`.
3. `restrict()` only works inside the agent's `setup` (`agentCtx`), only names already-registered **global/inherited**
   tools, and never filters tools you register in that same scope.
4. To keep a plugin-created session visible in the web client after restart, set `meta.cwd` and mount a
   `sessionPersistence` backend; otherwise it is visible only while live.
5. The plugin should peer-depend on `@deepseek-ai/dsh-agent` (interface), not `@deepseek-ai/dsh-agent-loop`
   (the loop is a runtime composition dependency).
