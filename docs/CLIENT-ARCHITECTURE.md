# Client source boundary

The browser artifact is generated with `node scripts/build-client.mjs`; no new
bundler or runtime dependency is required. Source files are ordinary CommonJS
modules, not ordered text fragments. Each feature imports its own dependencies.
The explicit build manifest validates syntax, local import membership and an
acyclic dependency graph before writing `dist/client/index.js`.

## Dependency layers

- `runtime.cjs`: React and the platform UI primitives, obtained from DSH.
- `constants.cjs`, `context.cjs`: host protocol identifiers and guarded lookup.
- `styles.cjs`: stylesheet text and idempotent injection.
- `prompts.cjs`, `settings.cjs`: bilingual prompt contracts, preferences and
  best-effort host model catalog/selection RPCs.
- `icons.cjs`, `palette-copy.cjs`: namespaced artwork and command presentation.
- `session.cjs`: workspace membership, active composer and dedicated startup.
- `palette.cjs`, `git-action.cjs`: optional palette and native GitLens actions.
- `settings-ui.cjs`: preset-scoped configuration dictionary and editor.
- `plan-model.cjs`: immutable identity/resource/URL helpers and display metadata.
- `plan-views.cjs`: full historical plan and recent-plan browser.
- `plan-sidebar.cjs`: Inspector/legacy tabs, versioned proposed diffs and polling.
- `plan-cards.cjs`: transcript review and apply-result cards.
- `index.cjs`: slot/service lifecycle composition and unchanged test hooks.

## Lazy loading and behavior preservation

Evaluating the generated file calls `window.__ModuleLoader__.load` exactly once,
with the original package ID and factory protocol. It does not initialize React,
access services, fetch data or inject styles. The internal module table and cache
are created inside that factory: every factory invocation has independent module
state, and platform dependencies still use the supplied `require`. Only the
original React and UI-primitives package IDs cross this boundary.

The implementation bodies, prompt strings (including pre-existing uncommitted
ordinary-session changes), SVG artwork, CSS, IDs, inject services, slot contracts
and `__test` surface were migrated without behavioral rewrites. The source
composition is acyclic: session startup uses palette presentation, but command
registration alone depends on startup, so there is no palette/session cycle.

Dedicated sessions still receive the reserved session prefix and workspace
membership, pin the stored model before first submission, honor cancellation and
recheck palette targets. Ordinary-session commands still only seed/focus drafts
and preserve occupied composers. Plans remain read-only: source identity and
revision scope recovery, Inspector mode avoids polling, legacy polling ignores
historical baselines/replays, and approval remains entirely host-owned.

The client does not create a typert Remote or copy Cordis. Dedicated agent
creation and per-session commit tool scope remain host responsibilities; client
startup uses only public session/conversation APIs.

Development instrumentation must operate on `dist/client` after a clean build.
Rebuilding discards instrumentation without resetting or rewriting source files.
