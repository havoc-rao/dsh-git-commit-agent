# P0 — Host API verification record

- Date: 2026-09-14
- Verified against: local read-only checkout `/Users/havoc/Documents/Projects/tools/deepseek-harness`
- Host version in that checkout: **`0.1.5-rc.2`** (root `package.json`, and
  `packages/core/agent/package.json`, `packages/core/tools/package.json`,
  `packages/core/session/package.json` all agree)
- Second reference (read-only): `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` @ `0.20.0`
- Raw audit kept verbatim as primary evidence:
  [`DSH-API-CONTRACT-REPORT.md`](./DSH-API-CONTRACT-REPORT.md)

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
| Session → Workspace grouping | confirmed | the tree resolves a group by `workspace.sessionIds.includes(sessionId)` and otherwise uses `UNGROUPED_KEY` (`ui-workspace/src/client/tree.ts:24-34`, `:201-243`) |
| Attaching a session to a Workspace | confirmed | `session.create({ workspaceId })` → `workspace.attachSession`; the `{ cwd }` branch never attaches (`api/session-controller/src/commands.ts:87-126`); membership requires the stored header cwd to realpath-equal `workspace.path` (`workspace/workspace/src/entity.ts:124-152`) |
| Host-side Workspace resolution | confirmed | `ctx.workspaceRegistry.resolveByPath(path)` (`workspace/workspace/src/index.ts:276-282`), registry service name `workspaceRegistry` (`:114`) |

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
- Session grouping is **Workspace membership, not cwd**. A `{ cwd }`-only
  session is listed under **未分组** even when the cwd is a registered Workspace.
  The client half therefore reads `ctx.workspaces.list.getSnapshot().items` and
  passes the matching `workspaceId`; the host dedicated-session path attaches
  through `ctx.workspaceRegistry`. A linked worktree that is not its own
  Workspace cannot be attached (cwd must equal the Workspace path), so it stays
  ungrouped — a DSH domain limit, not a plugin defect.

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

## 6. Open items — resolution status

Items 1–4 were **resolved by a live mount** on 2026-09-14 (see §7). Items 5–6
remain by design.

1. **`UserMessage` shape** — ✅ resolved. It must be a complete
   `{ id, role: 'user', content: ContentBlock[], source: MessageSource }`
   (`packages/llm/llm/src/message.ts:131-145`; factory `createUserMessage`
   `:204-211`). Sending `{ text }` was reproduced live as a poisoned durable log
   entry plus a first turn failing with
   `Cannot read properties of undefined (reading 'kind')`.
   `src/host/session.ts` now resolves `createUserMessage` lazily from
   `@deepseek-ai/dsh-llm` and falls back to a structurally identical message.
2. **`ToolExecution` shape** — ✅ resolved. The field is `execution.name`
   (`packages/core/tools/src/index.ts:372-377` + `:307-331`). The guard read it
   correctly live and denied a non-allowed tool with
   `commit agent scope: todo_write is not permitted`.
3. **`ctx.provide`** — ✅ resolved. `provide(name, value?)` exists
   (`vendor/cordis/src/reflect.ts:44-46, 277-299`) and the API was retrieved by a
   second plugin through `ctx.get('gitCommitAgent')`.
4. **Mount-time service access** — ✅ resolved, and it was a **boot blocker**.
   `ctx.agents` is a property proxy that throws
   `cannot get property "agents" without inject` when `agents` is not declared in
   `inject` and its provider is a sibling row
   (`vendor/cordis/src/reflect.ts:136-171`). `apply` no longer reads it: it
   resolves the registry lazily via `ctx.get('agents')`, which returns
   `undefined` instead (`:233-243`). This also removes any ordering dependency.
5. **Focus-the-composer** — remains impossible via public API; downgraded as
   described in §4 and the deviation log in `PLAN.md` §13.3.
6. **Client-side plan card / GitLens button rendering** — still not implemented
   in this package. The better-sidebar seams now exist
   (`docs/BETTER-SIDEBAR-INTEGRATION.md`), but no client entry has been written.

## 7. Live mount verification (2026-09-14)

Performed read-only against the DSH checkout by the `deepseek-harness` workspace
session, with `DSH_HOME` redirected to a scratch directory so the real
`~/.dsh` profile was untouched. No checkout file or generated artifact was
modified.

### Method

```
DSH_HOME=/tmp/<scratch> pnpm dsh plugin --profile headless add /abs/path/to/dsh-git-commit-agent
DSH_HOME=/tmp/<scratch> pnpm dsh --profile headless --patch <overlay.yml>
```

An absolute path install is supported (it becomes a `link:` and the bundle patch
is auto-reconciled), needs no network and no tarball, and the CLI accepts
`--profile`, `--patch` and `--dump-config`. `DSH_HOME` is the documented
redirect (`packages/util/home-paths/src/index.ts:18, 87`).

### Result 1: the plugin as-written could not mount

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to apply loader entry git-commit-agent (dsh-git-commit-agent): cannot get property "agents" without inject
    at new apply (.../dsh-git-commit-agent/src/index.ts:228:69)
```

Fix applied: lazy `ctx.get('agents')` (see §6 item 4).

### Result 2: everything else verified on the real host

| Check | Observed |
| --- | --- |
| mount after the inject fix | succeeds; `ctx.get('gitCommitAgent')` resolves for another plugin |
| tool registration | `tools.register` accepts our raw-JSON-Schema definitions; `output.schema` is enforced (`tools/index.ts:1782-1786`) |
| `restrict` | the dedicated agent's visible surface went from 33 global tools to exactly 8 `commit_agent_*`; querying `bash`/`todo_write` reported `visible:false` |
| `guard` | executing `todo_write` was denied with `commit agent scope: todo_write is not permitted` |
| dedicated session | created as `session-<uuid>` with `meta.cwd`; present in `sessionQuery.listSessions` both live and cold (`live:false, persisted:true, cwd`) |
| `ctx.provide` | a second plugin retrieved the API via `ctx.get('gitCommitAgent')`; `toolNames` length 8 |
| `followup({text})` | **broken as reported above**; the turn ended with `Cannot read properties of undefined (reading 'kind')` |
| real commit cycle | `commit_agent_status` → `commit_agent_publish_plan` (no blockers) → user-side `approvePlan` → `commit_agent_execute_plan` produced `outcome: completed` and commit `ab70c78` with a clean `git status` |

`apply` returning the plugin object is **not** a defect: Cordis invokes
`export function apply` via `new` and discards the return value
(`vendor/cordis/src/utils.ts:79-90`, `fiber.ts:251-260`).

### Not verified live

`resume` (source-level only), the web client's `ISessions.open` (the web profile
was not booted), user-rejected approval, cancel/reconcile, uninstall
(`ctx.effect` disposal), concurrent sessions, and Windows.

### Security observations from the live run

1. `restrict` filters only the **inherited** surface; tools registered in the
   scope's own registration set are exempt (`tools/index.ts:1127-1172`). Our
   terminal `guard` still allow-lists by name, so this is not a bypass today —
   but it is why the guard exists.
2. `ctx.provide('gitCommitAgent', api)` publishes a **process-global** service.
   Any in-process plugin can call `approvePlan`/`executePlan`. "The user
   approved" is therefore a UI/UX boundary, not an in-process authorization
   boundary; the *effective* control is that execution requires a stored
   approval whose digest matches the stored plan content.
3. The eight tools were registered as global tools, so an unrelated session
   could also see them. The bounded risk is the same as (2): execution needs an
   approval bound to a plan digest, and planning never writes to the repository.
   **Superseded:** the plugin now installs the nine tools into a single commit
   session's own agent scope (`installCommitAgentScope`, matched on the reserved
   `session-git-commit-` session-id prefix), so no other session sees them.
   `restrict({ allow: [] })` hides the inherited surface and the terminal guard
   still allow-lists the nine.

### 7.1 Post-fix re-verification (round 2)

Re-run in the same harness session against commit `08ed392`, this time with **no
shim at all** — the plugin's own `cordis.patch.yml` row, `inject: ['tools']`
only. The overlay used in the second round only disabled the headless app and
added an independent driver plugin; the second pass additionally set
`config.dataDir` (configuration, not a code shim).

| Check | Result |
| --- | --- |
| bare mount with `inject: ['tools']` only | ✅ succeeds; `boot.log` has no errors at all (previous round aborted at `cannot get property "agents" without inject`) |
| which entry actually loads | `lib/src/index.js` (the earlier `src/index.ts:228` in the stack was a source-map projection) |
| first user message shape | ✅ `inserted[0]` = `{ content: [{type:'text',text}], source: {kind:'user'}, role: 'user', id: '<uuid>' }`; driver assertions `hasId/roleUser/contentText/sourceUser` all true, `hasTextField` false |
| the old `reading 'kind'` failure | ✅ gone (`kind-error-present: false`) |
| full cycle through the agent's own tools | ✅ `commit_agent_status` → `commit_agent_publish_plan` → user-side `approvePlan` → `commit_agent_execute_plan`: `outcome: completed`, commit `f5c90db`, clean `git status` |
| uninstall / disposal | ✅ `ctx.effect` disposer removes all 8 tools (global count 33 → 25), unpublishes `gitCommitAgent`, leaves no loader entry |
| `restrict` | ✅ still exactly 8 tools; `bash`/`todo_write` report `visible: false` |
| `guard` | ✅ still denies with `commit agent scope: todo_write is not permitted` |

### 7.2 Findings from round 2

1. **Fixed: the default data directory ignored `DSH_HOME`.** With no
   `config.dataDir`, the plugin resolved `~/.dsh/git-commit-agent` and the mount
   hit `EPERM: operation not permitted, mkdir '/Users/<user>/.dsh/git-commit-agent'`
   even though `DSH_HOME` pointed at a scratch dir. `defaultDataDir()` now
   mirrors `@deepseek-ai/dsh-home-paths#resolveDshHome` (explicit path →
   `$DSH_HOME`, blank treated as unset → `~/.dsh`), explicit `dataDir`/`lockDir`
   paths expand a leading `~`, an unusable directory now fails as
   `DATA_DIR_UNAVAILABLE` with the path and a `dataDir` hint instead of a raw
   `EPERM`, and `startDedicatedSession` validates the data directory *before*
   creating a session so a bad path cannot orphan one.
2. **The fallback message path is the only reachable one.** `@deepseek-ai/dsh-llm`
   is **not resolvable from a link-installed plugin**
   (`dsh-llm-resolvable-from-plugin: false`), so the lazy import never succeeds
   and `fallbackUserMessage` is what actually runs. It was shape-validated on
   the live host, which is why the turn now advances. Hosts that can supply the
   factory may inject it via `config`/`createCommitAgentPlugin`, but YAML config
   cannot carry a function, so the fallback is the practical production path.
3. **A first turn still needs a host default model.** With no `agentOptions` and
   no default model selected, the turn ends at prompt assembly with
   `prompt variable "{{model}}" has no value for this assembly`. This is a host
   configuration prerequisite, not a plugin defect: configure `agentOptions` in
   the cordis row (or select a default model in the profile) before starting a
   dedicated session.
4. **`apply` returning the plugin object is safe but load-bearing.** Cordis
   invokes `export function apply` through `new` and discards the return value;
   this only holds while `apply` stays a function *declaration*. The source now
   carries a comment saying so.

### 7.3 Still not verified live

`resume`, a model turn completing end to end (no API key in the verification
environment), the web client's `ISessions.open`, cancel/reconcile, multi-session
concurrency, and Windows.

## 8. Client-half contract research (2026-09-14)

Read-only investigation of what a `dsh.client` (web) half would require, run by
the same harness session. No checkout file was modified.

### 8.1 The bundle format is hand-writable

A client half is a single lazy-CJS file registered as
`window.__ModuleLoader__.load({ id: '<pkg>', factory: (require) => { …; exports.apply = apply; exports.inject = inject; return module.exports } })`,
reached through the package's `./client` export
(`packages/client/modules/src/client/manifest.ts:202-204`, loader
`packages/client/modules/src/client/system.ts:207-219`). `require` resolves only
the platform seeds (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
`@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
`@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit` —
`packages/client/web/src/platform.ts:9-13`) and already-registered package ids;
relative sub-paths are **not** resolvable. A source map is optional (the host
falls back to an identity map), and HMR only hashes the bundle file. So a plain
single-file `client.js` with `React.createElement` and no bundler is viable.

### 8.2 Browser code cannot reach a host service without a Remote

`ctx.provide('gitCommitAgent', api)` lives in the Node process only. Exposing it
to the browser requires `@Remote` on a class extending `TypertRemoteService`
from `@deepseek-ai/dsh-typert-protocol` (`packages/typert/protocol/src/index.ts:152-201`);
a plain object cannot be discovered (the gateway requires a `typertRemote`
binding, `packages/api/gateway/src/index.ts:277-295`). Runtime SRC mode removes
the need for codegen but the client must `ctx.remote.$mount(contribution)`
itself, and `$mount` **requires strict codecs** (`gateway/src/client/index.ts:286-290`),
satisfiable with a passthrough `schema: { parse: v => v }`.

Two consequences worth recording:

- `@deepseek-ai/dsh-typert-protocol` would become a real dependency of this
  package (it is public, `publishConfig.access: public`), and `@deepseek-ai/cordis`
  a peer. Whether a plugin-local cordis copy interoperates with the host
  gateway's symbols is **not verified** and is the main risk of that path.
- Because of that risk, the approval path was **not** built on a Remote.

### 8.3 A host-owned approval primitive already exists (now used)

`ctx.userQuestions.ask()` supports a `plan-review` intent
(`packages/interaction/user-questions/src/types.ts:39-48`) and DSH already ships
a renderer for it (`packages/client/ui-user-questions/src/client/PlanReviewPanel.tsx`).
The intent requires the `approve` label to be one of the question's own options
and the reviewed content to be present as `detail`
(`packages/interaction/user-questions/src/index.ts:150-166`), and `ask()` accepts
only the exact live root agent (`:86-104`).

That is a strictly better approval surface than a plugin-drawn button: it is
host-owned, it renders the plan the digest covers, and it needs **no client
code at all**. The plugin now uses it via `commit_agent_request_approval`
(`src/core/review.ts` builds the document, `src/index.ts` wires the intent).

### 8.4 What remains for the GitLens button

Only the entry point is left:

1. a `dsh.client` half (`platform: 'web'`, `./client` export) rendering a
   button through `ctx.betterSidebar.registerGitCommitAction`, using the
   better-sidebar contract in `docs/BETTER-SIDEBAR-INTEGRATION.md`;
2. a Remote (or an equivalent host-owned trigger) to create the dedicated
   session, since `AgentRegistry.create` is host-side;
3. the proposed-diff preview via `openTab({ type: 'diff', diff: { kind: 'proposed', … } })`,
   which needs no Remote — the plan patch now travels in the tool result's
   `presentationMeta`.

Steps 1 and 3 carry no unknown contract. Step 2 is the part with the unverified
plugin-local-cordis risk described in §8.2 and must be verified on a live host.

### 8.5 Not verified

The web shell was not booted (that would require building `apps/web`'s `lib/`,
which the read-only constraint forbids), so the hand-written bundle, the
`$mount` handshake and the button render are **unverified**; only the contracts
above are source-verified.

### 8.6 Implemented: the GitLens button and plan diff without a Remote

The Remote risk in §8.2 was avoided entirely. `SessionInput` exposes both
`setDraft(text)` and `submit(mode?)` (`packages/client/ui-conversation/src/client/contract/input.ts:198-211`),
and `ISessions.create({ cwd })` is a public client API, so the button starts the
work in three public client calls instead of a host round-trip:

1. `ctx.sessions.create({ cwd: worktree ?? repoRoot })` — a new session in the
   target worktree;
2. `ctx.uiWorkspace.openSession(id)` (or `ctx.sessions.open(id)`);
3. `ctx.conversation.input.for(ctx.sessions.scope(id)).setDraft(prompt)` then
   `.submit()` — the planning request, with the tools' changeId discipline and
   the "never claim the user approved" rule spelled out.

This traded one designed property for reachability: the session is a normal one,
so the agent's tool surface is not restricted to the nine commit tools (the
dedicated host-created session with `restrict` + `guard` remains available
through the business API). The control that matters is unchanged — execution
still requires an approval recorded host-side against a plan digest.

**Superseded:** the trade is gone. The client now preallocates a reserved
`session-git-commit-<uuid>` id through `sessions.create({ sessionId })`, and the
host half installs the nine tools into exactly that agent's scope on
`agent/created`. A plain chat session no longer sees the commit tools at all, so
the `restrict({ allow: [] })` + `guard` surface is what the button session runs
with too.

Delivered files:

- `client/client.js` — one hand-written lazy-CJS file: `registerGitCommitAction`
  (id `dsh-git-commit-agent:plan-and-commit`, `order: 50`, `available` gated on
  `status.isRepo`, disabled while nothing is staged), plus keyed
  `tool.call.toolview` cards for `commit_agent_publish_plan` (plan summary and a
  per-commit "查看差异" button that opens a `{ kind: 'proposed' }` diff) and
  `commit_agent_request_approval`;
- `package.json` — `"./client"` export pointing straight at that file (no build
  step) and `dsh.client = { platform: 'web', inject: ['dsh-better-sidebar'] }`.

### 8.7 What the live boot confirmed, and what it did not

Confirmed by booting a copy of the real `web` profile under a scratch `DSH_HOME`:

| Check | Evidence |
| --- | --- |
| the manifest is accepted | clean boot; no "declares dsh.client but exports no ./client bundle" |
| the entry composes into the graph | `window.__DSH_BOOT__` contains `{"id":"dsh-git-commit-agent","url":"/plugins/??dsh-git-commit-agent/client.js&rev=…","inject":["dsh-better-sidebar"]}`, ordered before `dsh-better-sidebar` |
| the bundle is served | the combo URL returns HTTP 200 and 13.6 kB containing `window.__ModuleLoader__`, `registerGitCommitAction` and `commit_agent_request_approval` |
| the client logic behaves | 10 Node tests drive the real bundle with a fake module table, fake React and a fake client ctx: registration shape, gating, session creation + draft seeding + submit, sidebar-absent degradation, feature-flag gating, plan card rendering, proposed-diff opening, approval card |

**Not verified**: the browser render itself, the module table's fetch/materialize
handshake, whether `submit()` is accepted on a freshly created session before the
composer has mounted (the draft is set either way, so the user can press Enter),
and better-sidebar's actual `openTab` rendering of the proposed diff. A real
browser session is still required for those.
