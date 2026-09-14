# better-sidebar integration: required contract (minimal independent PRs)

`dsh-git-commit-agent` deliberately does **not** depend on `DSH-better-sidebar`,
and it does not reach into that package's private components or its `/sidebar/api`
routes. The GitLens button and the plan-diff preview are the only two things that
cannot be built from outside, because the current public surface exposes neither.

This document is the **contract request**, not an implementation. Both changes
are additive, return disposers, live in `src/` (never in the generated `lib/`),
and leave behaviour identical when no plugin registers.

## PR #1 — GitLens commit-action seam (required for the button)

**Problem.** `src/client/changes/GitLens.tsx:559-578` renders the commit row as
literal JSX (`<Input>` + `<button className={css.gitCommitButton}>`). There is no
slot, no registry, and no way for an external plugin to add a button there.
The selected repository (`GitLens.tsx:119`) and selected worktree
(`GitLens.tsx:118`) live in component-local `useState` and are never published,
so an external plugin cannot even learn *which* worktree the user is looking at.

**Requested contract** (all in `src/client/service.ts`):

```ts
export interface GitCommitTarget {
  scope: SessionScope
  /** Live value of GitLens' own repoRoot state. */
  repoRoot?: string
  /** Live value of GitLens' selectedWorktree state (undefined = primary). */
  worktree?: string
  branch?: string
  status: GitStatusResult
  /** Exactly the list the Commit button gates on. */
  staged: readonly GitStatusEntry[]
}

export interface GitCommitActionProps extends GitCommitTarget {
  service: BetterSidebarService
  /** Re-runs GitLens' status/branch/log refresh. */
  refresh(): Promise<void>
}

export interface GitCommitActionDescriptor {
  id: string
  title: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  /** Ascending; default 100. */
  order?: number
  available?: (target: GitCommitTarget) => boolean
  component: (props: GitCommitActionProps) => ReactNode
}

// on BetterSidebarService:
registerGitCommitAction(descriptor: GitCommitActionDescriptor): () => void
getGitCommitActions(): readonly GitCommitActionDescriptor[]
```

Plus:

1. Add `'gitCommitActions'` to `SIDEBAR_FEATURES` (`service.ts:697-710`) so
   consumers gate on `features.includes('gitCommitActions')`.
2. Render registered actions inside the existing `css.gitCommit` row
   (`GitLens.tsx:559-578`), after the Commit button, ordered by `order` then
   registration order, skipping `available === false`.
3. Notify existing subscribers through the current `subscribe()` mechanism so an
   open GitLens re-renders when the registry changes.

**Optional, same PR:** `setGitCommitStatus(ownerId, targetKey, status | null)`
with `status = { label, tone?: 'info'|'busy'|'ok'|'error', sessionId?: string }`,
rendered inline in the same row. The "return to the source session" action needs
no better-sidebar change: the registered component can call the host's
`ctx.sessions.open?.(sessionId)` itself.

**What the agent plugin does with it.** The registered component:
- calls `GET`-equivalent `gitCommitAgent.openTask({ sourceSessionId: scope.sessionId, workspaceRoot: worktree ?? repoRoot })`;
- opens the dedicated session (the plugin creates it; see `startDedicatedSession`);
- is disabled when there is no repository, no changes, or the target is still resolving.

## PR #2 — Proposed-diff seam (required for the plan preview)

**Problem.** `src/client/state.ts:23-25`:

```ts
export type SidebarDiffRef = { kind: 'worktree' } | { kind: 'commit'; ... }
```

There is no variant for arbitrary patch text, so a *proposed* diff (the plan's
per-commit diff) cannot be shown in DiffPane. `DiffPane` already accepts raw
patch text internally (`DiffPane.tsx:24`, `:589-596`), so only the union and one
render branch are missing.

**Requested contract:**

```ts
// src/client/state.ts
| { kind: 'proposed'; id: string; title: string; patch: string }
```

- Render through the existing `parseUnifiedDiff` / `DiffFiles` stack.
- Callers use the existing seed API: `openTab({ type: 'diff', id, title, diff: { kind: 'proposed', ... } })`.
- Gate on a new `'planDiff'` feature string.

## What is NOT requested

- No change to DSH core, ever.
- No new chat input, no second transcript: the dedicated session uses the native
  chat and the native composer.
- No exposure of `DiffPane` internals, and no new `/sidebar/api` route for this
  plugin's backend. The agent plugin owns its own business API and persistence.

## Interim behaviour (already implemented, no better-sidebar change)

Without PR #1/#2 the flow is still usable end to end:

- the dedicated session is created and driven by the plugin's own API
  (`startDedicatedSession`), reachable from any command surface;
- plan preview and approval are rendered from the tool results
  (`commit_agent_publish_plan` returns per-commit trees and diffs), which the
  host renders through the keyed `tool.call.toolview` slot;
- `commit_agent_diff` returns the same patch text the DiffPane seam would show.
