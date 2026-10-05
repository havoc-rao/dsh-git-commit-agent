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
import { COMMIT_AGENT_SESSION_PREFIX } from '../src/host/tools.js'

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
    useEffect() {},
    useRef(initial: unknown): { current: unknown } {
      return { current: initial }
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
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return {
      MenuItemButton: (props: Record<string, unknown>) => ({
        type: 'button', props: { ...props, role: 'menuitem', onClick: props['onSelect'] },
      }),
    }
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

/** First element whose `props.className` contains the given class. */
function findByClassName(node: unknown, className: string): Element | null {
  let found: Element | null = null
  walk(node, (element) => {
    if (found !== null) return
    const classes = element.props['className']
    if (typeof classes === 'string' && classes.split(/\s+/).includes(className)) found = element
  })
  return found
}

/**
 * Assert the button created exactly one commit session at the expected target.
 *
 * The host identifies a commit session by the reserved id prefix, so every
 * creation must carry it — the same value the host half matches on.
 */
function assertCommitSession(
  harness: { created: Array<Record<string, unknown>> },
  expected: { cwd?: string; workspaceId?: string },
): Record<string, unknown> {
  assert.equal(harness.created.length, 1)
  const input = harness.created[0] as Record<string, unknown>
  assert.equal(input['cwd'], expected.cwd)
  assert.equal(input['workspaceId'], expected.workspaceId)
  assert.equal(typeof input['sessionId'], 'string')
  assert.ok(
    (input['sessionId'] as string).startsWith(COMMIT_AGENT_SESSION_PREFIX),
    `session id ${String(input['sessionId'])} must carry the reserved prefix`,
  )
  return input
}

/** A fake client context recording what the bundle registers. */
function fakeCtx(options: {
  withSidebar?: boolean
  features?: string[]
  openTab?: boolean
  /** Registered Workspaces the fake `workspaces` service reports. */
  workspaces?: Array<{ workspaceId: string; path: string }>
  /** Make `sessions.create({ workspaceId })` reject, like a vanished Workspace. */
  failWorkspaceCreate?: boolean
  /** Fake `configForms` service (preset-card configuration dialog). */
  configForms?: Record<string, unknown>
  /** Fake `locale` service (UI language for prompt-language resolution). */
  locale?: Record<string, unknown>
  /** Fake `remote` service whose `session` namespace answers model RPCs. */
  remote?: Record<string, unknown>
} = {}): {
  ctx: Record<string, unknown>
  actions: Array<Record<string, unknown>>
  toolviews: Array<{ key: string; options: Record<string, unknown>; component: (props: Record<string, unknown>) => unknown }>
  created: Array<Record<string, unknown>>
  opened: string[]
  drafts: string[]
  submits: number
  tabs: Array<Record<string, unknown>>
  logged: string[]
  modelSelections: Array<Record<string, unknown>>
} {
  const actions: Array<Record<string, unknown>> = []
  const toolviews: Array<{ key: string; options: Record<string, unknown>; component: (props: Record<string, unknown>) => unknown }> = []
  const created: Array<Record<string, unknown>> = []
  const opened: string[] = []
  const drafts: string[] = []
  const tabs: Array<Record<string, unknown>> = []
  const logged: string[] = []
  const modelSelections: Array<Record<string, unknown>> = []
  const state = { submits: 0 }

  const sidebar = {
    features: options.features ?? ['gitCommitActions', 'planDiff'],
    registerGitCommitAction(descriptor: Record<string, unknown>) {
      void descriptor
      throw new Error('legacy registry must never be called')
      return () => undefined
    },
    openTab(seed: Record<string, unknown>, scope?: Record<string, unknown>) {
      tabs.push({ ...seed, ...(scope === undefined ? {} : { scope }) })
    },
  }

  const services: Record<string, unknown> = {
    sessions: {
      async create(input: Record<string, unknown>) {
        if (options.failWorkspaceCreate === true && input['workspaceId'] !== undefined) {
          throw new Error('workspace/not-found')
        }
        created.push(input)
        const requested = input['sessionId']
        return typeof requested === 'string' && requested !== '' ? requested : 'session-created'
      },
      open(id: string) {
        opened.push(id)
      },
      scope(id: string) {
        return { sessionId: id }
      },
    },
    workspaces: options.workspaces === undefined
      ? undefined
      : {
          list: {
            getSnapshot() {
              return { items: options.workspaces }
            },
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
    configForms: options.configForms,
    locale: options.locale,
    remote: options.remote,
    betterSidebar: options.withSidebar === false ? undefined : sidebar,
  }

  const ctx: Record<string, unknown> = {
    get(name: string) {
      return services[name]
    },
    slots: {
      inject(key: string, factory: () => Generator<unknown> | (() => void)) {
        if (key === 'betterSidebar.git.actions' && options.withSidebar === false) return () => undefined
        const result = factory()
        if (typeof result !== 'function') for (const yielded of result) void yielded
        return () => undefined
      },
      register(options_: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown) {
        if (options_['name'] === 'betterSidebar.git.actions') {
          actions.push({ ...options_, component: (props: Record<string, unknown>) => component({
            busy: false, close: () => undefined, runAction: (action: () => Promise<unknown>) => action(), ...props,
          }) })
        } else toolviews.push({ key: String(options_['key'] ?? ''), options: options_, component })
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
    modelSelections,
    get submits() {
      return state.submits
    },
  }
}

test('the bundle registers itself under the package name and exports inject/apply', async () => {
  const { exports, registration } = await loadBundle()
  assert.equal(registration.id, 'dsh-git-commit-agent')
  // The observer must wait for the mounted-seat service instead of silently
  // returning a no-op when sidebarRight arrives after this plugin applies.
  assert.deepEqual(exports['inject'], ['slots', 'sessions', 'betterSidebar', 'sidebarRight'])
  assert.equal(typeof exports['apply'], 'function')
})

test('apply registers only the native More action slot with the delivered contract shape', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)

  assert.equal(harness.actions.length, 1)
  const action = harness.actions[0]
  assert.ok(action)
  assert.equal(action['id'], 'dsh-git-commit-agent:plan-and-commit')
  assert.equal(typeof action['order'], 'number')
  assert.equal(action['name'], 'betterSidebar.git.actions')
  assert.equal(typeof action['component'], 'function')
  const component = action['component'] as (props: Record<string, unknown>) => unknown
  assert.equal(component({ status: { isRepo: false } }), null)
  assert.equal(component({}), null)
})

test('More closes first and delegates a captured owner action that survives menu unmount', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = harness.actions[0]?.['component'] as (props: Record<string, unknown>) => unknown
  const events: string[] = []
  let captured: (() => Promise<unknown>) | undefined
  const tree = component({
    status: { isRepo: true, entries: [{}] }, staged: [],
    sessionId: 'wrong-header', scope: { sessionId: 'actual-lens' },
    repoRoot: '/repo', worktree: '/actual-owner-wt', branch: 'owner-branch',
    close: () => { events.push('close') },
    runAction: async (action: () => Promise<unknown>) => { events.push('run'); captured = action },
  })
  const button = findByType(tree, 'button')
  assert.equal(button?.props['role'], 'menuitem')
  const label = button?.props['children'] as Element
  assert.equal(label.type, 'span')
  assert.equal(label.props['data-better-sidebar-git-action-label'], '')
  const [title, subtitle] = label.props['children'] as Element[]
  assert.equal(title?.type, 'span')
  assert.equal(title?.props['data-better-sidebar-git-action-title'], '')
  assert.equal(title?.props['children'], '规划并提交')
  assert.equal(subtitle?.type, 'span')
  assert.equal(subtitle?.props['data-better-sidebar-git-action-subtitle'], '')
  assert.equal(subtitle?.props['children'], 'agent')
  assert.equal(button?.props['disabled'], false)
  assert.equal(button?.props['shortcut'], undefined, 'agent is a subtitle, not a keyboard shortcut')
  await (button?.props['onSelect'] as () => Promise<void>)()
  assert.deepEqual(events, ['close', 'run'])
  assert.equal(harness.created.length, 0)
  assert.ok(captured)
  await captured()
  assertCommitSession(harness, { cwd: '/actual-owner-wt' })
  assert.ok(harness.drafts[0]?.includes('owner-branch'))
})

test('busy and clean items never close or run even when selected programmatically', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = harness.actions[0]?.['component'] as (props: Record<string, unknown>) => unknown
  for (const props of [
    { busy: true, status: { isRepo: true, entries: [{}] } },
    { busy: false, status: { isRepo: true, entries: [] } },
  ]) {
    const tree = component({ ...props, worktree: '/repo', staged: [],
      close: () => assert.fail('disabled action must not close'),
      runAction: () => assert.fail('disabled action must not run'),
    })
    const button = findByType(tree, 'button')
    assert.equal(button?.props['disabled'], true)
    assert.equal(button?.props['role'], 'menuitem')
    assert.equal(button?.props['shortcut'], undefined)
    const label = button?.props['children'] as Element
    assert.equal(label.props['data-better-sidebar-git-action-label'], '')
    const [title, subtitle] = label.props['children'] as Element[]
    assert.equal(title?.props['children'], '规划并提交')
    assert.equal(subtitle?.props['children'], 'agent')
    assert.equal(subtitle?.props['data-better-sidebar-git-action-subtitle'], '')
    ;(button?.props['onSelect'] as () => void)()
  }
  assert.equal(harness.created.length, 0)
})

test('planning failures reach the owner instead of disappearing with the menu', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = harness.actions[0]?.['component'] as (props: Record<string, unknown>) => unknown
  let error: unknown
  const tree = component({ status: { isRepo: true, entries: [{}] }, staged: [],
    scope: { sessionId: 'owner' }, close: () => undefined,
    runAction: async (action: () => Promise<unknown>) => {
      try { await action() } catch (failure) { error = failure }
    },
  })
  await (findByType(tree, 'button')?.props['onSelect'] as () => Promise<void>)()
  assert.match(String(error), /找不到目标 worktree/)
})

test('slot waits for its owner and returns the registration disposer on remount', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  let factory: (() => (() => void)) | undefined
  let registrations = 0
  let disposals = 0
  harness.ctx['slots'] = {
    inject(name: string, callback: () => (() => void)) {
      if (name === 'betterSidebar.git.actions') factory = callback
      return () => undefined
    },
    register(options: Record<string, unknown>) {
      assert.equal(options['name'], 'betterSidebar.git.actions')
      registrations += 1
      return () => { disposals += 1 }
    },
  }
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  assert.ok(factory)
  assert.equal(registrations, 0)
  factory()()
  factory()()
  assert.equal(registrations, 2)
  assert.equal(disposals, 2)
})

test('the button is usable with any working-tree change, staged or not', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const action = harness.actions[0]
  assert.ok(action)
  const component = action['component'] as (props: Record<string, unknown>) => unknown

  const clean = component({ status: { isRepo: true, entries: [] }, staged: [], scope: { sessionId: 's' }, worktree: '/repo' })
  const cleanButton = findByType(clean, 'button')
  assert.equal(cleanButton?.props['disabled'], true)

  // An empty index with unstaged changes must enable the flow: the plan
  // stages the files itself before committing.
  const unstaged = component({ status: { isRepo: true, entries: [{ path: 'a', xy: ' M' }] }, staged: [], scope: { sessionId: 's' }, worktree: '/repo' })
  const unstagedButton = findByType(unstaged, 'button')
  assert.equal(unstagedButton?.props['disabled'], false)

  // Untracked files alone enable it too.
  const untracked = component({ status: { isRepo: true, entries: [{ path: 'b', xy: '??' }] }, staged: [], scope: { sessionId: 's' }, worktree: '/repo' })
  const untrackedButton = findByType(untracked, 'button')
  assert.equal(untrackedButton?.props['disabled'], false)

  // Staged content keeps working as before.
  const staged = component({ status: { isRepo: true, entries: [{ path: 'a', xy: 'M ' }] }, staged: [{ path: 'a' }], scope: { sessionId: 's' }, worktree: '/repo' })
  const stagedButton = findByType(staged, 'button')
  assert.equal(stagedButton?.props['disabled'], false)
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

  const createInput = assertCommitSession(harness, { cwd: '/repo-wt' })
  assert.deepEqual(harness.opened, [createInput['sessionId']])
  assert.equal(harness.drafts.length, 1)
  assert.ok(harness.drafts[0]?.includes('/repo-wt'))
  assert.ok(harness.drafts[0]?.includes('commit_agent_apply_plan'))
  assert.ok(harness.drafts[0]?.includes('不要自己声称我已批准'))
  assert.equal(harness.submits, 1)
})

test('clicking with an empty index runs the same flow and tells the agent to stage first', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = (harness.actions[0] as Record<string, unknown>)['component'] as (props: Record<string, unknown>) => unknown

  const tree = component({
    status: { isRepo: true, entries: [{ path: 'a', xy: ' M' }, { path: 'b', xy: '??' }] },
    staged: [],
    scope: { sessionId: 'session-source' },
    repoRoot: '/repo',
    worktree: '/repo-wt',
    branch: 'feat/x',
  })
  const button = findByType(tree, 'button')
  assert.ok(button)
  assert.equal(button.props['disabled'], false)
  ;(button.props['onClick'] as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const createInput = assertCommitSession(harness, { cwd: '/repo-wt' })
  assert.deepEqual(harness.opened, [createInput['sessionId']])
  assert.equal(harness.drafts.length, 1)
  assert.ok(harness.drafts[0]?.includes('commit_agent_inspect'))
  assert.ok(harness.drafts[0]?.includes('没有已暂存内容'))
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
  assertCommitSession(harness, { cwd: '/primary' })
})

test('a target inside a registered workspace creates the session through that workspace', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({ workspaces: [{ workspaceId: 'ws-1', path: '/repo' }] })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = (harness.actions[0] as Record<string, unknown>)['component'] as (props: Record<string, unknown>) => unknown
  const tree = component({
    status: { isRepo: true },
    staged: [{ path: 'a' }],
    scope: { sessionId: 's' },
    worktree: '/repo',
    branch: 'main',
  })
  const button = findByType(tree, 'button')
  ;(button?.props['onClick'] as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))

  // `workspaceId` (not `cwd`) is what makes the host attach the session, which
  // is what keeps it out of 未分组.
  assertCommitSession(harness, { workspaceId: 'ws-1' })
})

test('a trailing separator still matches the registered workspace path', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({ workspaces: [{ workspaceId: 'ws-2', path: '/repo/' }] })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = (harness.actions[0] as Record<string, unknown>)['component'] as (props: Record<string, unknown>) => unknown
  const tree = component({ status: { isRepo: true }, staged: [{}], scope: { sessionId: 's' }, repoRoot: '/repo' })
  const button = findByType(tree, 'button')
  ;(button?.props['onClick'] as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assertCommitSession(harness, { workspaceId: 'ws-2' })
})

test('a linked worktree outside every workspace stays a plain cwd session', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({ workspaces: [{ workspaceId: 'ws-1', path: '/repo' }] })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = (harness.actions[0] as Record<string, unknown>)['component'] as (props: Record<string, unknown>) => unknown
  const tree = component({
    status: { isRepo: true },
    staged: [{}],
    scope: { sessionId: 's' },
    repoRoot: '/repo',
    worktree: '/repo-wt',
  })
  const button = findByType(tree, 'button')
  ;(button?.props['onClick'] as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))

  // A linked worktree path is not a Workspace path, so it cannot be attached
  // (the host requires cwd === workspace path); the session still gets created.
  assertCommitSession(harness, { cwd: '/repo-wt' })
})

test('a rejected workspace create falls back to a cwd session', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({
    workspaces: [{ workspaceId: 'ws-1', path: '/repo' }],
    failWorkspaceCreate: true,
  })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const component = (harness.actions[0] as Record<string, unknown>)['component'] as (props: Record<string, unknown>) => unknown
  const tree = component({ status: { isRepo: true }, staged: [{}], scope: { sessionId: 's' }, worktree: '/repo' })
  const button = findByType(tree, 'button')
  ;(button?.props['onClick'] as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assertCommitSession(harness, { cwd: '/repo' })
})

test('a missing sidebar degrades to tools-only without throwing', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({ withSidebar: false })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  assert.equal(harness.actions.length, 0)
  assert.equal(harness.logged.length, 1)
  // The transcript cards and the preset-card action are still registered.
  assert.deepEqual(harness.toolviews.map((t) => t.key).sort(), ['', 'commit_agent_prepare_plan', 'commit_agent_apply_plan'].sort())
  assert.ok(harness.toolviews.some((t) => t.options['name'] === 'settings.agentPreset.card.action'))
})

test('native registration does not depend on the legacy feature flag', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({ features: ['badge'] })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  assert.equal(harness.actions.length, 1)
})

test('the plan card renders summary, details, exclusions and a versioned proposed diff', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const card = harness.toolviews.find((t) => t.key === 'commit_agent_prepare_plan')
  assert.ok(card)

  const meta = {
    planId: 'plan-1',
    revision: 2,
    planDigest: 'abcdef0123456789',
    indexStrategy: 'index-empty-whole-file',
    previewTruncated: true,
    preview: [
      {
        commitId: 'c1',
        message: 'feat: add a\n\nbody',
        rationale: 'groups the new file with its test',
        patch: 'diff --git a/a b/a\n',
        patchTruncated: true,
        baseTree: '0000',
        expectedTree: '1111',
        stat: { files: 2, additions: 82, deletions: 16 },
        changes: [
          { changeId: 'x1', path: 'src/a.ts', layer: 'worktree', status: 'modified' },
          { changeId: 'x2', oldPath: 'old/a.ts', path: 'src/a.ts', layer: 'worktree', status: 'renamed', binary: true },
          { changeId: 'x5', path: 'src/indexed.ts', layer: 'index', status: 'modified' },
        ],
        dependsOn: [],
      },
      {
        commitId: 'c2',
        message: 'test: cover a',
        patch: 'diff --git a/b b/b\n',
        stat: { files: 1, additions: 3, deletions: 0 },
        changes: [{ changeId: 'x3', path: 'src/a.test.ts', layer: 'untracked', status: 'untracked' }],
        dependsOn: ['c1'],
      },
    ],
    excludedChanges: [{ changeId: 'x4', path: 'tmp.log', reason: 'not part of this change' }],
    warnings: ['a warning'],
    delta: {
      fromRevision: 1,
      entries: [
        { kind: 'message-changed', commitId: 'c1' },
        { kind: 'file-moved', commitId: 'c2', fromCommitId: 'c1', changeId: 'x2', path: 'src/a.ts' },
        { kind: 'file-excluded', fromCommitId: 'c1', changeId: 'x4', path: 'tmp.log' },
      ],
    },
    commits: [
      { id: 'c1', message: 'feat: add a' },
      { id: 'c2', message: 'test: cover a' },
    ],
  }
  const tree = card.component({ block: { meta }, sessionId: 'session-git-commit-t' })
  const text = JSON.stringify(tree)
  // Header: revision, commit count and the host-computed file count.
  assert.ok(text.includes('revision 2'))
  assert.ok(text.includes('2 个提交'))
  assert.ok(text.includes('3 个文件'))
  // Per-commit summary lines carry subject and untruncated statistics.
  assert.ok(text.includes('feat: add a'))
  assert.ok(text.includes('test: cover a'))
  assert.ok(text.includes('2 文件 · +82/-16'))
  // Warnings and exclusions are visible.
  assert.ok(text.includes('暂不提交 1 项'))
  assert.ok(text.includes('tmp.log'))
  assert.ok(text.includes('a warning'))
  // Per-file rows carry the git/VSCode status symbol with the layer, e.g.
  // `M 未暂存`, `M 已暂存`, `R 未暂存 … →`, `? 未跟踪`.
  assert.ok(text.includes('M 未暂存 · src/a.ts'))
  assert.ok(text.includes('M 已暂存 · src/indexed.ts'))
  assert.ok(text.includes('R 未暂存 · old/a.ts → src/a.ts [二进制]'))
  assert.ok(text.includes('? 未跟踪 · src/a.test.ts'))
  // The revision delta answers "what changed since I last declined". Target
  // commits render as their position (2), source commits by id (c1) — the
  // previous revision's numbering is not carried.
  assert.ok(text.includes('相对上一版（rev 1）3 项'))
  assert.ok(text.includes('提交 1 的消息已更新'))
  assert.ok(text.includes('src/a.ts 从提交 c1 移入提交 2'))
  assert.ok(text.includes('tmp.log 变为暂不提交（原在提交 c1）'))

  // The card's diff button opens a proposed diff whose identity is scoped to
  // the plan revision, so two revisions never share one tab.
  let diffButton: Element | null = null
  walk(tree, (element) => {
    if (element.type === 'button' && element.props['children'] === '查看差异' && diffButton === null) diffButton = element
  })
  assert.ok(diffButton, 'the card must offer a diff button per commit')
  ;((diffButton as Element).props['onClick'] as () => void)()
  assert.equal(harness.tabs.length, 1)
  const seed = harness.tabs[0] as Record<string, unknown>
  assert.equal(seed['type'], 'diff')
  assert.equal(seed['id'], 'git-commit-agent:plan:plan-1:2:c1')
  assert.equal(seed['title'], '计划 v2 · c1 · feat: add a')
  // Explicit scope: the open lands in the initiating session's sidebar state.
  assert.deepEqual(seed['scope'], { sessionId: 'session-git-commit-t' })
  const diff = seed['diff'] as Record<string, unknown>
  assert.equal(diff['kind'], 'proposed')
  assert.ok(String(diff['patch']).includes('diff --git'))
  // Integrity metadata for the sidebar: the caller-declared truncation flag
  // and a snapshot label identifying the exact plan revision.
  assert.equal(diff['truncated'], true)
  assert.equal(diff['sourceRef'], 'plan plan-1 rev 2')
})

test('the plan card shows blockers and tolerates a running (meta-less) call', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const card = harness.toolviews.find((t) => t.key === 'commit_agent_prepare_plan')
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

test('the apply card reflects the decision and the execution', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx()
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const card = harness.toolviews.find((t) => t.key === 'commit_agent_apply_plan')
  assert.ok(card)
  const executed = JSON.stringify(card.component({
    block: { meta: { approved: true, planId: 'p', revision: 1, outcome: 'completed', commits: [{ oid: 'abc1' }] } },
  }))
  assert.ok(executed.includes('已获批准'))
  assert.ok(executed.includes('execution completed'))
  assert.ok(executed.includes('1 个提交'))
  assert.ok(JSON.stringify(card.component({ block: { meta: { approved: false, planId: 'p', revision: 1 } } })).includes('未获批准'))
})

test('the client prompt builder emits zh and en from the fourth argument', async () => {
  const { exports } = await loadBundle()
  const build = (exports['__test'] as Record<string, unknown>)['buildPlanningPrompt'] as (w: string, b: string, s: number, l?: string) => string
  const zh = build('/repo-wt', 'main', 0, 'zh')
  assert.ok(zh.includes('请为这个 worktree 规划提交'))
  assert.ok(zh.includes('当前没有已暂存内容'))
  assert.ok(zh.includes('每一步都必须使用工具'))
  assert.ok(zh.includes('都必须使用中文'))
  const en = build('/repo-wt', 'main', 0, 'en')
  assert.ok(en.includes('Plan commits for this worktree.'))
  assert.ok(en.includes('There is nothing staged yet'))
  assert.ok(en.includes('Use the tools for every step'))
  assert.ok(en.includes('in English'))
  const zhStaged = build('/repo-wt', 'main', 2, 'zh')
  assert.ok(!zhStaged.includes('当前没有已暂存内容'))
  // Historical default: no language argument means Chinese (kept for the
  // pre-preference behavior and plain embeds).
  assert.equal(build('/repo-wt', 'main', 0), zh)
})

test('the client language resolver mirrors the host rule', async () => {
  const { exports } = await loadBundle()
  const resolve = (exports['__test'] as Record<string, unknown>)['resolvePromptLanguage'] as (p: unknown, l: string) => string
  assert.equal(resolve('zh', 'en-US'), 'zh')
  assert.equal(resolve('en', 'zh-CN'), 'en')
  assert.equal(resolve('follow-ui', 'zh-CN'), 'zh')
  assert.equal(resolve(undefined, 'en'), 'en')
  assert.equal(resolve('fr', 'zh-CN'), 'zh')
  assert.equal(resolve(null, 'zh'), 'zh')
})

test('the client reads the stored preference and falls back to the UI locale', async () => {
  const { exports } = await loadBundle()
  const read = (exports['__test'] as Record<string, unknown>)['promptLanguageFor'] as (ctx: unknown) => string
  const services = {
    configForms: {
      get() {
        return {
          getSnapshot() {
            return { status: 'ready', value: { promptLanguage: 'en' } }
          },
        }
      },
    },
    locale: {
      getSnapshot() {
        return { active: 'zh-CN' }
      },
    },
  }
  const ctx = { get: (name: string) => services[name as keyof typeof services] }
  // The stored preference wins over the UI locale.
  assert.equal(read(ctx), 'en')
  // No preference: follow the UI locale.
  const formsService = services.configForms as { get: () => { getSnapshot(): { status: string; value: Record<string, unknown> } } }
  formsService.get = () => ({
    getSnapshot() {
      return { status: 'ready', value: {} }
    },
  })
  assert.equal(read(ctx), 'zh')
  // No forms surface at all: the historical Chinese default.
  const bare = { get: () => undefined }
  assert.equal(read(bare), 'zh')
})

test('apply registers the preset-card configuration action into the card-action slot', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({ configForms: undefined, locale: undefined })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const entry = harness.toolviews.find((t) => t.options['name'] === 'settings.agentPreset.card.action')
  assert.ok(entry, 'a card-action slot registration should exist')
  assert.equal(entry.options['id'], 'dsh-git-commit-agent/card-configure')
  assert.equal(entry.options['locale'], 'commitAgent.cardAction')
})

test('the card action renders only for the configured preset and vanishes for every other card', async () => {
  const { exports } = await loadBundle()
  const testHooks = exports['__test'] as Record<string, unknown>
  // The settings namespace must be the cordis row id, not the module name:
  // the host settings service rejects any other key ("No configurable plugin
  // entry"), which surfaces to the user as a failed save.
  assert.equal(testHooks['SETTINGS_NAMESPACE'], 'git-commit-agent')
  const entry = testHooks['CardConfigureAction'] as (
    props: Record<string, unknown>,
  ) => unknown
  const props = { close: () => undefined, t: (key: string) => key }
  // Only the protocol-registered preset owns configuration: the action renders
  // a gear trigger button for it.
  const configured = entry({ ...props, presetId: 'git-commit' }) as { type: string }
  assert.equal(configured.type, 'div')
  const trigger = findByType(configured, 'button')
  assert.ok(trigger)
  // The trigger is an icon button carrying the gear artwork and a dictionary
  // tooltip; the svg is decorative (aria-hidden).
  assert.ok(findByType(configured, 'svg'), 'the trigger should contain a gear svg')
  assert.equal(String(trigger.props['data-tip']), 'label')
  const svg = findByType(configured, 'svg') as { props: Record<string, unknown> } | null
  assert.equal(svg?.props['aria-hidden'], 'true')
  // Every other card — built-ins and third-party presets alike — gets a null
  // contribution: zero placeholder, no button, nothing in the footer.
  for (const presetId of ['standard', 'ptc', 'minimal', 'cordis', 'someone-elses-preset']) {
    assert.equal(entry({ ...props, presetId }), null, `${presetId} must not render the action`)
  }
})

test('the card-action dialog renders with the settings-style shell and closes through every path', async () => {
  const { exports } = await loadBundle()
  const calls: Array<Record<string, unknown>> = []
  const forms = {
    getSnapshot() {
      return { status: 'ready', value: { promptLanguage: 'en' } }
    },
    async mutate(ops: Array<Record<string, unknown>>) {
      calls.push(...ops)
      return true
    },
  }
  const harness = fakeCtx({ configForms: { get: () => forms } })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  const entry = harness.toolviews.find((t) => t.options['name'] === 'settings.agentPreset.card.action')
  assert.ok(entry)

  // The trigger button carries the preset id in its accessible label.
  const t = (key: string): string => key
  const tree = entry.component({ presetId: 'git-commit', close: () => undefined, t })
  const button = findByType(tree, 'button')
  assert.ok(button)
  assert.equal(String(button.props['aria-label']), 'label: git-commit')

  // The dialog uses the settings-shell structure: mask + elevated panel with a
  // header and a dictionary-labeled close button.
  const Dialog = (exports['__test'] as Record<string, unknown>)['ConfigureDialog'] as (props: Record<string, unknown>) => unknown
  let closed = 0
  const catalog = {
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    ],
    failed: false,
  }
  const dialog = Dialog({
    ctx: harness.ctx, t, initialValue: 'zh',
    initialModel: { provider: 'deepseek', model: 'deepseek-chat' },
    catalog, onClose: () => { closed += 1 },
  })

  const mask = findByClassName(dialog as never, 'dsh-gca-dialog-mask')
  assert.ok(mask, 'a full-screen mask should exist')
  assert.equal(mask.props['aria-hidden'], 'true')
  const panel = findByClassName(dialog as never, 'dsh-gca-dialog-panel')
  assert.ok(panel, 'an elevated panel should exist')
  assert.equal(panel.props['role'], 'dialog')
  assert.ok(findByClassName(dialog as never, 'dsh-gca-dialog-header'), 'a title row should exist')
  const closeButton = findByClassName(dialog as never, 'dsh-gca-dialog-close')
  assert.ok(closeButton)
  assert.equal(String(closeButton.props['aria-label']), 'close')
  assert.equal(closeButton.props['autoFocus'], true, 'the dialog should take focus on open')

  // All three close paths: mask click, Escape on the panel, and the close button.
  const escape = { key: 'Escape', preventDefault: () => undefined, stopPropagation: () => undefined }
  const panelProps = panel.props as { onKeyDown?: (event: typeof escape) => void }
  panelProps.onKeyDown?.(escape)
  assert.equal(closed, 1, 'Escape should close the dialog')
  ;(mask.props as { onClick?: () => void }).onClick?.()
  assert.equal(closed, 2, 'a mask click should close the dialog')
  ;(closeButton.props as { onClick?: () => void }).onClick?.()
  assert.equal(closed, 3, 'the close button should close the dialog')

  // Two option controls (language + default model), each a switcher-style
  // trigger button announcing its popup card.
  const triggers = [] as Array<{ props: Record<string, unknown> }>
  walk(dialog, (element) => {
    if (String(element.props['className']).split(/\s+/).includes('dsh-gca-dialog-select')) {
      triggers.push(element as never)
    }
  })
  assert.equal(triggers.length, 2, 'language and default-model controls should both render')
  assert.equal(String(triggers[0]?.props['aria-haspopup']), 'listbox')
  assert.equal(String(triggers[0]?.props['aria-expanded']), 'false')
  assert.equal(String(triggers[1]?.props['aria-label']), 'defaultModel')
  // The model trigger shows the friendly display name once the catalog loaded.
  assert.ok(findByClassName(dialog as never, 'dsh-gca-dialog-modelRoute'), 'the model route should decorate the trigger label')
  // The wrapper draws the switcher chevron (decorative) beside each trigger.
  const chevrons: Array<{ type: string }> = []
  walk(dialog, (element) => {
    if (String(element.props['className']).split(/\s+/).includes('dsh-gca-chevron')) chevrons.push(element as never)
  })
  assert.equal(chevrons.length, 2, 'each option control should carry a chevron')
  assert.equal(chevrons[0]?.type, 'svg')
  const buttons: Array<{ props: { onClick?: () => void; className?: string } }> = []
  walk(dialog, (element) => {
    if (element.type === 'button') buttons.push(element as never)
  })
  const secondary = buttons.find((b) => b.props.className === 'dsh-gca-secondary')
  assert.ok(secondary, 'the dismiss button should carry the secondary style')
  const save = buttons.find((b) => b.props.className === 'dsh-gca-primary')
  assert.ok(save)
  await (save.props.onClick as () => Promise<void>)()
  // One atomic mutation carries both preferences; the chosen model is stored
  // as the volatile `defaultModel` object.
  assert.deepEqual(calls, [
    { op: 'set', path: ['promptLanguage'], value: 'zh' },
    { op: 'set', path: ['defaultModel'], value: { provider: 'deepseek', model: 'deepseek-chat' } },
  ])

  // Choosing "no default model" stores an unset instead of a route: the field
  // must be clearable back to the host default.
  const clearCalls: Array<Record<string, unknown>> = []
  const clearForms = {
    getSnapshot() {
      return { status: 'ready', value: { promptLanguage: 'en' } }
    },
    async mutate(ops: Array<Record<string, unknown>>) {
      clearCalls.push(...ops)
      return true
    },
  }
  const clearDialog = Dialog({
    ctx: { ...harness.ctx, get: (name: string) => (name === 'configForms' ? { get: () => clearForms } : undefined) },
    t, initialValue: 'zh', initialModel: null, catalog, onClose: () => undefined,
  })
  const clearButtons: Array<{ props: { onClick?: () => void; className?: string } }> = []
  walk(clearDialog, (element) => {
    if (element.type === 'button') clearButtons.push(element as never)
  })
  const clearPrimary = clearButtons.find((b) => b.props.className === 'dsh-gca-primary')
  assert.ok(clearPrimary)
  await (clearPrimary.props.onClick as () => Promise<void>)()
  assert.deepEqual(clearCalls, [
    { op: 'set', path: ['promptLanguage'], value: 'zh' },
    { op: 'unset', path: ['defaultModel'] },
  ])
})

test('the dialog falls back to individual set/unset writes when the form has no mutate', async () => {
  const { exports } = await loadBundle()
  const calls: Array<{ field: string; value: unknown }> = []
  const forms = {
    getSnapshot() {
      return { status: 'ready', value: { promptLanguage: 'en' } }
    },
    async set(field: string, value: unknown) {
      calls.push({ field, value })
      return true
    },
    async unset(field: string) {
      calls.push({ field, value: undefined })
      return true
    },
  }
  const harness = fakeCtx({ configForms: { get: () => forms } })
  const Dialog = (exports['__test'] as Record<string, unknown>)['ConfigureDialog'] as (
    props: Record<string, unknown>,
  ) => unknown
  const t = (key: string): string => key
  const dialog = Dialog({
    ctx: harness.ctx, t, initialValue: 'en', initialModel: null, catalog: null, onClose: () => undefined,
  })
  const save = findByClassName(dialog as never, 'dsh-gca-primary')
  assert.ok(save)
  await (save.props.onClick as () => Promise<void>)()
  assert.deepEqual(calls, [
    { field: 'promptLanguage', value: 'en' },
    { field: 'defaultModel', value: undefined },
  ])
})

test('the popup option card lists every language, marks the draft, picks on click, dismisses on Escape', async () => {
  const { exports } = await loadBundle()
  const Box = (exports['__test'] as Record<string, unknown>)['LanguageOptionsBox'] as (
    props: Record<string, unknown>,
  ) => unknown
  const t = (key: string) => key
  const picked: string[] = []
  let dismissed = 0
  const box = Box({ t, draft: 'en', onSelect: (id: string) => { picked.push(id) }, onDismiss: () => { dismissed += 1 } })

  // The card is a listbox over the editable values; each row is an option.
  const listbox = findByClassName(box as never, 'dsh-gca-dialog-options')
  assert.ok(listbox, 'the popup card should exist')
  assert.equal(listbox.props['role'], 'listbox')
  const rows: Array<{ props: { role?: string; 'aria-selected'?: string; onClick?: () => void } }> = []
  walk(box, (element) => {
    if (String(element.props['className']).split(/\s+/).includes('dsh-gca-dialog-option')) rows.push(element as never)
  })
  assert.deepEqual(rows.map((r) => r.props['role']), ['option', 'option', 'option'])
  // Only the current draft carries a trailing check.
  const checks: Array<{ props: { className?: string } }> = []
  walk(box, (element) => {
    if (String(element.props['className']).split(/\s+/).includes('dsh-gca-dialog-optionCheck')) checks.push(element as never)
  })
  assert.equal(checks.length, 1, 'exactly the selected row should show the check')
  assert.equal(rows[0]?.props['aria-selected'], 'false')
  assert.equal(rows[1]?.props['aria-selected'], 'true', 'the draft row is selected')
  assert.equal(rows[2]?.props['aria-selected'], 'false')

  // Clicking a row picks it; Escape on the card dismisses without bubbling.
  rows[0]?.props.onClick?.()
  assert.deepEqual(picked, ['zh'])
  const escape = { key: 'Escape', preventDefault: () => undefined, stopPropagation: () => undefined }
  const boxProps = listbox.props as { onKeyDown?: (event: typeof escape) => void }
  boxProps.onKeyDown?.(escape)
  assert.equal(dismissed, 1, 'Escape should dismiss the popup card')
})

test('the model option card lists the no-default row then every catalog model, grouped by provider', async () => {
  const { exports } = await loadBundle()
  const Box = (exports['__test'] as Record<string, unknown>)['ModelOptionsBox'] as (
    props: Record<string, unknown>,
  ) => unknown
  const t = (key: string) => key
  const picked: Array<{ provider: string; model: string } | null> = []
  let dismissed = 0
  const catalog = [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-test', name: 'Claude Test' }] },
    { id: 'empty-provider', name: 'Empty', models: [] },
  ]
  const box = Box({
    t,
    catalog,
    draft: { provider: 'anthropic', model: 'claude-test' },
    onSelect: (route: { provider: string; model: string } | null) => { picked.push(route) },
    onDismiss: () => { dismissed += 1 },
  })

  const listbox = findByClassName(box as never, 'dsh-gca-dialog-options')
  assert.ok(listbox, 'the popup card should exist')
  assert.equal(listbox.props['role'], 'listbox')
  assert.equal(String(listbox.props['aria-label']), 'defaultModel')
  const rows: Array<{ props: { role?: string; 'aria-selected'?: string; onClick?: () => void } }> = []
  const groups: Array<{ props: { children?: unknown } }> = []
  walk(box, (element) => {
    if (String(element.props['className']).split(/\s+/).includes('dsh-gca-dialog-option')) rows.push(element as never)
    if (String(element.props['className']).split(/\s+/).includes('dsh-gca-dialog-group')) groups.push(element as never)
  })
  // One no-default row plus one row per advertised model; empty providers are skipped.
  assert.deepEqual(rows.map((r) => r.props['role']), ['option', 'option', 'option'])
  assert.equal(groups.length, 2, 'provider group headers render only for providers with models')
  assert.equal(rows[0]?.props['aria-selected'], 'false', 'the no-default row is not selected')
  assert.equal(rows[1]?.props['aria-selected'], 'false')
  assert.equal(rows[2]?.props['aria-selected'], 'true', 'the draft route row is selected')
  // Only the selected row carries a trailing check.
  const checks: Array<{ props: { className?: string } }> = []
  walk(box, (element) => {
    if (String(element.props['className']).split(/\s+/).includes('dsh-gca-dialog-optionCheck')) checks.push(element as never)
  })
  assert.equal(checks.length, 1)

  // Clicking "no default" clears the draft; clicking a model picks its exact route.
  rows[0]?.props.onClick?.()
  assert.deepEqual(picked, [null])
  rows[1]?.props.onClick?.()
  assert.deepEqual(picked, [null, { provider: 'deepseek', model: 'deepseek-chat' }])
  const key = (exports['__test'] as Record<string, unknown>)['modelKey'] as (route: unknown) => string
  assert.equal(key({ provider: 'a', model: 'b' }), 'a\u0000b', 'the route key is opaque and collision-free')
  const escape = { key: 'Escape', preventDefault: () => undefined, stopPropagation: () => undefined }
  const boxProps = listbox.props as { onKeyDown?: (event: typeof escape) => void }
  boxProps.onKeyDown?.(escape)
  assert.equal(dismissed, 1, 'Escape should dismiss the model card')
})

test('the client reads the stored default-model route from the settings namespace', async () => {
  const { exports } = await loadBundle()
  const read = (exports['__test'] as Record<string, unknown>)['readDefaultModelValue'] as (ctx: unknown) => unknown
  const services = {
    configForms: {
      get() {
        return {
          getSnapshot() {
            return { status: 'ready', value: { defaultModel: { provider: 'anthropic', model: 'claude-test' } } }
          },
        }
      },
    },
  }
  const ctx = { get: (name: string) => services[name as keyof typeof services] }
  assert.deepEqual(read(ctx), { provider: 'anthropic', model: 'claude-test' })
  // No stored route is the valid "no default" state.
  const formsService = services.configForms as { get: () => { getSnapshot(): { status: string; value: Record<string, unknown> } } }
  formsService.get = () => ({ getSnapshot() { return { status: 'ready', value: {} } } })
  assert.equal(read(ctx), null)
  formsService.get = () => ({
    getSnapshot() { return { status: 'ready', value: { defaultModel: { provider: '' } } } },
  })
  assert.equal(read(ctx), null, 'a malformed stored route degrades to no default')
  // No forms surface at all: no default.
  assert.equal(read({ get: () => undefined }), null)
})

test('a session started with a stored default model pins it before the prompt is submitted', async () => {
  const { exports } = await loadBundle()
  const start = (exports['__test'] as Record<string, unknown>)['startPlanning'] as (
    ctx: unknown,
    target: Record<string, unknown>,
  ) => Promise<string>
  const harness = fakeCtx({
    configForms: {
      get() {
        return {
          getSnapshot() {
            return { status: 'ready', value: { defaultModel: { provider: 'anthropic', model: 'claude-test' } } }
          },
        }
      },
    },
    remote: {
      session: {
        async selectModel(request: Record<string, unknown>) {
          harness.modelSelections.push(request)
        },
      },
    },
  })
  const sessionId = await start(harness.ctx, { worktree: '/repo-wt', branch: 'main', staged: [] })
  assert.equal(harness.created.length, 1)
  assert.equal(sessionId, harness.created[0]?.['sessionId'])
  // Exactly one durable selection RPC, carrying the exact stored route.
  assert.deepEqual(harness.modelSelections, [
    { sessionId, provider: 'anthropic', model: 'claude-test' },
  ])
  assert.equal(harness.submits, 1, 'the prompt is still submitted after the model is pinned')
})

test('without a stored default model the session start makes no model RPC', async () => {
  const { exports } = await loadBundle()
  const start = (exports['__test'] as Record<string, unknown>)['startPlanning'] as (
    ctx: unknown,
    target: Record<string, unknown>,
  ) => Promise<string>
  const harness = fakeCtx({
    configForms: { get: () => ({ getSnapshot() { return { status: 'ready', value: {} } } }) },
    remote: {
      session: {
        async selectModel(request: Record<string, unknown>) {
          harness.modelSelections.push(request)
        },
      },
    },
  })
  await start(harness.ctx, { worktree: '/repo-wt', branch: 'main', staged: [] })
  assert.deepEqual(harness.modelSelections, [], 'no stored route means the host default applies')
  assert.equal(harness.submits, 1)
})

test('a failed model RPC or a missing remote never blocks starting the session', async () => {
  const { exports } = await loadBundle()
  const start = (exports['__test'] as Record<string, unknown>)['startPlanning'] as (
    ctx: unknown,
    target: Record<string, unknown>,
  ) => Promise<string>
  // The remote rejects (route vanished from the catalog): planning continues.
  const rejecting = fakeCtx({
    configForms: {
      get() {
        return {
          getSnapshot() {
            return { status: 'ready', value: { defaultModel: { provider: 'gone', model: 'model-x' } } }
          },
        }
      },
    },
    remote: {
      session: {
        async selectModel() {
          throw new Error('session/model-unavailable')
        },
      },
    },
  })
  const sessionId = await start(rejecting.ctx, { worktree: '/repo-wt', branch: 'main', staged: [] })
  assert.equal(sessionId, rejecting.created[0]?.['sessionId'])
  assert.equal(rejecting.submits, 1)
  // No remote surface at all (an embedder without the gateway): same outcome.
  const bare = fakeCtx({
    configForms: {
      get() {
        return {
          getSnapshot() {
            return { status: 'ready', value: { defaultModel: { provider: 'anthropic', model: 'claude-test' } } }
          },
        }
      },
    },
  })
  await start(bare.ctx, { worktree: '/repo-wt', branch: 'main', staged: [] })
  assert.equal(bare.submits, 1)
})

test('the catalog loader resolves instead of hanging: missing remote, throwing access and rejected RPC all degrade', async () => {
  const { exports } = await loadBundle()
  const load = (exports['__test'] as Record<string, unknown>)['loadModelCatalog'] as (
    ctx: unknown,
  ) => Promise<{ groups: unknown[]; failed: boolean }>

  // No remote surface: resolved with the unavailable marker, never null.
  const bare = fakeCtx()
  assert.deepEqual(await load(bare.ctx), { groups: [], failed: true })

  // Property access for a non-injected namespaced service throws on some
  // hosts ("cannot get property ... without inject"): the loader must catch
  // it and degrade, not reject.
  const throwing = fakeCtx({
    remote: Object.defineProperty({}, 'session', {
      get() {
        throw new Error('cannot get property "session" without inject')
      },
    }),
  })
  assert.deepEqual(await load(throwing.ctx), { groups: [], failed: true })

  // The RPC rejects: same degrade.
  const rejecting = fakeCtx({
    remote: {
      session: {
        async modelCatalog() {
          throw new Error('catalog lookup failed')
        },
      },
    },
  })
  assert.deepEqual(await load(rejecting.ctx), { groups: [], failed: true })

  // A live catalog surfaces the provider groups.
  const live = fakeCtx({
    remote: {
      session: {
        async modelCatalog() {
          return { groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }] }
        },
      },
    },
  })
  const loaded = await load(live.ctx)
  assert.equal(loaded.failed, false)
  assert.equal(loaded.groups.length, 1)
  assert.equal((loaded.groups[0] as { id: string }).id, 'deepseek')

  // The typert RemoteResult envelope (`{ ok, value }`) is unwrapped: host
  // RPCs answer in this shape on the client, so the raw catalog lives under
  // `value`.
  const enveloped = fakeCtx({
    remote: {
      session: {
        async modelCatalog() {
          return {
            ok: true,
            value: {
              groups: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-test', name: 'Claude Test' }] }],
            },
          }
        },
      },
    },
  })
  const unwrapped = await load(enveloped.ctx)
  assert.equal(unwrapped.failed, false)
  assert.equal((unwrapped.groups[0] as { id: string }).id, 'anthropic')

  // The namespaced service is also reachable through the global service store
  // (`ctx.get('remote.session')`) without any inject declaration — the access
  // a hand-written bundle relies on when `ctx.remote.session` would throw
  // "cannot get property ... without inject".
  const viaStore = {
    get(name: string) {
      if (name !== 'remote.session') return undefined
      return {
        async modelCatalog() {
          return { ok: true, value: { groups: [] } }
        },
      }
    },
  }
  const stored = await load(viaStore)
  assert.deepEqual(stored, { groups: [], failed: true })
})


test('plan sidebar uses durable revision kind, dedupes registrations and opens scoped', async () => {
  const { exports } = await loadBundle()
  const hooks = exports['__test'] as any
  const descriptors: any[] = [], opened: any[] = []
  const ctx = { betterSidebar: {
    registerTab(d: any) { descriptors.push(d); return () => undefined },
    openTab(seed: any, scope: any) { opened.push({ seed, scope }) },
  } }
  const plans = hooks.createPlanSidebar(ctx)
  const session = 'session-git-commit-history'
  const meta = { taskId: 'task', planId: 'plan', revision: 1, planDigest: 'digest', preview: [] }
  assert.equal(plans.open(meta, session), true)
  plans.open(meta, session)
  plans.open({ ...meta, revision: 2 }, session)
  assert.equal(descriptors.length, 2)
  assert.equal(descriptors[0].createTab, undefined)
  assert.notEqual(descriptors[0].id, descriptors[1].id)
  assert.deepEqual(JSON.parse(decodeURIComponent(descriptors[0].id.slice('dsh-gca-plan-'.length))),
    [session, 'task', 'plan', 1, 'digest'])
  assert.equal(opened[0].scope.sessionId, session)
  assert.equal(opened[0].seed.meta, undefined)
  assert.equal(plans.open(meta, 'ordinary-session'), true)
})

test('full plan renders entire message, rationale, dependencies, exclusions and digest', async () => {
  const { exports } = await loadBundle()
  const hooks = exports['__test'] as any
  const node = hooks.FullPlan({ sessionId: 'session-git-commit-history', ctx: {}, meta: {
    taskId: 'task', planId: 'plan', revision: 3, planDigest: 'full-digest',
    commits: [{ id: 'c1', message: 'subject\n\ncomplete body', rationale: 'group reason', dependsOn: ['c0'] }],
    preview: [{ commitId: 'c1', patch: 'diff', stat: { files: 1, additions: 2, deletions: 3 },
      changes: [{ path: 'new.ts', oldPath: 'old.ts', status: 'renamed', layer: 'index' }] }],
    blockers: [{ code: 'blocked', message: 'reason' }], warnings: ['warning'],
    excludedChanges: [{ path: 'excluded.ts', reason: 'keep out' }],
  } })
  const text = JSON.stringify(node)
  for (const value of ['complete body', 'group reason', 'c0', 'full-digest', 'excluded.ts', 'keep out', 'old.ts', 'blocked']) {
    assert.ok(text.includes(value), value)
  }
})

test('live plan observer never reveals baseline/replay/switch and disposes polling', async () => {
  const { exports } = await loadBundle()
  const hooks = exports['__test'] as any
  let current = 'session-git-commit-a', listener: () => void = () => undefined
  let pending: (() => Promise<void>) | undefined, responsePlans: any[] = []
  const opened: any[] = [], registered: any[] = []
  const mk = (revision: number) => ({ taskId: 't', planId: 'p', revision, planDigest: 'd' + revision, preview: [] })
  responsePlans = [mk(1)]
  const stop = hooks.observePlans({ sidebarRight: { mounted: {
    getSnapshot: () => current, subscribe(fn: () => void) { listener = fn; return () => { listener = () => undefined } },
  } } }, { register(m: any) { registered.push(m) }, open(m: any, session: string) { opened.push({ m, session }) } }, {
    fetch: async () => ({ ok: true, json: async () => ({ sessionId: current, plans: responsePlans }) }),
    setTimeout(fn: () => Promise<void>) { pending = fn; return 1 }, clearTimeout() { pending = undefined },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(opened.length, 0)
  responsePlans = [mk(1), mk(2)]
  await pending!()
  assert.equal(opened.length, 1)
  assert.equal(opened[0].m.revision, 2)
  await pending!()
  assert.equal(opened.length, 1)
  current = 'session-git-commit-b'; listener()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(opened.length, 1)
  current = 'session-git-commit-a'; listener()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(opened.length, 1)
  assert.ok(registered.length >= 2)
  stop()
  assert.equal(pending, undefined)
})


test('inspectors register stable kinds and open source snapshots without a mounted session', async () => {
  const { exports } = await loadBundle()
  const hooks = exports['__test'] as any
  const descriptors: any[] = [], opened: any[] = []
  let disposed = 0
  const plans = hooks.createPlanSidebar({ betterSidebar: {
    features: ['inspectors'],
    registerInspector(d: any) { descriptors.push(d); return () => { disposed++ } },
    openInspector(seed: any) { opened.push(seed); return true },
  } })
  assert.deepEqual(descriptors.map(d => d.id), ['dsh-gca-plan', 'dsh-gca-plans'])
  assert.equal(descriptors[1].entry, true)
  const meta = { taskId: 't', planId: 'p', revision: 1, planDigest: 'd', commits: [], preview: [] }
  const location = { section: 'commit', commitId: 'c1', view: 'details' }
  assert.equal(plans.open(meta, 'source-session', location), true)
  assert.deepEqual(opened[0].resource, { sourceSessionId: 'source-session', taskId: 't', planId: 'p', revision: 1, digest: 'd' })
  assert.deepEqual(opened[0].location, location)
  plans.open(meta, 'source-session', { ...location, view: 'diff' })
  assert.equal(opened[0].id, opened[1].id)
  assert.equal(descriptors.length, 2, 'one descriptor per stable inspector type, not per revision')
  const cold = descriptors[0].component({ resource: { ...opened[0].resource, revision: 9, digest: 'cold' }, location })
  assert.ok(JSON.stringify(cold).includes('正在恢复历史计划'), 'cold resources do not need current session props')
  plans.dispose()
  assert.equal(disposed, 2)
})

test('Inspector mode does not poll historical patches or auto-reveal background plans', async () => {
  const { exports } = await loadBundle()
  const hooks = exports['__test'] as any
  let called = false
  const stop = hooks.observePlans({}, { automaticReveal: false }, { fetch() { called = true } })
  assert.equal(called, false)
  stop()
})

test('plan detail and diff buttons forward exact commit location', async () => {
  const { exports } = await loadBundle()
  const hooks = exports['__test'] as any
  const opened: any[] = []
  const meta = { taskId: 't', planId: 'p', revision: 2, planDigest: 'd', commits: [],
    preview: [{ commitId: 'c', message: 'subject', patch: 'stored diff', changes: [] }] }
  const node = hooks.PlanCard({ block: { meta }, sessionId: 'source',
    openPlan(m: any, session: string, location: any) { opened.push({ m, session, location }); return true } })
  walk(node, e => {
    if (e.type === 'button' && ['明细', '查看差异'].includes(e.props.children as string)) (e.props.onClick as () => void)()
  })
  assert.deepEqual(opened.map(o => o.location), [
    { section: 'commit', commitId: 'c', view: 'details' }, { section: 'commit', commitId: 'c', view: 'diff' },
  ])
  assert.ok(opened.every(o => o.m === meta && o.session === 'source'))
  const full = hooks.FullPlan({ meta, sessionId: 'source', location: opened[1].location })
  assert.ok(JSON.stringify(full).includes('stored diff'))
  assert.ok(JSON.stringify(full).includes('返回明细'))
})

test('unavailable cold snapshots show an error rather than an endless loading message', async () => {
  const { registration } = await loadBundle()
  const react = fakeReact()
  const original = react['useState'] as (value: unknown) => unknown
  let first = true
  react['useState'] = (value: unknown) => {
    if (first) { first = false; return [{ meta: null, error: 'HTTP 404' }, () => undefined] }
    return original(value)
  }
  const hooks = registration.factory(() => react)['__test'] as any
  const node = hooks.PlanPage({ identity: ['source', 't', 'p', 1, 'd'], ctx: {} })
  const text = JSON.stringify(node)
  assert.ok(text.includes('历史计划暂不可用'))
  assert.ok(text.includes('不会从当前工作树重新生成'))
  assert.equal(text.includes('正在恢复历史计划'), false)
})

test('cold Inspector fetches the source snapshot without any display session', async () => {
  const { registration } = await loadBundle()
  const requests: string[] = []
  const react = fakeReact()
  react['useEffect'] = (fn: () => unknown) => { fn() }
  const hooks = registration.factory(() => react)['__test'] as any
  const descriptors: any[] = []
  const oldFetch = globalThis.fetch
  const meta = { taskId: 't', planId: 'p', revision: 4, planDigest: 'saved', commits: [], preview: [] }
  globalThis.fetch = (async (url: string) => { requests.push(url); return { ok: true, json: async () => meta } }) as any
  try {
    const plans = hooks.createPlanSidebar({ betterSidebar: {
      features: ['inspectors'], registerInspector(d: any) { descriptors.push(d); return () => undefined },
      openInspector() { return true },
    } })
    descriptors[0].component({ resource: { sourceSessionId: 'source-only', taskId: 't', planId: 'p', revision: 4, digest: 'saved' },
      location: { section: 'commit', commitId: 'c', view: 'diff' } })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(requests.length, 1)
    const q = new URL(requests[0]!, 'http://local').searchParams
    assert.deepEqual(Object.fromEntries(q), { sessionId: 'source-only', taskId: 't', planId: 'p', revision: '4', digest: 'saved' })
    descriptors[1].component({ resource: {}, visible: true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(new URL(requests[1]!, 'http://local').pathname, '/git-commit-agent/api/plan-index')
    assert.equal(new URL(requests[1]!, 'http://local').searchParams.has('sessionId'), false)
    plans.dispose()
  } finally { globalThis.fetch = oldFetch }
})

async function paletteHarness() {
  const { exports } = await loadBundle()
  let activeLocale = 'zh-CN'
  const localeListeners = new Set<() => void>()
  const harness = fakeCtx({
    workspaces: [{ workspaceId: 'ws', path: '/repo' }],
    locale: {
      getSnapshot: () => ({ active: activeLocale }),
      subscribe(listener: () => void) {
        localeListeners.add(listener)
        return () => { localeListeners.delete(listener) }
      },
    },
  })
  let current = 'source'
  let items = [{ workspaceId: 'ws', path: '/repo', sessionIds: ['source'] }]
  let command: any
  const commands: any[] = []
  const listeners = new Set<() => void>()
  const cleanups: Array<() => void> = []
  let removed = 0
  let refreshes = 0
  const store = (getSnapshot: () => unknown) => ({
    getSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  const get = harness.ctx['get'] as (name: string) => any
  const sessions = get('sessions')
  sessions.list = store(() => ({ byId: { current: { id: current, retainedBy: { mainView: 1 } } } }))
  get('workspaces').list = store(() => ({ items }))
  const palette = {
    registerCommand(value: any) { commands.push(value); command ??= value; return () => { removed += 1 } },
    getSnapshot() { return { mode: 'commands' } },
    refresh() { refreshes += 1 },
  }
  let activate: (() => void) | undefined
  harness.ctx['inject'] = (names: string[], callback: (ctx: unknown) => void) => {
    assert.deepEqual(names, ['commandPalette'])
    activate = () => callback({
      get: (name: string) => name === 'commandPalette' ? palette : get(name),
      effect: (factory: () => () => void) => { cleanups.push(factory()) },
    })
  }
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  assert.equal(command, undefined, 'optional contribution waits for palette service')
  activate!()
  return {
    harness, command: command as any, inputCommand: commands[1], listeners, localeListeners,
    setLocale(value: string) { activeLocale = value; localeListeners.forEach(fn => fn()) },
    change(id: string) { current = id; listeners.forEach(fn => fn()) },
    remove() { items = [] },
    cleanup() { cleanups.forEach(fn => fn()) },
    get removed() { return removed }, get refreshes() { return refreshes },
  }
}

test('palette registers optional current-workspace action and owns cleanup/refresh', async () => {
  const p = await paletteHarness()
  assert.equal(p.command.id, 'dsh-git-commit-agent.start-current-workspace')
  assert.equal(p.command.target.kind, 'action')
  assert.equal(p.command.describe().disabledReason, undefined)
  p.change('ungrouped')
  assert.ok(p.command.describe().disabledReason)
  assert.equal(p.refreshes, 1) // shared listener refreshes command availability
  p.cleanup(); p.cleanup()
  assert.equal(p.removed, 2)
  assert.equal(p.listeners.size, 0)
})

test('palette exposes bilingual plugin tag, titles and semantic action icon dynamically', async () => {
  const p = await paletteHarness()
  const zh = p.command.describe()
  assert.equal(zh.title, '在当前工作区启动 Commit Agent')
  assert.deepEqual(zh.localizedTitles, {
    zh: '在当前工作区启动 Commit Agent', en: 'Start Commit Agent in Current Workspace',
  })
  assert.deepEqual(zh.pluginTag, {
    id: 'dsh-git-commit-agent', title: 'Git Commit Agent',
    localizedTitles: { zh: 'Git 提交助手', en: 'Git Commit Agent' }, iconId: 'git',
  })
  assert.equal(zh.iconId, undefined)
  assert.equal(zh.icon, '🤖', 'the start command uses a robot icon')
  for (const locale of ['en', 'en-US', 'en_US']) {
    p.setLocale(locale)
    const en = p.command.describe()
    assert.equal(en.title, zh.localizedTitles.en)
    assert.equal(en.pluginTag, zh.pluginTag, 'stable shared plugin identity')
    assert.equal(en.localizedTitles, zh.localizedTitles)
  }
  assert.equal(p.refreshes, 3)
  p.change('ungrouped')
  assert.equal(p.command.describe().disabledReason, 'The current session has no registered workspace')
  p.setLocale('zh_CN')
  assert.equal(p.command.describe().title, zh.localizedTitles.zh)
  assert.equal(p.command.describe().disabledReason, '当前会话没有所属的已注册工作区')
  p.cleanup(); p.cleanup()
  assert.equal(p.localeListeners.size, 0)
  const refreshes = p.refreshes
  p.setLocale('en')
  assert.equal(p.refreshes, refreshes, 'locale subscription is released with contribution')
})

test('palette starts dedicated workspace session and rechecks missing/aborted targets', async () => {
  const p = await paletteHarness()
  const controller = new AbortController()
  const result = await p.command.target.execute({ context: {}, signal: controller.signal })
  assert.equal(result.kind, 'completed')
  assertCommitSession(p.harness, { workspaceId: 'ws' })
  assert.equal(p.harness.submits, 1)
  p.remove()
  assert.equal((await p.command.target.execute({ signal: controller.signal })).kind, 'failed')
  controller.abort()
  assert.equal((await p.command.target.execute({ signal: controller.signal })).kind, 'cancelled')
  assert.equal(p.harness.created.length, 1)
  p.cleanup()
})

test('palette fills the active composer with a tool-agnostic prompt without creating or sending', async () => {
  const p = await paletteHarness()
  const get = p.harness.ctx['get'] as (name: string) => any
  let focused = 0
  let scoped = ''
  const resolve = get('conversation').input.for
  get('conversation').input.for = (scope: any) => {
    scoped = scope.sessionId
    return { ...resolve(scope), focus() { focused += 1 } }
  }
  get('sessions').create = undefined // this mode does not require session creation
  assert.equal(p.inputCommand.id, 'dsh-git-commit-agent.fill-current-session')
  assert.equal(p.inputCommand.describe().disabledReason, undefined)
  assert.equal(p.inputCommand.describe().title, '将提交规划 prompt 填入当前会话')
  const signal = new AbortController().signal
  assert.equal((await p.inputCommand.target.execute({ signal })).kind, 'completed')
  assert.equal(scoped, 'source')
  assert.equal(focused, 1)
  assert.equal(p.harness.created.length, 0)
  assert.equal(p.harness.opened.length, 0)
  assert.equal(p.harness.modelSelections.length, 0)
  assert.equal(p.harness.submits, 0)
  assert.match(p.harness.drafts[0]!, /worktree: \/repo/)
  assert.match(p.harness.drafts[0]!, /当前会话已有的工具/)
  assert.match(p.harness.drafts[0]!, /等待我明确批准/)
  assert.doesNotMatch(p.harness.drafts[0]!, /commit_agent_|changeId|审批面板/)
  p.setLocale('en')
  assert.equal(p.inputCommand.describe().title, 'Fill Commit Planning Prompt in Current Session')
  await p.inputCommand.target.execute({ signal })
  assert.match(p.harness.drafts[1]!, /tools already available/)
  assert.match(p.harness.drafts[1]!, /wait for my explicit approval/)
  p.cleanup()
})

test('palette input mode refuses unavailable, occupied and cancelled composers', async () => {
  const p = await paletteHarness()
  const get = p.harness.ctx['get'] as (name: string) => any
  const resolver = get('conversation').input
  const resolve = resolver.for
  const signal = new AbortController().signal
  for (const state of [
    { draft: 'keep me', phase: 'plain' },
    { draft: '', attachmentIds: ['attachment'], phase: 'plain' },
    { draft: '', occurrences: [{}], phase: 'plain' },
    { draft: '', phase: 'submitting' },
  ]) {
    resolver.for = (scope: any) => ({ ...resolve(scope), state: { getSnapshot: () => state } })
    assert.equal((await p.inputCommand.target.execute({ signal })).kind, 'failed')
  }
  resolver.for = () => undefined
  assert.ok(p.inputCommand.describe().disabledReason)
  assert.equal((await p.inputCommand.target.execute({ signal })).kind, 'failed')
  resolver.for = resolve
  p.change('ungrouped')
  assert.ok(p.inputCommand.describe().disabledReason)
  assert.equal((await p.inputCommand.target.execute({ signal })).kind, 'failed')
  const controller = new AbortController()
  controller.abort()
  assert.equal((await p.inputCommand.target.execute({ signal: controller.signal })).kind, 'cancelled')
  assert.equal(p.harness.drafts.length, 0)
  p.cleanup()
})

test('palette cancellation after session creation does not submit or claim rollback', async () => {
  const p = await paletteHarness()
  const controller = new AbortController()
  const get = p.harness.ctx['get'] as (name: string) => any
  const sessions = get('sessions')
  const create = sessions.create
  sessions.create = async (input: unknown) => { const id = await create(input); controller.abort(); return id }
  assert.equal((await p.command.target.execute({ signal: controller.signal })).kind, 'cancelled')
  assert.equal(p.harness.created.length, 1)
  assert.equal(p.harness.submits, 0)
  assert.equal(p.harness.opened.length, 0)
  p.cleanup()
})

test('palette rechecks workspace after async model selection before navigation/submission', async () => {
  const p = await paletteHarness()
  const get = p.harness.ctx['get'] as (name: string) => any
  const sessions = get('sessions')
  const create = sessions.create
  sessions.create = async (input: unknown) => { const id = await create(input); p.remove(); return id }
  const result = await p.command.target.execute({ signal: new AbortController().signal })
  assert.equal(result.kind, 'failed')
  assert.equal(p.harness.created.length, 1)
  assert.equal(p.harness.submits, 0)
  assert.equal(p.harness.opened.length, 0)
  p.cleanup()
})

test('palette never falls back to ungrouped cwd after workspace create failure', async () => {
  const p = await paletteHarness()
  const get = p.harness.ctx['get'] as (name: string) => any
  let attempts = 0
  get('sessions').create = async () => { attempts += 1; throw new Error('workspace/not-found') }
  const result = await p.command.target.execute({ signal: new AbortController().signal })
  assert.equal(result.kind, 'failed')
  assert.equal(attempts, 1)
  p.cleanup()
})

test('cold plan descriptors recover using exact route even without native params or meta', async () => {
  const { registration } = await loadBundle()
  const requests: string[] = []
  const react = fakeReact()
  react['useEffect'] = (fn: () => unknown) => { fn() }
  const hooks = registration.factory(() => react)['__test'] as any
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => { requests.push(url); return { ok: true, json: async () => meta } }) as any
  const meta = { taskId: 't', planId: 'p', revision: 7, planDigest: 'exact-digest', commits: [], preview: [] }
  const descriptors: any[] = []
  try {
    const sidebar = hooks.createPlanSidebar({ betterSidebar: { registerTab(d: any) { descriptors.push(d); return () => undefined } } })
    sidebar.register(meta, 'session-git-commit-cold')
    // A fresh native synthetic record carries only kind/id/title after refresh.
    descriptors[0].component({ scope: { sessionId: 'session-git-commit-cold' }, tab: { id: 'native-new-id', type: descriptors[0].id } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(requests.length, 1)
    const query = new URL(requests[0]!, 'http://local').searchParams
    assert.equal(query.get('sessionId'), 'session-git-commit-cold')
    assert.equal(query.get('revision'), '7')
    assert.equal(query.get('digest'), 'exact-digest')
  } finally { globalThis.fetch = oldFetch }
})
