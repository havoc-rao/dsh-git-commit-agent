# dsh-git-commit-agent

A dedicated **Git commit planning and execution agent** for DSH.

The agent reads real repository state, proposes a small set of logically
coherent commits, shows the user an exact per-commit preview, and — only after
the user approves one specific plan revision — runs a restricted `git` executor
that stages exactly what was approved and verifies the result.

Planning and execution have different authority. Conversation never grants git
write access.

```
GitLens entry ──▶ dedicated native session ──▶ status/diff analysis
                                                    │
                                            plan revision + digest
                                                    │
                                    user previews & approves (one revision)
                                                    │
                                    restricted executor: exact stage → verify tree → git commit
                                                    │
                                        report commits / partial failure / reconcile
```

## Status

| Phase | State |
| --- | --- |
| P0 — host API verification | **done**, evidence in [`docs/P0-VERIFICATION.md`](docs/P0-VERIFICATION.md) |
| P1 — interactive planning (no real commit) | **done**: dedicated session composition, status/diff/read tools, whole-file plans, versioning, exact preview, old-revision invalidation |
| P2 — approval + execution loop | **done**: exact approval binding, executor, real add/commit, cancel, partial failure, hooks, reconciliation |
| P3 — hunk-level splitting, chat approval protocol | not started (by design) |
| GitLens button + DiffPane plan preview | **implemented** in `client/client.js` against the delivered better-sidebar seams; the boot graph carries the entry and the bundle is served — the browser render itself is not yet verified (see [`docs/P0-VERIFICATION.md`](docs/P0-VERIFICATION.md) §8.7) |
| Live DSH host integration | **verified twice** on 2026-09-14 (headless profile, scratch `DSH_HOME`): bare mount with `inject: ['tools']` only, restricted 8-tool surface, guard denial, session visibility, uninstall disposal and a real commit — see [`docs/P0-VERIFICATION.md`](docs/P0-VERIFICATION.md) §7. The two rounds found and fixed three defects (missing lazy `agents` lookup; `followup` payload shape; default `dataDir` ignoring `DSH_HOME`) |
| Agent preset registration | **implemented**: the plugin registers itself as the `git-commit` agent preset through the host's `ctx.agentPresets.register()` (the same API the declarative `@deepseek-ai/dsh-agent-preset` plugin wraps), so it appears as a card in Settings → Agent presets; dedicated sessions bind that preset (`meta.agentPreset` + `agentPresets.mount`, the webhook session creator's pattern). Not yet verified on a live host (see [Preset registration](#agent-preset-registration)) |

122 automated tests pass against real, isolated git repositories (`npm test`).

## Plan Inspector (including no active session)

With better-sidebar's `inspectors` feature, the plugin registers two stable
Inspector types: `dsh-gca-plan` (a publication snapshot) and `dsh-gca-plans`
(the recent-plan entry). The recent list uses the authenticated read-only
`/git-commit-agent/api/plan-index` route; it supports workspace-path filtering
and pagination without returning historical patches in list responses. The
current store keeps worktree paths rather than a separate registered workspace
identity, so the filter currently matches an exact worktree path.

**明细** and **查看差异** on a transcript card navigate to the exact commit in
one Inspector, rather than expanding a second copy of its details. Overview,
commit index, dependency links, exclusions and revision delta navigate within
that page. Diff is the saved publication patch (plain text), never a recomputed
worktree diff. Truncated and unavailable historical previews remain explicit.

The source session belongs to the resource identity, not to its display seat.
Opening a resource does not activate or resume its source session. Stable kinds
allow the sidebar to restore references before any transcript mounts. Reopening
the same revision updates its location; opening another revision uses a distinct
resource id. Inspector mode does not poll full historical payloads or auto-open background
publications; explicit navigation and list refresh never steal focus. Viewing is read-only and never constitutes approval.

Older sidebar installations without `inspectors` retain the session-scoped
native Plan tab fallback below (they cannot provide the no-session Inspector).

## Full plan in the existing right sidebar (legacy fallback)

The prepare-plan transcript card now has **在侧栏查看完整计划**. The page shows
commit groups, the complete multi-line message, rationale, dependencies, file
status/layer/rename/binary markers, stats, exclusions, warnings/blockers and the
full revision/digest identity. Each group retains **查看差异**. This is a read-only
publication snapshot, not an approval surface; it remains available after an
approval decision or execution.

While a dedicated commit session is mounted in the native right sidebar, the
client polls the plugin's authenticated, read-only plan route every two seconds.
The first successful response on initial load, every session switch or remount
is a historical baseline: it registers the pages without revealing them. Only
new identities seen subsequently in that same mounted session reveal a page.
Hidden browser documents do not reveal new plans. No private session event
source, conversation pagination hooks, approval listeners or `apply_plan` calls
are involved.

Native sidebar params/meta are transient and native opens ignore a seed's id.
Each revision therefore registers a hidden, stable tab kind encoding its session,
task, plan, revision and digest; repeated opens focus that same native page.
Payloads are stored atomically in private plugin presentation files and recovered
through `/git-commit-agent/api/plan`; legacy publications are recovered from the
session's durable successful prepare-tool results through a public read handle.
Recovery never recomputes patches from today's worktree. Missing historical
payloads are reported as unavailable, not invented. The sidebar layout itself
is managed by the host: if refresh collapses it, reopen the historical card.

Run `npm run build` for host artifacts. This package's hand-written client module
is already its served artifact; a browser refresh loads it. A running host must
reload/restart its existing plugin instance to mount new host HTTP routes (a
browser refresh alone cannot replace host code). Do not start another server to
update the original GUI. Authenticated browser rendering remains a separate
manual check when this agent has no browser session/cookie.

## Prerequisites

- **A default model, or an explicit one.** The dedicated session drives a real
  agent turn. Configure `agentOptions` in the cordis row, or make sure the
  profile has a default model selected; otherwise the first turn ends at prompt
  assembly with `prompt variable "{{model}}" has no value`.
- **A writable data directory.** It defaults to `$DSH_HOME/git-commit-agent`
  (`DSH_HOME` is respected; falls back to `~/.dsh/git-commit-agent`). Point
  `config.dataDir` elsewhere if that is not writable — an unusable path fails
  loudly as `DATA_DIR_UNAVAILABLE` before any session is created.
- Session persistence, if you want `resume` to work after a restart.

## Install

```sh
dsh plugin --profile <name> add dsh-git-commit-agent
```

The bundle mounts itself through `dsh.bundle.patch` in `package.json` and
`cordis.patch.yml`. See that file for the optional `config` block
(`dataDir`, `lockDir`, `agentOptions`).

The plugin mounts with `inject: ['tools']`. The agent registry is used lazily;
calling the dedicated-session API on a host without one fails with a clear
`INTERNAL` error instead of degrading silently.

## Agent preset registration

On a host with the agent-preset registry (`agentPresets` service), the plugin
registers itself as the **`git-commit`** agent preset from `apply()`:

```ts
ctx.agentPresets.register({
  id: 'git-commit',          // COMMIT_AGENT_PRESET_ID
  name: 'Git Commit Agent',
  order: 30,
  plugins: [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }],
})
```

This is the same API the declarative `@deepseek-ai/dsh-agent-preset` plugin
row wraps (`PresetDefinition`), just invoked from the plugin's own mount so the
definition cannot drift from this plugin's code. What it buys:

- the preset appears as a card in **Settings → Agent presets**
  (`ui-agent-preset` `AgentPresetSection`): viewable (its composition YAML) and
  selectable as the default — with zero client-side changes;
- dedicated sessions **bind** that preset: the create/resume `setup` calls
  `agentPresets.mount(agentCtx, 'git-commit')` and the session header records
  `agentPreset: git-commit`, exactly like DSH's webhook session creator.

The composition supplies **only the official native filesystem tools**. Git capabilities
arrive from this plugin's host-plane installation (`agent/created` +
`session-git-commit-` prefix + `restrict`/`guard`), so the preset must not
declare `dsh-git-commit-agent` as a composition row — that would mount a second
plugin instance inside the preset scope (a second service, shared store, races)
and fail the registry's root-realm service-leak audit, marking the card broken.

Registration waits for the registry through Cordis
`ctx.inject(['agentPresets'], callback)`; patch row order does not guarantee
service readiness. The dependency child owns unregistration, including teardown
while the registration promise is pending. Minimal embedders without `inject`
retain the one-shot lookup fallback. A successful registration logs
`dsh-git-commit-agent: preset git-commit registered`.

**Current limitation:** selecting this preset for an ordinary session does not
install the Git-specific tools or the dedicated authorization scope: that
installation still requires the dedicated session-id prefix. The ordinary
session receives the preset's native filesystem tools under normal host policy. Do not treat this entry as a
complete, independently usable default agent preset. A future composition entry
must supply the tools and prompt by preset scope rather than by session id.

## Prompt language preference

Both session entry paths (the GitLens button and the host `startDedicatedSession`
API) seed a prompt in one language, chosen from a single durable preference:

- the plugin declares a **volatile settings field** `promptLanguage`
  (`zh` | `en` | `follow-ui`) on its own profile entry — the locale-preference
  template; the preset-card Configure button writes it through `configForms`
  with no custom persistence;
- `follow-ui` delegates to the active UI locale; a pinned value wins;
- the host plane (no UI locale of its own, e.g. the business API) defaults to
  `en`; the client plane falls back to its historical Chinese default only when
  neither a preference nor a UI locale is available;
- the language is resolved **at session admission** and frozen into the first
  prompt; a settings change never rewrites a running session's text, and the
  client UI strings, the approval copy and the prompt language remain three
  independent text planes.
- the prompt itself is not the whole story: both the system prompt and the
  first user message **require the agent to drive the entire workflow through
  the five tools** (never guessing state or describing a plan without
  `commit_agent_prepare_plan`) and **require every user-facing message —
  analysis, plan explanation, suggested commit messages and progress reports —
  to be presented in the prompt's language** (中文 for `zh`, English for `en`),
  so the session reads fluently in the chosen language even though the third
  planes (button labels, approval copy) keep their own translations.

Implementation: `src/config.ts` owns the shared resolver, `src/host/session.ts`
builds both languages (default `en`), `client/client.js` mirrors the same rules.
Both fields become editable through the preset-card Configure button
(`settings.agentPreset.card.action` slot).

## Default LLM model preference

Both session entry paths (the GitLens button and the host `startDedicatedSession`
API) can pin which LLM model the dedicated session runs on, chosen from the
host's **model list** (the same provider-grouped catalog the settings models
page renders):

- the plugin declares a **volatile settings field** `defaultModel`
  (`{ provider, model }`) on its own profile entry; the preset-card Configure
  dialog renders a picker populated from `remote.session.modelCatalog()` and
  writes the exact route through `configForms`;
- **no default model is a valid preference**: the picker's first option is
  "follow the host default (not specified)", which clears the field — the
  deployment `agentOptions` row or the host default model then applies;
- precedence at session admission: stored `defaultModel` (user's explicit
  choice, from the Configure dialog) → deployment `agentOptions` row → host
  default. The stored route overrides only the row's provider/model; other row
  options (`reasoningEffort`, `maxTokens`) are preserved;
- the button path applies the stored route right after session creation
  through `remote.session.selectModel` — the same durable per-session
  selection the composer model seat installs — so the first prompt's request
  header is built with it; the host API path passes it as `agentOptions`;
- a missing remote surface or a route that vanished from the catalog degrades
  silently to the host default: model pinning never blocks starting a session.

Implementation: the schema field and the admission-time resolution live in
`src/index.ts` (`COMMIT_AGENT_DEFAULT_MODEL_FIELD`, `resolveAgentOptions`),
`src/config.ts` owns the tolerant validator, and `client/client.js` owns the
catalog picker and the `selectModel` application.

## Dynamic native editing (fixed tool surface)

Commit sessions declare the Git tools plus native `read` and `edit` from their
first model request. `commit_agent_request_edit` changes host-owned authorization,
not tool schemas or system prompts, preserving the unchanged request prefix for
provider prompt caching (actual cache hits depend on the provider).

When planning reveals a necessary correction:

1. Inspect the bound worktree.
2. Call `commit_agent_request_edit` with exact repository-relative existing file
   `paths` and a `reason`; the host asks the user through its approval service.
3. Use native `read` before `edit`, even if `commit_agent_read_files` already read
   the file. Only explicitly approved files can be edited.
4. Inspect again, prepare a new plan revision, and obtain fresh commit approval.

`action=status` lists grants; `action=revoke` clears them. Grants are ephemeral,
scoped to the current agent session, and never restored after restart/disposal.
Editing authorization never approves a Git commit. An authorized edit attempt
invalidates earlier ready/draft plans and their approvals, conservatively even
if the edit fails or is cancelled. Native operations and Git execution share an
in-process worktree lease, held through asynchronous completion.

This plugin reuses the host's native tools; it does not implement an editor or
bypass filesystem policy. The deployment must provide inherited native `read`
and `edit`, a confined filesystem provider, and `fs-observation-policy`. Native
edits remain subject to those host policies. Missing tools fail installation
closed; missing scoped execution interception prevents edit authorization.
No shell, `write`, network or delegation capability is added.

Both native reads and edits reject out-of-worktree paths, Git metadata,
sensitive credential files, symlinks and non-regular/missing files. Permission
escalation arguments are rejected. Validation is repeated at dispatch; the
in-process lease does not lock external editors or other processes, and path
checks and the host's sandbox containment are not a kernel security boundary;
adversarial concurrent filesystem path swaps remain outside this threat model.

## Tools exposed to the dedicated agent

| Tool | Purpose |
| --- | --- |
| `commit_agent_inspect` | the single state tool, `mode=status` (default: HEAD, branch, index state, index rule, in-progress operations, every pending change with a content-addressed `changeId`, existing plan revisions) / `mode=recent` (subjects for style) / `mode=reconcile` (match one plan revision against real history after a crash or failed execution) |
| `commit_agent_diff` | the single diff reader: the full working-tree diff, one change's diff, or the exact per-commit diff a planned revision would introduce — filterable to one commit (`commitId`) and one file (`path`), so a large file can be read in full while the whole-plan preview stays capped |
| `commit_agent_read_files` | the single file reader: bounded contents of specific repository paths; secrets and binaries excluded with a reason |
| `commit_agent_prepare_plan` | prepare a new immutable plan revision; the host validates, computes every expected tree, returns the preview |
| `commit_agent_apply_plan` | submit one revision to the human's plan-review panel and, once approved, execute it; the host verifies approval, digest, snapshot and staged tree |
| `commit_agent_request_edit` | request user authorization for exact existing files, list current grants, or revoke them |
| Native `read` / `edit` | host-provided file observation and literal editing; edit is locked until a matching user grant exists |

There is no shell, no arbitrary git invocation, no `cwd`, no file write, no
network and no delegation tool.

## How approval works

The model can propose, preview and explain — it can never approve. Approval goes
through the host's standard approval service (`ctx.approval.request()`), so the
user answers through a host-owned protocol. The request supplies the short
question as `reason`, localized question copy as `displayReason`, and the exact
plan revision's Markdown document as `detail`. Hosts supporting approval
Markdown detail render it in the ApprovalPanel using the shared safe Markdown
renderer; older hosts show the question only, with the prepare card still
available in the transcript. The document lists per commit the frozen file paths
(status + layer), the `--numstat` counts and the base→expected trees; revisions
stored before review details existed fall back to change ids with an explicit
note. `commit_agent_apply_plan` submits one exact revision; only `allowed-once`
grants approval, and a newer revision revokes an older approval. Only after the
decision does the host execute — the same call returns the execution result.
`approvedBy` is recorded as `user:approval` — an audit label, not a cryptographic
identity: DSH has no authenticated in-process user identity, and any in-process
plugin can call the business API's `approvePlan` directly.

## Trying it

**Only from GitLens.** With pending changes, click the **commit-node icon** in
the commit row (next to the built-in Commit button; its tooltip reads
**在新会话中规划并提交这些变更**). The plugin opens a new session in the selected
worktree, seeds the planning request and submits it.

The entry is usable as soon as `git status` shows **any** change — staged,
unstaged or untracked. With an empty index the plan stages the working-tree
changes itself before committing (per PLAN §7, index-empty mode); you never
have to `git add` first.

An ordinary chat session does **not** see the commit tools, and cannot start
this workflow by asking. The five tools are installed into exactly one agent
scope, the session the button creates — never into every session.

### Per-session tool injection

DSH resolves a tool surface **per agent scope**: `register()` on a plugin's own
context is visible to every session, while `register()` on an agent's
`agent.ctx` is visible only to that agent. Mounting the five tools globally was
the original shortcut, and it put them in every session's model surface.

Instead, the host half installs them on `agent/created` for agents whose session
id carries the reserved prefix `session-git-commit-`
(`src/host/tools.ts` `COMMIT_AGENT_SESSION_PREFIX`). Since the GitLens button
cannot call `AgentRegistry.create` from the browser, it preallocates such an id
through the public `ISessions.create({ sessionId })` contract; a session created
through the business API's `startDedicatedSession` gets one from the same
`newSessionId` default. Installation adds, in the target scope only:

- the five tool definitions,
- `restrict({ allow: [] })`, which hides the entire inherited surface (the
  global layer plus every preset/standing ancestor layer) and leaves only the
  scope's own five visible,
- the terminal `guard`, which allow-lists the five by name and fails closed.

`agent/created` fires during registration — before `agent/session-start` and the
first prompt assembly — for both `create` and `resume`, so the first model
request already runs against the closed surface.

### Native Git More action slot

The Git command **More** menu contains **规划并提交** (plan and commit),
with an **agent** subtitle badge on the right. Its `MenuItemButton` children
use the public label layout: `span[data-better-sidebar-git-action-label]`
contains `span[data-better-sidebar-git-action-title]` (the existing title) and
`span[data-better-sidebar-git-action-subtitle]` (`agent`). Better-sidebar owns
the shared truncating title / trailing token-badge styling; this plugin adds
no layout CSS or runtime imports and does not misuse the `shortcut` field.
Older hosts without that shared styling still render both text spans.
The client uses `ctx.slots.inject('betterSidebar.git.actions', () =>
ctx.slots.register({ name: 'betterSidebar.git.actions',
id: 'dsh-git-commit-agent:plan-and-commit', order: 50 }, Component))`.
This is the better-sidebar **list / root** protocol, not the legacy
`registerGitCommitAction` registry; the same operation is never registered twice.

The contribution uses the shared `MenuItemButton` and the live owner props
(`GitActionSlotProps`, publicly exported by
`dsh-better-sidebar/client/service`). Its target is the slot owner's
`scope` / `worktree` / `repoRoot`, never a header session id. It is disabled
while the owner's `busy` is true or no changes exist; staged, unstaged and
untracked changes all remain supported. Selection closes More before starting
and runs session creation through `props.runAction`, which owns mutual exclusion,
error reporting and refresh after success even when the menu item unmounts.
No dialog is opened by this action; the preset configuration dialog is unrelated
and remains outside the Git menu.

The existing reserved session prefix, workspace grouping, stored default model,
prompt-language choice and automatic planning-prompt submission are unchanged.
The client stays a hand-written lazy-CJS bundle: it does not runtime-import
better-sidebar (nor add a TypeScript-only dependency just for its props type).
The platform supplies `@deepseek-ai/dsh-client-ui-primitives` at runtime.
Slot injection manages owner arrival, teardown and re-registration. On older
better-sidebar versions without this slot, the Git menu entry is unavailable;
the plugin's tools, plan views and preset configuration remain available. There
is deliberately no legacy fallback that could duplicate the new menu entry.

### Session grouping (工作区归属)

DSH's sidebar groups sessions by **Workspace membership**, not by working
directory: the tree looks up the workspace whose `sessionIds` contains the
session and otherwise drops it into the **未分组** (Ungrouped) bucket
(`ui-workspace/src/client/tree.ts`). A session only joins a workspace when it is
created *through* that workspace — the host attaches it in
`SessionCommandController.create` solely for the `{ workspaceId }` branch; a
`{ cwd }`-only session is never a member even when its cwd *is* a registered
workspace.

This plugin therefore resolves the target directory against the host's
`workspaces` list and passes `workspaceId` when it matches, so the planning
session appears under the original workspace. When the target is a linked git
worktree that is not itself a registered workspace, the cwd cannot be attached
(the host requires the session cwd to realpath-equal the workspace path), so the
session stays ungrouped by design; register that worktree as a workspace to have
it grouped. The host-side `startDedicatedSession` API does the same through
`ctx.workspaceRegistry` / `workspace.attachSession`.

Either way the flow is the same:

1. the agent calls `commit_agent_inspect` (mode=status), reads the real diffs
   (`commit_agent_diff`) and file contents (`commit_agent_read_files`), and
   prepares a plan (`commit_agent_prepare_plan`);
2. the plan appears as a transcript card: a summary (revision, commit count,
   file count, per-commit `+/-`), expandable per-commit file lists marked with
   **git/VSCode status symbols** (`M`/`A`/`D`/`R`/`C`/`T`/`U`/`?` + staged/
   unstaged layer), exclusions and warnings, a **revision delta** ("what
   changed since rev N": files moved between commits, reworded messages, new
   exclusions), and a collapsed technical section (plan id, digest, trees).
   Each commit opens as a **versioned** proposed diff in the sidebar's
   DiffPane (the tab id carries the revision, so two revisions never share one
   tab; the seed carries `truncated` and a `sourceRef` snapshot label the
   sidebar shows as display-only metadata; file rows jump to the live file in
   the sidebar editor, **diff rows open it at the line** — the patch itself
   stays a read-only snapshot; stats and file lists always come from the
   untruncated `--numstat`);
3. the agent calls `commit_agent_apply_plan` and you decide in the host's
   ApprovalPanel — its Markdown document lists each file with a **porcelain-XY
   status symbol** (first slot staged, second unstaged; `??` untracked), the
   stat and the trees, all from the plan's frozen review detail, never live
   worktree reads;
4. only after your approval does the host execute — the same call then returns
   the execution result (commits landed, or why it stopped).

The client half is one hand-written lazy-CJS file (`client/client.js`): no
bundler, no JSX, no CSS modules, and no typert Remote — the button uses only
public client APIs, so it adds no dependency on the host's internal symbol
tables.

## Business API

```ts
import { apply as mount } from 'dsh-git-commit-agent'

const plugin = mount(ctx, { dataDir: '~/.dsh/git-commit-agent' })
plugin.api.toolNames            // the five tool names
plugin.api.systemPrompt()
await plugin.api.startDedicatedSession({ workspacePath, sourceSessionId, userConstraints })
await plugin.api.openTask({ sourceSessionId, agentSessionId: null, workspaceRoot })
await plugin.api.approvePlan({ taskId, planId, revision, planDigest, requestId, approvedBy })
await plugin.api.executePlan({ taskId, planId, revision })
plugin.api.cancel(taskId)
await plugin.api.reconcile(taskId, planId, revision)
```

`approvePlan` must only be called from a user-initiated surface (the plan card),
never from the model. The model's tools cannot reach it.

## Architecture

```
client/client.js              hand-written lazy-CJS browser half (button + plan cards)
src/core/                     host-agnostic, fully testable
  errors.ts                   coded error taxonomy
  types.ts                    task / snapshot / plan / execution domain model
  git/runner.ts               restricted git runner: fixed args, scrubbed env, literal pathspecs
  git/snapshot.ts             status parsing, per-change content digests, consistency re-reads
  plan/validate.ts            coverage, duplicates, cycles, v1 refusals
  plan/digest.ts              canonical approval digest
  plan/materialize.ts         temporary-index materialisation → exact expected trees
  plan/lock.ts                in-process + on-disk worktree lock
  plan/executor.ts            approved execution, tree verification, reconciliation
  store/store.ts              atomic, append-only task/plan/execution store
  service.ts                  orchestration used by the tools
src/host/                     structural mirrors of the verified DSH contract
  types.ts                    host service faces (no compile-time host dependency)
  tools.ts                    the five ToolDefinition objects + per-session scope install
  session.ts                  dedicated normal session, prompts
src/index.ts                  Cordis plugin: apply(ctx, config) + business API
```

Nothing under `src/core/` imports a host package, which is why the whole engine
is testable with plain Node.

## Preview is exact, not approximate

For every planned commit the host computes the tree it must produce, starting
from HEAD (or from the user's own index when staged content is being reused) in a
**temporary** index. The preview diff is the real diff between the parent tree
and that expected tree. Execution re-computes the same trees immediately before
committing and refuses to proceed if they differ. This is why a plan can never
claim one thing and commit another.

## Safety highlights

- approval is bound to `(revision, content digest)`; publishing a new revision
  revokes every earlier approval;
- the real index tree is compared to the approved tree **before** `git commit`;
- HEAD is re-read after every attempt, including failures and cancellations, so
  a commit that landed is recorded, never retried;
- `--no-verify`, `--amend`, `reset`, `push` and history rewriting are never used;
- existing staged content is respected and never split;
- hooks, identity and signing behave exactly as the user configured them;
- secret-looking files are not sent to the model;
- all plugin state is written outside the target repository.

Full model: [`docs/SECURITY.md`](docs/SECURITY.md).

## Development

```sh
npm install
npm run verify     # typecheck + build + 89 tests against real isolated git repos
npm run build
```

Tests never touch a user repository: every fixture is a fresh temp repo with
pinned identity, signing disabled and its own hooks path.

### Component → source locator (dev-only)

`@havocrao/dsh-code-finder` is wired in as a dev dependency so that holding
**Opt+Shift** and hovering a `CommitAction` / `PlanCard` / `ApprovalCard`
element in the DSH web UI shows `client/client.js:line:col`.

```sh
npm run inject:dev      # NODE_ENV=development dcf instrument client --write
npm run inject:revert   # restore the tracked file when you are done
```

This project has no bundler config, so — unlike the tsdown/vite plugins — the
elements are located by the **standalone instrument** entry applied to the
hand-written client bundle. The overlay and the `/code-finder/api/*` routes come
from the host: `cordis.patch.yml` here is a plugin-type patch (insert-only), so
`dcf init` intentionally adds no mount row (the host layer owns it).

Two things to keep in mind:

- **`client/client.js` is tracked source, not a build artifact.** Injection
  reprints it (`+1063/−219` lines) and `prepack` only runs `tsc`, so it will
  *not* be restored for you — run `npm run inject:revert` before committing or
  `npm pack`. Injection is idempotent and reverting is byte-exact.
- **Name-level search needs a root.** Precise coordinates come from the
  injection; the declaration-name fallback additionally requires this repo's
  `client/` directory in the profile roots: `dcf roots add web "$PWD/client"`
  (idempotent). Roots are read at boot, so restart the host after changing them
  (`dsh web stop && dsh web`).

See `docs/README.md` in the [DSH-code-finder](../DSH-code-finder) repo
("零构建插件" and "C. cordis 纯 runtime") for the full contract.

## Not in this version

No push, no history rewriting, no automatic rollback of completed commits, no
`--no-verify`, no automatic code fixes, no hunk-level splitting, no second chat
UI, and no modification of the official DSH checkout or its generated artifacts.
