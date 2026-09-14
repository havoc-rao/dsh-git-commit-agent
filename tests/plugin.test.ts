/**
 * Plugin-entry (integration readiness) tests.
 *
 * These exercise the real package entry — `apply(ctx, config)` and the business
 * API — against a structurally faithful fake host context. They do not replace a
 * live-host mount; they prove that mounting registers the expected surface,
 * that the disposer is wired, and that the whole business API works end to end
 * through the plugin object rather than through the service directly.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, createCommitAgentPlugin, inject, name } from '../src/index.js'
import { COMMIT_AGENT_TOOL_NAMES } from '../src/host/tools.js'
import type { HostPluginContext, HostToolDefinition } from '../src/host/types.js'
import { createInitialisedFixture, git, writeFile } from './helpers/fixture.js'

/** A fake host context recording everything the plugin touches. */
function fakeHost(): {
  ctx: HostPluginContext
  /** The scope an `agent/created` payload can carry. */
  scope: { tools: unknown }
  registered: string[]
  disposed: string[]
  provided: Map<string, unknown>
  effects: number
  emit: (event: string, payload: unknown) => void
  runEffects: () => void
} {
  const registered: string[] = []
  const disposed: string[] = []
  const provided = new Map<string, unknown>()
  const effectFns: Array<() => void> = []
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const tools = {
    register(definition: HostToolDefinition) {
      registered.push(definition.name)
      return () => {
        disposed.push(definition.name)
      }
    },
    restrict: () => () => undefined,
    guard: () => () => undefined,
  }
  const ctx = {
    tools,
    logger: { info: () => undefined, warn: () => undefined },
    get: () => undefined,
    provide(key: string, value: unknown) {
      provided.set(key, value)
    },
    effect(fn: () => (() => void) | void) {
      const disposer = fn()
      if (typeof disposer === 'function') effectFns.push(disposer)
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return () => undefined
    },
  } as unknown as HostPluginContext
  return {
    ctx,
    scope: { tools },
    registered,
    disposed,
    provided,
    get effects() {
      return effectFns.length
    },
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    runEffects: () => {
      for (const fn of effectFns) fn()
    },
  }
}

test('the package entry exposes the Cordis plugin shape', () => {
  assert.equal(name, 'dsh-git-commit-agent')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('apply() installs the tools per commit session, provides the API and wires the disposer', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const host = fakeHost()
    const plugin = apply(host.ctx, { dataDir: fixture.dataDir })

    // Nothing is registered globally: an unrelated session must not see them.
    assert.deepEqual(host.registered, [])
    assert.ok(host.provided.has('gitCommitAgent'), 'the business API should be provided on the context')
    assert.equal(host.effects, 1, 'a single disposer effect should be registered')
    assert.equal(plugin.api.toolNames.length, COMMIT_AGENT_TOOL_NAMES.length)

    // The provided API is the same object the plugin returns.
    assert.equal(host.provided.get('gitCommitAgent'), plugin.api)

    // An ordinary session (any other id) installs nothing.
    host.emit('agent/created', {
      agent: { id: 'session-unrelated', session: { id: 'session-unrelated' }, ctx: host.scope },
    })
    assert.deepEqual(host.registered, [])

    // The reserved prefix is the contract for a button-created commit session.
    host.emit('agent/created', {
      agent: { id: 'session-git-commit-1', session: { id: 'session-git-commit-1' }, ctx: host.scope },
    })
    assert.deepEqual(host.registered, [...COMMIT_AGENT_TOOL_NAMES])

    // Disposal releases exactly what that scope installed.
    host.runEffects()
    assert.deepEqual(host.disposed, [...COMMIT_AGENT_TOOL_NAMES].reverse())
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('the business API drives a full approved commit without any agent registry', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const host = fakeHost()
    const plugin = apply(host.ctx, { dataDir: fixture.dataDir })
    const { api } = plugin

    await writeFile(fixture.root, 'src/thing.ts', 'export const thing = 1\n')
    await writeFile(fixture.root, 'src/thing.test.ts', 'import { thing } from "./thing.js"\nvoid thing\n')

    const opened = await api.openTask({
      sourceSessionId: 'session-source',
      agentSessionId: null,
      workspaceRoot: fixture.root,
    })
    assert.equal(opened.plans.length, 0)
    assert.equal(opened.snapshot.indexEmpty, true)

    const state = await api.getState(opened.taskId)
    assert.equal(state.snapshot.entries.length, 2)

    const byPath = new Map(state.snapshot.entries.map((e) => [e.path, e.changeId]))
    const published = await api.publishPlan(opened.taskId, {
      commits: [
        {
          message: 'feat: add thing module',
          rationale: 'the module and its test belong together',
          changes: [byPath.get('src/thing.ts') as string, byPath.get('src/thing.test.ts') as string],
        },
      ],
      excludedChanges: [],
    })
    assert.deepEqual(published.plan.blockers, [])
    assert.equal(published.plan.status, 'ready')

    // Executing before approval must fail.
    await assert.rejects(() =>
      api.executePlan({ taskId: opened.taskId, planId: published.plan.planId, revision: published.plan.revision }),
    )

    // Approval is idempotent for the same requestId + digest.
    for (let i = 0; i < 2; i += 1) {
      await api.approvePlan({
        taskId: opened.taskId,
        planId: published.plan.planId,
        revision: published.plan.revision,
        planDigest: published.plan.planDigest,
        requestId: 'req-same',
        approvedBy: 'user:test',
      })
    }

    const result = await api.executePlan({
      taskId: opened.taskId,
      planId: published.plan.planId,
      revision: published.plan.revision,
    })
    assert.equal(result.outcome, 'completed')
    assert.equal(git(fixture.root, ['log', '--format=%s', '-n1']).trim(), 'feat: add thing module')
    assert.equal(git(fixture.root, ['status', '--porcelain']).trim(), '')
  } finally {
    await fixture.cleanup()
  }
})

test('the dedicated-session API fails with a coded error when the host has no agent registry', async () => {
  const plugin = createCommitAgentPlugin({ dataDir: '/tmp/dsh-gca-nohost' })
  await assert.rejects(
    () => plugin.api.startDedicatedSession({ workspacePath: '/tmp', sourceSessionId: null }),
    (error: unknown) => (error as { code?: string }).code === 'INTERNAL',
  )
  await plugin.dispose()
})
