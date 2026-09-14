# P0 — Host API verification record

- Date: 2026-09-14
- Verified against: local read-only checkout `/Users/havoc/Documents/Projects/tools/deepseek-harness`
- Host version in that checkout: **`0.1.5-rc.2`** (root `package.json`, and
  `packages/core/agent/package.json`, `packages/core/tools/package.json`,
  `packages/core/session/package.json` all agree)
- Second reference (read-only): `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` @ `0.20.0`

Nothing in the DSH checkout or in `DSH-better-sidebar` was modified. Evidence is
quoted from TypeScript **source** (`packages/**/src/**`); generated `lib/`/`dist`
bundles are never treated as a contract.

> **Scope limit.** This is a source-level verification of one checkout. It is not
> a compatibility guarantee for every published npm build of DSH. The plugin
> therefore treats every host face as optional-at-mount and fails with a coded
> error instead of assuming a member exists.

## 1. Agent / session API

| Claim | Verdict | Evidence |
| --- | --- | --- |
| `ctx.agents` is an `AgentRegistry` service | confirmed | `packages/core/agent/src/index.ts:245`, Context augmentation `:26-30` |
| `create(options) → Promise<AgentHandle>` | confirmed | `index.ts:388`; `AgentHandle = { agent, dispose() }` `:160-163` |
| `sessionId` is **caller-supplied** | confirmed | `CreateAgentOptions.sessionId: SessionId` `:64`; enforced `handle.agent.id === agent.session.id` `:459-462` |
| `setup(agentCtx, agent)` runs **before** the agent is published | confirmed | `index.ts:100-118`; tools/restrictions installed in `setup` exist before the first prompt |
| `resume({ resumeSessionId, setup })` | confirmed | `index.ts:407`; requires session persistence (`agent-loop/src/index.ts:847`); re-runs `setup` (`:844-889`) |
| `meta.cwd` controls cold-session visibility | confirmed | `CreateAgentOptions.meta` `:78-85`; cold sessions without `cwd` are skipped from the client list (`api/session-controller/src/list.ts:138`) |
| Driving the agent: `followup` / `whenIdle` | confirmed | `packages/core/agent/src/runtime-types.ts:222`, `:191` |
| Normal vs subagent origin | confirmed | `origin?: 'subagent'` on `SessionHeader` (`core/session/src/types.ts:93-130`); subagent-origin sessions are **hidden** from the ordinary sidebar tree (`ui-workspace/src/client/tree.ts:145-149`) |
| `UserMessage` shape for `followup` | **not captured** | `runtime-types.ts:222` types the parameter but the P0 pass did not record its fields — see "Open items" |

**Design consequence.** The dedicated session is created as a *normal* session
(`meta.cwd` set, **no** `origin: 'subagent'`) so it appears in the native session
list, and it is driven with `followup` + `whenIdle`. `src/host/session.ts`.

## 2. Tools API

| Claim | Verdict | Evidence |
| --- | --- | --- |
| `tools.register(definition) → disposer` | confirmed | `packages/core/tools/src/index.ts:1027` |
| `register` throws unless `output` is `{ schema, render }` | confirmed | `:1029-1034` |
| `parameters` is **raw JSON Schema**, not zod | confirmed | `ToolSchema` in `packages/llm/llm/src/types.ts:411-416` |
| Author DSL `defineTool(...)` compiles to that raw schema | confirmed | `tools/src/schema.ts:545`, `:483-536` |
| `restrict({ allow, deny })` is scope-chain intersected, and the scope's own registrations are exempt | confirmed | `index.ts:1061`, `:1127-1173` |
| `guard(fn)` is a monotonic deny-only terminal check | confirmed | `index.ts:700-704`, `:1100-1118` |
| `ToolExecution` field names used by a guard | **not captured** | `ToolGuard` is typed `(execution: Readonly<ToolExecution>) => string \| undefined`; the P0 pass did not enumerate `ToolExecution`'s members |

**Design consequence.** Tools are authored as **plain `ToolDefinition` objects
with hand-written raw JSON Schema**, so the plugin does not need the
`@deepseek-ai/dsh-tools` author DSL at all (`src/host/tools.ts`). The terminal
guard fails **closed** when it cannot determine the tool name from the execution
record, precisely because `ToolExecution`'s shape was not confirmed.

## 3. Plugin packaging

| Claim | Verdict | Evidence |
| --- | --- | --- |
| `dsh.plugin.json` exists as a DSH contract | **absent** | no such file anywhere in the checkout outside `node_modules` |
| A mountable plugin is a Cordis plugin: `apply(ctx, config)` + optional `name` / `inject` | confirmed | `docs/cordis-tutorial/01-first-plugin.md`, `03-services.md` |
| `dsh.bundle.patch` in `package.json` + the referenced patch file is how a bundle mounts itself | confirmed | `packages/util/package-manifest/src/types.ts:8-82`; `apps/cli/src/plugin.ts:36-91` |

**Design consequence / deviation.** The original PLAN assumed a plugin manifest
comparable to `dsh.plugin.json` (which `DSH-better-sidebar` does ship). The
verified contract is `package.json.dsh.bundle.patch` + `cordis.patch.yml`, so
`dsh.plugin.json` was **dropped** from this package. See `PLAN.md` §"实施状态与偏差".

## 4. Native chat / navigation (client half)

| Capability | Verdict | Evidence |
| --- | --- | --- |
| Create a session from a client plugin | confirmed | `ISessions.create({ sessionId?, cwd? })` `api/session-controller/src/client/contract/sessions.ts:35-39` |
| Open / navigate to a session | confirmed | `ISessions.open(id)` `:44`; higher level `ctx.uiWorkspace.openSession(id)` (`ui-workspace/src/client/navigation.ts:21`) |
| Read / write a session's input draft | confirmed | `ctx.conversation.input.for(actx).setDraft(text)` (`ui-conversation/src/client/contract/input.ts:198-230`) |
| Focus the native composer | **absent** | no public API; focusing happens only in internal DOM code (`ui-conversation/src/client/skeleton/InputBar.tsx:186-189`) |
| Atomic draft swap/restore | **absent** | only read + `setDraft`; no atomic primitive |
| Tool-result rendering slot for our tools | confirmed | `tool.call.toolview`, keyed by tool name, owner props include the result `block` (`ui-tool/src/client/contract/slots.ts:11-59`) |
| Arbitrary transcript card (plan card) | confirmed | `ChatNodeDataMap` merge surface + `ctx.uiConversation.events.register(def)` + `conversation.chat.node` keyed renderer (`ui-chat/src/client/index.ts:54-61`, `contract/conversation.ts:185-245`) |

**Design consequences.**
- The plan preview/approval card can be rendered **without touching DSH core**:
  the keyed `tool.call.toolview` slot for `commit_agent_publish_plan` /
  `commit_agent_execute_plan` is enough for v1 (the tool result carries the plan
  id, revision and digest). A richer transcript card is available via the
  ChatNode triplet and is a P3 polish item.
- "Focus the input box" is **not** achievable through public API. The PLAN's
  requirement to "focus the native input box" is downgraded to "open the
  session and set an initial draft" — see deviation log.
- Draft preservation for the source session cannot be atomic; the entry must
  read-then-restore explicitly. Recorded as a limitation, not implemented in
  the plugin core (it belongs to the GitLens entry integration).

## 5. better-sidebar extension seams

Read-only audit of `DSH-better-sidebar` `src/`:

| Capability | Verdict | Evidence |
| --- | --- | --- |
| Register an action in the GitLens commit row | **hardcoded only** | `src/client/changes/GitLens.tsx:559-578` renders a literal `<div className={css.gitCommit}>` with no slot/hook |
| Generic slot system | exists, but no GitLens slot | `SidebarSlotsService` `src/context-types.ts:127-136`; the plugin uses host slots only |
| Source session id available to an extension | confirmed | `TabComponentProps.scope` `src/client/service.ts:143-146`; `getSnapshot().sessionId` `:611` |
| Selected repository / worktree exposed | **absent** | `GitLens.tsx:118-119` holds both in local `useState`; no service getter |
| Preview a proposed (non-ref) diff in DiffPane | **absent** | `SidebarDiffRef = {kind:'worktree'} \| {kind:'commit'}` `src/client/state.ts:23-25` |
| Per-target task status / announce | **absent** | no status store on `BetterSidebarService` (`src/client/service.ts:499-629`) |

**Design consequence.** The GitLens entry and the plan-diff preview cannot be
built today without a small, additive change to `DSH-better-sidebar`. A minimal
two-PR contract is specified in
[`BETTER-SIDEBAR-INTEGRATION.md`](./BETTER-SIDEBAR-INTEGRATION.md). The plugin
does **not** depend on better-sidebar, and it ships a command/API entry so the
flow works without GitLens.

## 6. Open items carried into implementation

These are the parts the P0 pass could not confirm from source, and how the code
behaves until they are confirmed on a live host:

1. **`UserMessage` shape** for `followup`. `src/host/session.ts` sends
   `{ text }`; confirm and adjust on first mount.
2. **`ToolExecution` shape** for the terminal guard. The guard is written
   defensively and **denies** when the name cannot be read.
3. **`ctx.provide` availability** for exposing the business API. `apply` calls it
   through an optional member so a host without it still mounts; the returned
   `plugin.api` is the supported fallback.
4. **Live DSH host version beyond this checkout.** Not verified. The plugin
   never imports host packages at runtime, so an incompatible member surfaces as
   a coded error at the call site rather than a module-load crash.
5. **Focus-the-composer** is impossible via public API; downgraded as described.
6. **Client-side plan card / GitLens button rendering** are not implemented in
   this package; the required seams are specified but not exercised.
