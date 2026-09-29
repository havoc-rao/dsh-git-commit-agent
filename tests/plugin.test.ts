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
import {
  apply,
  COMMIT_AGENT_PRESET_ID,
  createCommitAgentPlugin,
  inject,
  name,
  PROFILE_ENTRY_ID,
} from '../src/index.js'
import { COMMIT_AGENT_TOOL_NAMES } from '../src/host/tools.js'
import type { HostPluginContext, HostPresetDefinition, HostToolDefinition } from '../src/host/types.js'
import { createInitialisedFixture, git, writeFile } from './helpers/fixture.js'

/** A fake host context recording everything the plugin touches. */
function fakeHost(services: Record<string, unknown> = {}): {
  ctx: HostPluginContext
  /** The scope an `agent/created` payload can carry. */
  scope: { tools: unknown }
  registered: string[]
  disposed: string[]
  provided: Map<string, unknown>
  effects: number
  warns: string[]
  infos: string[]
  emit: (event: string, payload: unknown) => void
  runEffects: () => void
} {
  const registered: string[] = []
  const disposed: string[] = []
  const provided = new Map<string, unknown>()
  const effectFns: Array<() => void> = []
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const warns: string[] = []
  const infos: string[] = []
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
    logger: {
      info: (message: string) => { infos.push(message) },
      warn: (message: string) => { warns.push(message) },
    },
    get: (service: string) => services[service],
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
    warns,
    infos,
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
  // The settings namespace is the cordis row id, not the module name: the
  // host settings service rejects every other key, which breaks preference
  // writes (user-visible failed save) and reads alike.
  assert.equal(PROFILE_ENTRY_ID, 'git-commit-agent')
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

test('apply() registers the git-commit agent preset through the agentPresets service', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const registrations: Array<{ definition: HostPresetDefinition }> = []
    const disposed: string[] = []
    const agentPresets = {
      async register(definition: HostPresetDefinition) {
        registrations.push({ definition })
        return async () => { disposed.push(definition.id) }
      },
    }
    const host = fakeHost({ agentPresets })
    const plugin = apply(host.ctx, { dataDir: fixture.dataDir })
    await new Promise((resolve) => setImmediate(resolve))

    // One registration, matching the standard `PresetDefinition` shape.
    assert.equal(registrations.length, 1)
    const definition = registrations[0]?.definition
    assert.ok(definition)
    assert.equal(definition.id, COMMIT_AGENT_PRESET_ID)
    assert.equal(definition.name, 'Git Commit Agent')
    assert.equal(definition.order, 30)
    // The capability set arrives from this plugin's host-plane installation,
    // never from composition rows (see `HostPresetDefinition`).
    assert.deepEqual(definition.plugins, [])

    // The disposer the registry returned is owned by the plugin's teardown.
    host.runEffects()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(disposed, [COMMIT_AGENT_PRESET_ID])
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('apply() tolerates a duplicate preset registration (HMR / second mount)', async () => {
  const fixture = await createInitialisedFixture()
  try {
    let registerCalls = 0
    const agentPresets = {
      async register(): Promise<() => Promise<void>> {
        registerCalls += 1
        // The real registry rejects a duplicate id (`index.ts:83`); a plugin
        // remounted (HMR) must survive that instead of failing its own apply.
        throw new Error('Duplicate agent preset: git-commit')
      },
    }
    const host = fakeHost({ agentPresets })
    const first = apply(host.ctx, { dataDir: fixture.dataDir })
    const second = apply(host.ctx, { dataDir: fixture.dataDir })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(registerCalls, 2)
    assert.ok(host.infos.some((line) => line.includes('already registered')))
    host.runEffects()
    await first.dispose()
    await second.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('apply() records an unexpected preset registration failure but keeps mounting', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const agentPresets = {
      async register(): Promise<() => Promise<void>> {
        throw new Error('boom')
      },
    }
    const host = fakeHost({ agentPresets })
    const plugin = apply(host.ctx, { dataDir: fixture.dataDir })
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(host.warns.some((line) => line.includes('preset registration failed: boom')))
    // The plugin itself is unaffected: API still provided, unmount clean.
    assert.ok(host.provided.has('gitCommitAgent'))
    host.runEffects()
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('Cordis injection waits for a late registry and disposes late registration on child teardown', async () => {
  const host = fakeHost()
  const injected = new Map<string, (child: HostPluginContext) => void>()
  let configureCalls = 0
  const ctx: HostPluginContext = {
    ...host.ctx,
    inject(names, callback) {
      // One dependency-owned child per required service; the settings child
      // also owns the auto-page opt-out (`configure({ auto: false })`).
      for (const serviceName of names as string[]) injected.set(serviceName, callback)
    },
  }
  const plugin = apply(ctx)
  assert.ok(injected.has('agentPresets'))
  assert.ok(injected.has('settings'))
  assert.ok(!host.infos.some(line => line.includes('registration skipped')))
  let settle: ((dispose: () => Promise<void>) => void) | undefined
  let cleanup: (() => void) | undefined
  let released = 0
  injected.get('agentPresets')?.({
    ...host.ctx,
    agentPresets: {
      register(definition) {
        assert.equal(definition.id, COMMIT_AGENT_PRESET_ID)
        return new Promise(resolve => { settle = resolve })
      },
    },
    effect(factory) { cleanup = factory() ?? undefined },
  })
  injected.get('settings')?.({
    ...host.ctx,
    settings: {
      describe: () => [],
      configure() {
        configureCalls += 1
        return () => undefined
      },
    },
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') disposer()
    },
  })
  assert.equal(configureCalls, 1, 'the settings child should opt out of the auto-generated page')
  assert.ok(cleanup)
  assert.ok(settle)
  cleanup()
  settle(async () => { released++ })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(released, 1)
  host.runEffects()
  await plugin.dispose()
})

test('apply() skips preset registration when the host has no agentPresets service', () => {
  const host = fakeHost()
  const plugin = apply(host.ctx, { dataDir: '/tmp/dsh-gca-nopresets' })
  assert.ok(host.infos.some((line) => line.includes('no agentPresets service')))
  assert.equal(host.effects, 1)
  void plugin
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
