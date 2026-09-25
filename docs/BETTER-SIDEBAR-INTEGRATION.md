# better-sidebar integration contract (available)

Status: **delivered and implemented** by the `DSH-better-sidebar` workspace on
branch `feat/git-commit-action-seam` @ `edf6837` (local branch, not pushed).
This replaces the earlier *contract request*: the seams below now exist and can
be consumed directly.

Our original read-only audit was confirmed, with two corrections: the diff page
render point is `DiffTab.tsx` (not `DiffPane.tsx`, which is the inline changes
preview), and `repoRoot` is written back from `status.root` while
`selectedWorktree` is set by the worktree selector / auto-selection.

`dsh-git-commit-agent` still does **not** depend on `dsh-better-sidebar`. The
plugin mounts and works without it (command/API entry); these seams only add the
GitLens button and the plan-diff preview.

## 1. Confirmed public names (line numbers are post-change)

| Name | Signature / value | Evidence |
| --- | --- | --- |
| register action | `registerGitCommitAction(descriptor: GitCommitActionDescriptor): () => void` — returns a disposer; duplicate `id` throws | decl `src/client/service.ts:565`, impl `:898` |
| descriptor | `GitCommitActionDescriptor { id; order?; available?; component }` | `src/client/service.ts:542` |
| props | `GitCommitActionProps extends GitCommitTarget { service; refresh() }` | `src/client/service.ts:526` |
| target | `GitCommitTarget { scope; repoRoot?; worktree?; branch?; status; staged }` | `src/client/service.ts:507` |
| list actions | `getGitCommitActions(): readonly GitCommitActionDescriptor[]` | decl `:567`, impl `:912` |
| read target | `getGitCommitTarget(scope?: SessionScope): GitCommitTarget \| undefined` | decl `:579`, impl `:926` |
| publish target | `setGitCommitTarget(ownerId: string, target: GitCommitTarget \| null): void` (`@internal`, called by GitLens only) | decl `:708`, impl `:917` |
| feature flags | `'gitCommitActions'`, `'planDiff'` | `SIDEBAR_FEATURES`, `src/client/service.ts:802-803` |
| render position | inside the Git commit row `css.gitCommit`, **after** the built-in Commit button; wrapped in `role="group"` + `aria-label={t('gitCommitActions')}` | `src/client/changes/GitLens.tsx:660-671` (action list `:500-521`, target `:459-478`, publish `:480`/`:487`, subscribe `:492-496`) |
| row styles | `.gitCommitActions`, `.gitCommitActionBoundary` | `src/client/changes/changes.module.css:224`, `:232` |
| proposed diff | `{ kind: 'proposed'; id; title; patch; worktree?; repoRoot? }` | `src/client/state.ts:39-49` |
| narrowed alias | `GitDiffRef = Extract<SidebarDiffRef, { kind: 'worktree' \| 'commit' }>` | `src/client/state.ts:56` (re-exported `service.ts:46`) |
| diff rendering | proposed branch (zero git calls) + title | `src/client/DiffTab.tsx:59-63`, `:29`, `:120` |
| integration guide | new §7.2 | `docs/external-plugin-guide.md` |

Semantics: `order` ascending (default 100) then registration order;
`available(target) === false` skips the action; a throwing `available` is logged
and skipped; each action is wrapped in its own `RenderBoundary`, so one broken
component cannot break the commit row. Register/unregister notify through the
existing `subscribe()`, so an action registered after mount appears immediately.
With zero registrations the commit row DOM is unchanged.

## 2. Reading session / repo / worktree / staged

### A. Preferred — the action component's props (always live)

```ts
ctx.betterSidebar.registerGitCommitAction({
  id: 'dsh-git-commit-agent:commit',
  order: 50,
  available: (t) => t.status.isRepo,
  component: ({ scope, repoRoot, worktree, branch, status, staged, service, refresh }) => {
    const sourceSessionId = scope.sessionId   // source coding session
    const workspaceRoot = worktree ?? repoRoot // what openTask({ workspaceRoot }) needs
    const canCommit = staged.length > 0        // same gate as the built-in Commit button
    return /* our own button — title/icon live here, not in the descriptor */
  },
})
```

- `staged` = `status.entries.filter(isStagedEntry)` (index column non-empty and
  not `?`). Untracked `??` is **not** staged, matching the built-in button.
- `worktree` = GitLens' `selectedWorktree`; `repoRoot` = `status.root`.
- `refresh()` re-runs GitLens' status/branch/log refresh after our action writes
  to git.

### B. Elsewhere (own tab / command) — a point-in-time read

```ts
const target = ctx.betterSidebar.getGitCommitTarget({ sessionId })
```

⚠️ **Non-reactive by design**: publishing a target does **not** fire
`subscribe()` (GitLens publishes on render, so notifying would create a
publish → notify → re-render → publish loop). A consumer that must follow the
user switching worktrees should re-read on its own `subscribeState`/poll, or
simply render inside the commit row and take the props.

## 3. Opening a proposed (plan) diff

```ts
ctx.betterSidebar.openTab({
  type: 'diff',
  id: `plan:${planId}:${i}`,
  title: `计划第 ${i + 1} 个提交`,
  diff: { kind: 'proposed', id: `plan:${planId}:${i}`, title: '…', patch: unifiedPatch },
})
```

- `patch` goes through the existing `parseUnifiedDiff` / `DiffFiles` stack —
  same colouring, inline highlighting and stats as `worktree` / `commit` — and
  triggers **no git call**.
- Context folding passes `undefined` for `resolveFold` (no revision to read);
  `DiffFiles` has a pre-existing degraded display for that.
- `worktree` / `repoRoot` are display metadata only.
- In the native right sidebar the host mints the tab id; the seed `id` only
  affects the synthetic tab passed to `onOpen`. In the bottom workbench the seed
  `id` dedupes as before. `type === 'diff'` tabs are dropped by
  `sanitizeState`, so no new persistence work was needed.

## 4. Deviations we must absorb on our side

1. **No `title` / `icon` on the descriptor.** The host renders our `component`
   and nothing else; those fields would have been dead API. Our component owns
   its own label and icon.
2. **No `setGitCommitStatus`.** Status display stays inside our component; the
   host does not store consumer business state.
3. **Business state, persistence, dedicated-session creation and approval
   binding stay with us.** better-sidebar explicitly declined to duplicate them —
   which matches our own boundary in `PLAN.md` §3.
4. **"Return to source session" needs no better-sidebar change**: our component
   calls the host's `ctx.sessions.open?.(sessionId)`.
5. **The per-target status/announce seam from our draft is not delivered**; we
   render live status inline in our own action component instead.

## 5. Verification performed by the better-sidebar workspace

| Command | Result |
| --- | --- |
| `pnpm typecheck` | green |
| `pnpm exec eslint <changed files>` | 0 errors / 0 warnings |
| `pnpm lint` (whole repo) | 1 **pre-existing** unrelated error (`docs/prototypes/gitgraph-lines/src/layout.ts:16`) |
| `pnpm build` | complete (incl. client chunk) |
| `pnpm check:consumer-types` | `OK: the client/service declaration surface is node-free and self-contained` |
| focused regression (12 spec files incl. the two new ones) | 214/214 |
| `pnpm test` (full) | 1410 passed / 9 skipped / 33 failed — all in `agent-pty`/`smoke` with `posix_spawnp failed`; reproduced identically on the pre-change baseline, so environment-only |

New tests: `tests/git-commit-actions.spec.tsx` (6),
`tests/diff-tab-proposed.spec.tsx` (2), `tests/service.spec.ts` (+6), plus a
compile-time gate in `tests/consumer-types.ts`.

## 6. Remaining work on our side (not done yet)

The seams exist, but this plugin still ships **no client half**: there is no UI
component calling `registerGitCommitAction`, and no code calling `openTab` with
a `proposed` diff. Implementing that requires a bundled client entry
(`dsh.client` platform web) in this package. Until then the flow is driven
through the plugin's own business API (`startDedicatedSession`), and the plan
preview is rendered from the `commit_agent_prepare_plan` tool result.
