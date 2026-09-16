# Security model and acceptance mapping

The planning phase and the execution phase have **different authority**. Free
conversation never grants git write access; only a host-verified approval of one
exact plan revision does.

## 1. No general-purpose privilege

- The plugin exposes **five closed tools** (`src/host/tools.ts`: one read tool
  `commit_agent_inspect` with status/diff/files/recent/reconcile modes, plus
  publish, approval, execute and cancel). There is no shell tool, no arbitrary
  git invocation, no `cwd`, no file write, no network and no delegation.
- Every git argument array is constructed by `GitRunner` (`src/core/git/runner.ts`).
  No caller can supply a subcommand or an option.
- Processes are spawned with `execFile` (never a shell).
- The ambient git environment is scrubbed (`GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
  `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`,
  `GIT_ASKPASS`, …) and replaced with a fixed set: `GIT_PAGER=cat`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_LITERAL_PATHSPECS=1`,
  `LC_ALL=C`. Configuration locations are deliberately **preserved** so the
  user's identity, hooks and signing behave exactly as in their own terminal.
- Analysis never executes repository-supplied programs: hashing uses
  `git hash-object --no-filters`; diffs use `--no-ext-diff --no-textconv`.
- The five tools are installed into a commit session's own agent scope
  (`installCommitAgentScope`): the scope's own registrations are the only visible
  tools, `restrict({ allow: [] })` hides the whole inherited surface (global plus
  every preset/standing ancestor layer), and a terminal `guard` allow-lists the
  five by name and **fails closed** if it cannot read the tool name from the
  execution record.
- Repository text and diffs are data. The system prompt says so explicitly.

## 2. Approval is bound to content, not to a button

- A plan version is content-addressed: `planDigest = sha256(canonicalJson(...))`
  over target, snapshot id, index strategy, every commit (message, rationale,
  dependencies, change ids, **expected tree**) and every exclusion.
- `approvePlan` re-derives the digest from stored content and requires the caller
  to present the same digest. A mismatched digest is `APPROVAL_MISMATCH`.
- Publishing a new revision revokes the approval of every earlier revision
  (`revokeOtherRevisions`) and marks them `stale`.
- Execution re-checks `approval.revision === plan.revision`,
  `approval.planDigest === plan.planDigest === recompute(plan)`, and that the
  plan has no blockers. The model cannot forge any of these; it never writes
  approval state.
- Approving a different revision fails: `APPROVAL_REVOKED`.

## 3. Exact staging and tree verification

Sequence per execution (`src/core/plan/executor.ts`):

1. Verify approval and digest.
2. Acquire the per-worktree lock (in-process **and** an on-disk lock in the
   plugin's own data dir — never inside the target repository).
3. Re-capture the snapshot and require `snapshotId` equality with the plan.
   Content digests are part of the snapshot, so editing a file without changing
   its porcelain status still invalidates the plan (`PLAN_STALE`).
4. Re-materialise the plan in a **temporary index** and require every
   `expectedTree` to equal the approved one; otherwise `TREE_MISMATCH` with
   nothing committed.
5. Stage one commit group with literal, single-path
   `git update-index --add -- <path>` / `--force-remove -- <path>`
   (`GIT_LITERAL_PATHSPECS=1`).
6. Compute the **real** index tree and compare it to the approved tree before
   running `git commit`. Mismatch aborts with the index left as staged.
7. Run `git commit -m <message>` — never `--no-verify`, never `--amend`, never a
   signing override, never `commit-tree`.
8. Re-read HEAD, verify parent and tree; record the actual commit.

## 4. Existing staged content is respected

- `indexStrategy` is derived from the snapshot, not chosen by the model:
  `index-empty-whole-file` when the index equals HEAD, otherwise
  `reuse-existing-index`.
- Under `reuse-existing-index` the first commit starts from the real index tree,
  so the user's staged work lands in that commit. The validator **blocks**
  (`UNSTAGED_INDEX_SPLIT_UNSUPPORTED`) any plan that omits an already-staged
  change, because omitting it cannot be honoured without splitting the index.
  This is the single code for the rule: a staged change placed in a later commit
  is the same violation and is never re-reported under another code. The status
  projection surfaces the rule up front (`indexRule`), so a plan does not have
  to fail at publish time to learn it.
- The plugin never runs `git reset`, and never re-collects changes with `git add -A`.

## 5. What v1 refuses (with a coded reason)

`UNSUPPORTED_REPOSITORY_STATE` (merge / rebase / cherry-pick / revert / bisect),
`UNSUPPORTED_UNMERGED`, `UNSUPPORTED_SUBMODULE`, `UNSUPPORTED_TYPECHANGE`,
`UNSUPPORTED_HUNK_SPLIT` (one path in two commits — distinct from the staged-index rule), `EMPTY_TREE_COMMIT`,
`UNCOVERED_CHANGE`, `MISSING_EXCLUSION_REASON`, `INDEX_STRATEGY_MISMATCH`,
`DEPENDENCY_CYCLE` / `DEPENDENCY_ORDER`, `UNKNOWN_CHANGE` / `DUPLICATE_CHANGE`,
`BUDGET_EXCEEDED`.

A plan with any blocker cannot be approved, and `executePlan` refuses a plan
with blockers regardless of approval state.

## 6. Failure, cancellation and crash

- A failed or cancelled `git commit` is **never retried**. The executor re-reads
  HEAD after every attempt, including throws and aborts, and records the commit
  if it actually landed (`COMMIT_UNEXPECTED` / `COMMIT_REPORTED_ERROR`).
- Partial success is reported as such: landed commits are listed, remaining
  changes are re-read, and the plan status becomes `partially-failed`. A failed
  plan cannot be re-executed without a new revision and a new approval.
- Cancellation takes effect at step boundaries. A commit already handed to the
  OS may still land; the result reports the reconciled HEAD rather than claiming
  nothing happened.
- `reconcilePlan` matches live history against the plan's expected trees without
  changing anything, for use after a crash or restart.
- Hooks run exactly as configured. A hook that rewrites the index or files is
  detected by the post-commit parent/tree verification; the plugin reports the
  discrepancy and stops, and does not claim it could have prevented the commit.

## 7. Data handling

- Tasks, plan revisions, approvals and execution records live in the plugin's own
  data directory (`~/.dsh/git-commit-agent` by default). **Nothing is written
  inside the target repository** — planning cannot dirty the worktree.
- Reads are bounded: a per-file byte cap, a file-count cap, a 64 MiB blob budget
  and a 5000-change snapshot budget.
- Secret-looking files (`.env`, `id_rsa*`, `*.pem`, `.git-credentials`,
  `.npmrc`, `credentials`, `secrets`) are **not** sent to the model; the tool
  result states the exclusion reason.

## 8. Acceptance-test mapping

Run `npm test` (49 tests). Evidence per PLAN §11 acceptance item:

| Acceptance item | Test |
| --- | --- |
| all-unstaged / already-staged / MM / rename / delete / untracked / special chars / modes / binary | `tests/snapshot.test.ts`, `tests/plan.test.ts`, `tests/execute.test.ts` |
| no first commit (unborn HEAD) | `tests/snapshot.test.ts` ("an unborn repository") |
| source cwd differs from target worktree | `tests/helpers/fixture.ts` + every `execute` test (task bound by `openTask`, not by cwd) |
| repo changes while status letters stay the same | `tests/snapshot.test.ts` ("content edit keeps status M…"), `tests/execute.test.ts` ("a repository change after approval") |
| plan update invalidates the old approval | `tests/execute.test.ts` ("publishing a new revision revokes…") |
| double click / duplicate request does not double-commit | `tests/execute.test.ts` ("concurrent executions… refused"), store-level append-only revisions |
| repository text cannot obtain bash / write / delegation | `tests/tools.test.ts` ("no tool exposes a general-purpose escape hatch"), `tests/runner.test.ts` ("never invokes a shell") |
| agent cannot forge approval | `tests/execute.test.ts` ("approval whose digest does not match", "without approval") |
| preview tree == approved tree | every `execute` test asserts `rev-parse HEAD^{tree}` equals the approved `expectedTree` |
| pre-execution index tree check | `TREE_MISMATCH` path in `executor.ts`, plus the staged-tree assertion in the happy path |
| post-commit parent/tree check | `executor.ts` step 8; asserted by the parent-chain test |
| hook rejects / modifies files | `tests/execute.test.ts` ("a rejecting hook stops the commit…") |
| partial success and no blind retry | `tests/execute.test.ts` ("partial failure keeps the landed commit…") |
| crash / external commit reconciliation | `tests/execute.test.ts` ("reconciliation detects commits that landed outside the plugin") |
| merge/rebase in progress | `tests/execute.test.ts` ("refused while a merge is in progress"), `tests/plan.test.ts` |
| native input supplement + return to source session | **NOT covered by automated tests** — requires a live host (see P0 open items) |
| plugin uninstall leaves no entry behind | tool disposers covered in `tests/tools.test.ts`; the GitLens entry does not exist yet (better-sidebar PR) |
| theme tokens / a11y / i18n | not applicable yet: this package ships no UI of its own |

## 9. Explicitly not claimed

- Native-session integration was **live-verified once** on 2026-09-14 (mount,
  restricted tool surface, guard denial, session visibility, one real commit —
  see `docs/P0-VERIFICATION.md` §7). `resume`, the web client, cancel/reconcile
  and uninstall were **not** exercised live and are not described as verified.
- A commit's hooks run with the user's privileges and can do anything the user
  configured. The plugin verifies the result and stops; it does not sandbox hooks.
- `commit-tree` review: git objects are written during preview materialisation.
  The worktree, the real index and the refs are not modified during planning.

## 10. Trust boundaries the live run made explicit

These are properties of the Cordis/DSH trust model, not plugin defects, but they
bound what "the user approved" means:

1. **The business API is a process-global service.** `apply` publishes it with
   `ctx.provide('gitCommitAgent', api)`, so any other in-process plugin can call
   `approvePlan`, `withdrawApproval`, `executePlan` or `cancel`. The user-facing
   approval is therefore a **UI boundary, not an in-process authorization
   boundary**. The effective control is content binding: execution re-derives
   `planDigest` from stored content and refuses unless
   `approval.planDigest === plan.planDigest === recompute(plan)` and the plan has
   no blockers. A caller can approve, but it cannot make the executor commit
   something different from what the approval covers.
2. **The five tools are scoped to commit sessions, not global.** `apply` never
   registers them on its own context; it installs them on `agent/created` for
   agents whose session id carries the reserved `session-git-commit-` prefix
   (the GitLens button preallocates one through `ISessions.create`). An unrelated
   session does not see them at all. The prefix is a naming contract, not an
   authorization boundary — a session that forged it would gain planning tools,
   but planning never writes to the repository and execution still requires an
   approval bound to a plan digest.
3. **`restrict` exempts the scope's own registrations.** Verified in the DSH
   source and observed live. Because the five are now the scope's own
   registrations, the restriction is `allow: []` (hide everything inherited) and
   the terminal guard is what keeps the surface closed. The guard is not
   optional.
4. **Uninstall must dispose.** `apply` wires `ctx.effect(() => () => { disposeTools(); plugin.dispose() })`
   so the five tools and any created session are released. Live uninstall was
   not exercised.
5. **`approvedBy` is an audit label, not an identity.** Interactive approval goes
   through the host's `plan-review` question intent and the record is stamped
   `user:plan-review`. DSH models no authenticated in-process user identity, so
   this records *how* the approval was obtained, not *who* granted it. Anything
   that can reach the business API in process can approve without a human; the
   control that still holds is content binding — the executor re-derives the
   digest and refuses anything the approval does not cover.
6. **A session's cwd is trusted input.** With no dedicated session bound yet, the
   tools fall back to the calling session's authoritative `cwd` from the host
   session store. The worktree is therefore chosen by the host's session record,
   never by the model, which cannot pass a path.
7. **The plan-review document is the approved content.** `buildPlanReview` renders
   the worktree, branch, HEAD, index strategy, every commit message, the change
   ids, the exclusions and the digest prefix; the digest itself is computed over
   the structured plan, not over the markdown. A reviewer who reads the panel and
   approves has seen the change set the digest covers.
