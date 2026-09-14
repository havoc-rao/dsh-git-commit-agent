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
| GitLens button + DiffPane plan preview | better-sidebar seams **delivered** (`registerGitCommitAction`, `getGitCommitTarget`, `{kind:'proposed'}`) on `feat/git-commit-action-seam` @ `edf6837`; **this plugin's client UI is not implemented yet** — names and evidence in [`docs/BETTER-SIDEBAR-INTEGRATION.md`](docs/BETTER-SIDEBAR-INTEGRATION.md) |
| Live DSH host integration | **verified twice** on 2026-09-14 (headless profile, scratch `DSH_HOME`): bare mount with `inject: ['tools']` only, restricted 8-tool surface, guard denial, session visibility, uninstall disposal and a real commit — see [`docs/P0-VERIFICATION.md`](docs/P0-VERIFICATION.md) §7. The two rounds found and fixed three defects (missing lazy `agents` lookup; `followup` payload shape; default `dataDir` ignoring `DSH_HOME`) |

65 automated tests pass against real, isolated git repositories (`npm test`).

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
| `commit_agent_status` | HEAD, branch, index state, in-progress operations, every pending change with a content-addressed `changeId`, existing plan revisions |
| `commit_agent_diff` | exact diff for a plan commit, or the current reviewable diff; optionally narrowed to one change |
| `commit_agent_read_context` | bounded file reads (secrets excluded with a reason, binaries skipped) |
| `commit_agent_recent_commits` | recent subjects for message style |
| `commit_agent_publish_plan` | publish a new immutable plan revision; the host validates, computes every expected tree, returns the preview |
| `commit_agent_execute_plan` | execute a revision the **user** approved; the host verifies approval, snapshot and staged tree |
| `commit_agent_cancel_execution` | request cancellation at the next safe boundary |
| `commit_agent_reconcile` | match real history against a plan's expected trees without changing anything |

There is no shell, no arbitrary git invocation, no `cwd`, no file write, no
network and no delegation tool.

## Business API

```ts
import { apply as mount } from 'dsh-git-commit-agent'

const plugin = mount(ctx, { dataDir: '~/.dsh/git-commit-agent' })
plugin.api.toolNames            // the eight tool names
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
  tools.ts                    the eight ToolDefinition objects + scope restriction
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
npm run verify     # typecheck + build + 49 tests against real isolated git repos
npm run build
```

Tests never touch a user repository: every fixture is a fresh temp repo with
pinned identity, signing disabled and its own hooks path.

## Not in this version

No push, no history rewriting, no automatic rollback of completed commits, no
`--no-verify`, no automatic code fixes, no hunk-level splitting, no second chat
UI, and no modification of the official DSH checkout or its generated artifacts.
