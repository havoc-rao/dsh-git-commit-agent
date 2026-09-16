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

89 automated tests pass against real, isolated git repositories (`npm test`).

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

## Tools exposed to the dedicated agent

| Tool | Purpose |
| --- | --- |
| `commit_agent_inspect` | the single read tool, `mode=status` (default: HEAD, branch, index state, index rule, in-progress operations, every pending change with a content-addressed `changeId`, existing plan revisions) / `mode=diff` (current or per-plan diff, optionally one change) / `mode=files` (bounded reads, secrets excluded with a reason) / `mode=recent` (subjects for style) / `mode=reconcile` (match real history against a plan) |
| `commit_agent_publish_plan` | publish a new immutable plan revision; the host validates, computes every expected tree, returns the preview |
| `commit_agent_request_approval` | ask the human to approve exactly one revision, through the host's own plan-review panel; the host records the decision |
| `commit_agent_execute_plan` | execute a revision the **user** approved; the host verifies approval, snapshot and staged tree |
| `commit_agent_cancel_execution` | request cancellation at the next safe boundary |

There is no shell, no arbitrary git invocation, no `cwd`, no file write, no
network and no delegation tool.

## How approval works

The model can propose, preview and explain — it can never approve. Approval goes
through the host's own question surface using the `plan-review` intent
(`ctx.userQuestions.ask({ ... intent: { kind: 'plan-review', approve: 'Approve' } })`),
so the user sees the plan document the content digest covers and answers through
a host-owned protocol. `commit_agent_request_approval` submits one exact
revision; a decline is a normal outcome, and a newer revision revokes an older
approval. `approvedBy` is recorded as `user:plan-review` — an audit label, not a
cryptographic identity: DSH has no authenticated in-process user identity, and
any in-process plugin can call the business API's `approvePlan` directly.

## Trying it

**Only from GitLens.** With pending changes, click the **commit-node icon** in
the commit row (next to the built-in Commit button; its tooltip reads
**在新会话中规划并提交这些变更**). The plugin opens a new session in the selected
worktree, seeds the planning request and submits it.

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

1. the agent calls `commit_agent_inspect` (mode=status), reads the real diffs, and publishes a plan;
2. the plan appears as a transcript card, and each commit can be opened as a
   proposed diff in the sidebar's DiffPane;
3. the agent calls `commit_agent_request_approval` and you decide in the host's
   plan-review panel;
4. only after your approval does the agent call `commit_agent_execute_plan`.

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
