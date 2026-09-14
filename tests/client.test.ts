/**
 * Client-half tests.
 *
 * The bundle is hand-written lazy-CJS, so it can be exercised in Node with a
 * fake module-table loader, a fake React and a fake client context. That covers
 * the logic a browser would run — registration shape, gating, session creation,
 * draft seeding and proposed-diff opening — without a browser or a bundler.
 *
 * What this cannot cover: the real React renderer, the client module table's
 * fetch/materialize handshake, and the actual DiffPane rendering. Those remain
 * for a live browser session.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Minimal element node produced by the fake React. */
interface Element {
  type: unknown
  props: Record<string, unknown>
}

/** Registration captured from `window.__ModuleLoader__.load`. */
interface Registration {
  id: string
  factory: (require: (spec: string) => unknown) => Record<string, unknown>
}

/** Fake React with just enough surface for the bundle. */
function fakeReact(): Record<string, unknown> {
  return {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown {
      const filtered = children.filter((child) => child !== null && child !== undefined && child !== false)
      // React collapses a single child to that child and keeps several as an
      // array; mimic that so assertions can read `props.children` directly.
      const childValue = filtered.length === 0 ? null : filtered.length === 1 ? filtered[0] : filtered
      const merged = { ...(props ?? {}), children: childValue }
      // Render function components eagerly, like React does, so a test sees the
      // real element tree instead of an intermediate component node.
      if (typeof type === 'function') return (type as (p: Record<string, unknown>) => unknown)(merged)
      return { type, props: merged }
    },
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      let value = initial
      return [value, (next: unknown) => {
        value = next
      }]
    },
  }
}

/** The loaded registration, captured once (ESM caches the imported module). */
let cachedRegistration: Registration | null = null

/** Load the client bundle with fakes and return its exports plus the loader. */
async function loadBundle(): Promise<{ exports: Record<string, unknown>; registration: Registration }> {
  if (cachedRegistration === null) {
    const registrations: Registration[] = []
    const globalWithWindow = globalThis as unknown as { window?: unknown }
    const previous = globalWithWindow.window
    globalWithWindow.window = {
      __ModuleLoader__: {
        load(registration: Registration) {
          registrations.push(registration)
        },
      },
    }
    try {
      const url = new URL('../../client/client.js', import.meta.url).href
      await import(url)
    } finally {
      if (previous === undefined) delete globalWithWindow.window
      else globalWithWindow.window = previous
    }
    const registration = registrations[0]
    assert.ok(registration, 'the bundle must call window.__ModuleLoader__.load exactly once')
    assert.equal(registrations.length, 1)
    cachedRegistration = registration
  }
  const react = fakeReact()
  const exports = cachedRegistration.factory((spec: string) => {
    if (spec === 'react') return react
    throw new Error(`unexpected require(${spec})`)
  })
  return { exports, registration: cachedRegistration }
}

/** Walk an element tree depth-first. */
function walk(node: unknown, visit: (element: Element) => void): void {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const element = node as Element
  if (element.type !== undefined && element.props !== undefined) {
    visit(element)
    const children = element.props['children']
    if (Array.isArray(children)) for (const child of children) walk(child, visit)
    else walk(children, visit)
  }
}

/** First element whose `type` matches. */
function findByType(node: unknown, type: string): Element | null {
  let found: Element | null = null
  walk(node, (element) => {
    if (found === null && element.type === type) found = element
  })
  return found
}

/** A fake client context recording what the bundle registers. */
function fakeCtx(options: { withSidebar?: boolean; features?: string[]; openTab?: boolean } = {}): {
  ctx: Record<string, unknown>
  actions: Array<Record<string, unknown>>
  toolviews: Array<{ key: string; component: (props: Record<string, unknown>) => unknown }>
  created: Array<Record<string, unknown>>
  opened: string[]
  drafts: string[]
  submits: number
  tabs: Array<Record<string, unknown>>
  logged: string[]
} {
  const actions: Array<Record<string, unknown>> = []
  const toolviews: Array<{ key: string; component: (props: Record<string, unknown>) => unknown }> = []
  const created: Array<Record<string, unknown>> = []
  const opened: string[] = []
  const drafts: string[] = []
  const tabs: Array<Record<string, unknown>> = []
  const logged: string[] = []
  const state = { submits: 0 }

  const sidebar = {
    features: options.features ?? ['gitCommitActions', 'planDiff'],
    registerGitCommitAction(descriptor: Record<string, unknown>) {
      actions.push(descriptor)
      return () => undefined
    },
    openTab(seed: Record<string, unknown>) {
      tabs.push(seed)
    },
  }

  const services: Record<string, unknown> = {
    sessions: {
      async create(input: Record<string, unknown>) {
        created.push(input)
        return 'session-created'
      },
      open(id: string) {
        opened.push(id)
      },
      scope() {
        return { sessionId: 'session-created' }
      },
    },
    conversation: {
      input: {
        for() {
          return {
            setDraft(text: string) {
              drafts.push(text)
            },
            submit() {
              state.submits += 1
            },
          }
        },
      },
    },
    betterSidebar: options.withSidebar === false ? undefined : sidebar,
  }

  const ctx: Record<string, unknown> = {
    get(name: string) {
      return services[name]
    },
    slots: {
      inject(_key: string, factory: () => Generator<unknown>) {
        const iterator = factory()
        for (const yielded of iterator) void yielded
        return () => undefined
      },
      register(options_: { key: string }, component: (props: Record<string, unknown>) => unknown) {
        toolviews.push({ key: options_.key, component })
        return () => undefined
      },
    },
    logger: {
      info(message: string) {
        logged.push(message)
      },
    },
  }
  return {
    ctx,
    actions,
    toolviews,
    created,
    opened,
    drafts,
    tabs,
    logged,
    get submits() {
      return state.submits
    },
  }
}

test('the bundle registers itself under the package name and exports inject/apply', async () => {
  const { exports, registration } = await loadBundle()
  assert.equal(registration.id, 'dsh-git-commit-agent')
  assert.deepEqual(exports['inject'], ['slots', 'sessions', 'betterSidebar'])
  assert.equal(typeof exports['apply'], 'function')
})

test('apply registers the GitLens action with the delivered contract shape', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)

  assert.equal(harness.actions.length, 1)
  const action = harness.actions[0]
  assert.ok(action)
  assert.equal(action['id'], 'dsh-git-commit-agent:plan-and-commit')
  assert.equal(typeof action['order'], 'number')
  assert.equal(typeof action['available'], 'function')
  assert.equal(typeof action['component'], 'function')
  const available = action['available'] as (target: unknown) => boolean
  assert.equal(available({ status: { isRepo: true } }), true)
  assert.equal(available({ status: { isRepo: false } }), false)
  assert.equal(available(null), false)
})

test('the button is disabled without staged changes and enabled with them', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const action = harness.actions[0]
  assert.ok(action)
  const component = action['component'] as (props: Record<string, unknown>) => unknown

  const empty = component({ status: { isRepo: true }, staged: [], scope: { sessionId: 's' }, worktree: '/repo' })
  const emptyButton = findByType(empty, 'button')
  assert.equal(emptyButton?.props['disabled'], true)

  const ready = component({ status: { isRepo: true }, staged: [{ path: 'a' }], scope: { sessionId: 's' }, worktree: '/repo' })
  const readyButton = findByType(ready, 'button')
  assert.equal(readyButton?.props['disabled'], false)
})

test('clicking the button creates a session in the worktree, seeds the prompt and submits', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = (harness.actions[0] as Record<string, unknown>)['component'] as (props: Record<string, unknown>) => unknown

  const tree = component({
    status: { isRepo: true },
    staged: [{ path: 'a' }],
    scope: { sessionId: 'session-source' },
    repoRoot: '/repo',
    worktree: '/repo-wt',
    branch: 'feat/x',
  })
  const button = findByType(tree, 'button')
  assert.ok(button)
  ;(button.props['onClick'] as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(harness.created, [{ cwd: '/repo-wt' }])
  assert.deepEqual(harness.opened, ['session-created'])
  assert.equal(harness.drafts.length, 1)
  assert.ok(harness.drafts[0]?.includes('/repo-wt'))
  assert.ok(harness.drafts[0]?.includes('commit_agent_request_approval'))
  assert.ok(harness.drafts[0]?.includes('不要自己声称我已批准'))
  assert.equal(harness.submits, 1)
})

test('the button falls back to repoRoot when no worktree is selected', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = (harness.actions[0] as Record<string, unknown>)['component'] as (props: Record<string, unknown>) => unknown
  const tree = component({ status: { isRepo: true }, staged: [{}], scope: { sessionId: 's' }, repoRoot: '/primary' })
  const button = findByType(tree, 'button')
  ;(button?.props['onClick'] as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(harness.created, [{ cwd: '/primary' }])
})

test('a missing sidebar degrades to tools-only without throwing', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({ withSidebar: false })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  assert.equal(harness.actions.length, 0)
  assert.equal(harness.logged.length, 1)
  // The transcript cards are still registered.
  assert.deepEqual(harness.toolviews.map((t) => t.key).sort(), ['commit_agent_publish_plan', 'commit_agent_request_approval'].sort())
})

test('an older sidebar without the feature flag is not used', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({ features: ['badge'] })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  assert.equal(harness.actions.length, 0)
})

test('the plan card renders the plan and opens a proposed diff', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const card = harness.toolviews.find((t) => t.key === 'commit_agent_publish_plan')
  assert.ok(card)

  const meta = {
    planId: 'plan-1',
    revision: 2,
    planDigest: 'abcdef0123456789',
    blockers: [],
    preview: [
      { commitId: 'c1', message: 'feat: add a\n\nbody', patch: 'diff --git a/a b/a\n' },
      { commitId: 'c2', message: 'test: cover a', patch: 'diff --git a/b b/b\n' },
    ],
  }
  const tree = card.component({ block: { meta } })
  const text = JSON.stringify(tree)
  assert.ok(text.includes('revision 2'))
  assert.ok(text.includes('feat: add a'))
  assert.ok(text.includes('test: cover a'))

  // The card's diff button opens a proposed diff through the sidebar.
  let diffButton: Element | null = null
  walk(tree, (element) => {
    if (element.type === 'button' && element.props['children'] === '查看差异' && diffButton === null) diffButton = element
  })
  assert.ok(diffButton, 'the card must offer a diff button per commit')
  ;((diffButton as Element).props['onClick'] as () => void)()
  assert.equal(harness.tabs.length, 1)
  const seed = harness.tabs[0] as Record<string, unknown>
  assert.equal(seed['type'], 'diff')
  assert.equal(seed['id'], 'git-commit-agent:plan:plan-1:c1')
  const diff = seed['diff'] as Record<string, unknown>
  assert.equal(diff['kind'], 'proposed')
  assert.ok(String(diff['patch']).includes('diff --git'))
})

test('the plan card shows blockers and tolerates a running (meta-less) call', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const card = harness.toolviews.find((t) => t.key === 'commit_agent_publish_plan')
  assert.ok(card)

  const pending = JSON.stringify(card.component({ block: {} }))
  assert.ok(pending.includes('正在整理'))

  const blocked = card.component({
    block: {
      meta: {
        planId: 'p',
        revision: 1,
        planDigest: 'd',
        blockers: [{ code: 'UNCOVERED_CHANGE', message: 'change not covered: b.txt' }],
        preview: [],
      },
    },
  })
  assert.ok(JSON.stringify(blocked).includes('UNCOVERED_CHANGE'))
})

test('the approval card reflects the decision', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const card = harness.toolviews.find((t) => t.key === 'commit_agent_request_approval')
  assert.ok(card)
  assert.ok(JSON.stringify(card.component({ block: { meta: { approved: true, planId: 'p', revision: 1 } } })).includes('已获批准'))
  assert.ok(JSON.stringify(card.component({ block: { meta: { approved: false, planId: 'p', revision: 1 } } })).includes('未获批准'))
})
