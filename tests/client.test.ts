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
} = {}): {
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
  // The transcript cards are still registered.
  assert.deepEqual(harness.toolviews.map((t) => t.key).sort(), ['commit_agent_prepare_plan', 'commit_agent_apply_plan'].sort())
})

test('an older sidebar without the feature flag is not used', async () => {
  const { exports } = await loadBundle()
  const harness = fakeCtx({ features: ['badge'] })
  await (exports['apply'] as (ctx: unknown) => Promise<void>)(harness.ctx)
  assert.equal(harness.actions.length, 0)
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
        ],
        dependsOn: [],
      },
      {
        commitId: 'c2',
        message: 'test: cover a',
        patch: 'diff --git a/b b/b\n',
        stat: { files: 1, additions: 3, deletions: 0 },
        changes: [{ changeId: 'x3', path: 'src/a.test.ts', layer: 'untracked', status: 'added' }],
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
