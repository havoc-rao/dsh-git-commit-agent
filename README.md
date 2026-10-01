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
  plugins: [],               // deliberate — see below
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

The composition is **empty by design**: the commit agent's capability set
arrives from this plugin's host-plane installation (`agent/created` +
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

**Current limitation:** the roster entry has an empty composition. Selecting it
for an ordinary session does not install the commit tools: tool installation
still requires the dedicated session-id prefix. Do not treat this entry as a
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

## Tools exposed to the dedicated agent

| Tool | Purpose |
| --- | --- |
| `commit_agent_inspect` | the single state tool, `mode=status` (default: HEAD, branch, index state, index rule, in-progress operations, every pending change with a content-addressed `changeId`, existing plan revisions) / `mode=recent` (subjects for style) / `mode=reconcile` (match one plan revision against real history after a crash or failed execution) |
| `commit_agent_diff` | the single diff reader: the full working-tree diff, one change's diff, or the exact per-commit diff a planned revision would introduce — filterable to one commit (`commitId`) and one file (`path`), so a large file can be read in full while the whole-plan preview stays capped |
| `commit_agent_read_files` | the single file reader: bounded contents of specific repository paths; secrets and binaries excluded with a reason |
| `commit_agent_prepare_plan` | prepare a new immutable plan revision; the host validates, computes every expected tree, returns the preview |
| `commit_agent_apply_plan` | submit one revision to the human's plan-review panel and, once approved, execute it; the host verifies approval, digest, snapshot and staged tree |

There is no shell, no arbitrary git invocation, no `cwd`, no file write, no
network and no delegation tool.

## How approval works

The model can propose, preview and explain — it can never approve. Approval goes
through the host's own question surface using the `plan-review` intent
(`ctx.userQuestions.ask({ ... intent: { kind: 'plan-review', approve: 'Approve' } })`),
so the user sees the plan document the content digest covers and answers through
a host-owned protocol. The document lists per commit the frozen file paths
(status + layer), the `--numstat` counts and the base→expected trees; revisions
stored before review details existed fall back to change ids with an explicit
note. `commit_agent_apply_plan` submits one exact
revision; a decline is a normal outcome (the user's free-text feedback reaches
the model), and a newer revision revokes an older approval. Only after the
decision does the host execute — the same call returns the execution result.
`approvedBy` is recorded as `user:plan-review` — an audit label, not a
cryptographic identity: DSH has no authenticated in-process user identity, and
any in-process plugin can call the business API's `approvePlan` directly.

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
   plan-review panel — its document lists each file with a **porcelain-XY
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
