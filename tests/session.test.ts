/**
 * Dedicated-session tests.
 *
 * These lock in the two fixes found during the live-host mount:
 *  - the plugin must not read `ctx.agents` as a property (it throws without
 *    `inject` and aborted the whole boot);
 *  - `followup` must receive a complete `UserMessage`, not `{ text }`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, COMMIT_AGENT_PRESET_ID, createCommitAgentPlugin } from '../src/index.js'
import {
  fallbackUserMessage,
  requestInitialPlan,
  resetUserMessageFactoryCache,
  resolveUserMessageFactory,
} from '../src/host/session.js'
import type { HostAgentRegistry, HostPluginContext, HostToolDefinition } from '../src/host/types.js'
import { COMMIT_AGENT_TOOL_NAMES } from '../src/host/tools.js'
import { createInitialisedFixture } from './helpers/fixture.js'

/** A host context that throws on `ctx.agents`, exactly like Cordis without inject. */
function ctxWithThrowingAgents(lookup: (name: string) => unknown = () => undefined): HostPluginContext {
  const registered: string[] = []
  const target = {
    tools: {
      register(definition: HostToolDefinition) {
        registered.push(definition.name)
        return () => undefined
      },
      restrict: () => () => undefined,
      guard: () => () => undefined,
    },
    logger: { info: () => undefined },
    provide: () => undefined,
    effect: () => undefined,
    get(name: string) {
      return lookup(name)
    },
  }
  // Property access on `agents` is the failure mode observed on the real host.
  Object.defineProperty(target, 'agents', {
    get() {
      throw new Error('cannot get property "agents" without inject')
    },
    enumerable: true,
  })
  return target as unknown as HostPluginContext
}

test('apply() mounts even though reading ctx.agents throws', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const ctx = ctxWithThrowingAgents()
    const plugin = apply(ctx, { dataDir: fixture.dataDir })
    assert.equal(plugin.api.toolNames.length, COMMIT_AGENT_TOOL_NAMES.length)
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('agents are resolved lazily through ctx.get at call time', async () => {
  const fixture = await createInitialisedFixture()
  try {
    let created = 0
    const registry = {
      async create() {
        created += 1
        return {
          agent: {
            id: 'a',
            session: { id: 's' },
            followup: () => undefined,
            whenIdle: async () => undefined,
          },
          dispose: async () => undefined,
        }
      },
      async resume() {
        throw new Error('not used')
      },
      get: () => undefined,
    } as unknown as HostAgentRegistry

    // No registry at mount time; it appears later (sibling row ordering).
    let available: HostAgentRegistry | undefined
    const dynamicCtx = ctxWithThrowingAgents((name) => (name === 'agents' ? available : undefined))

    const plugin = apply(dynamicCtx, {
      dataDir: fixture.dataDir,
      createUserMessage: ({ text }: { text: string }) => ({ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }),
    })
    available = registry
    const started = await plugin.api.startDedicatedSession({
      workspacePath: fixture.root,
      sourceSessionId: 'session-source',
    })
    assert.equal(created, 1)
    // The reserved prefix is what makes the host install the five tools into
    // this session's scope (see `isCommitAgentSession`).
    assert.match(started.sessionId, /^session-git-commit-[0-9a-f-]{36}$/)
    assert.ok(started.prompt.includes('commit_agent_inspect'))
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('startDedicatedSession fails with INTERNAL when no agents service exists', async () => {
  const plugin = createCommitAgentPlugin({ dataDir: '/tmp/dsh-gca-noagents' })
  await assert.rejects(
    () => plugin.api.startDedicatedSession({ workspacePath: '/tmp', sourceSessionId: null }),
    (error: unknown) => (error as { code?: string }).code === 'INTERNAL',
  )
  await plugin.dispose()
})

/** A fake agent registry that returns one fixed dedicated session. */
function fakeAgents(sessionId: string): HostAgentRegistry {
  return {
    async create() {
      return {
        agent: {
          id: sessionId,
          session: { id: sessionId },
          followup: () => undefined,
          whenIdle: async () => undefined,
        },
        dispose: async () => undefined,
      }
    },
    async resume() {
      throw new Error('not used')
    },
    get: () => undefined,
  } as unknown as HostAgentRegistry
}

/** Start a dedicated session through `apply` with a recording workspace registry. */
async function withWorkspaceRegistry(
  dataDir: string,
  workspaceRoot: string,
  attach: (sessionId: string) => Promise<void>,
  resolve: (path: string) => string | undefined,
): Promise<string> {
  const ctx = ctxWithThrowingAgents((name) => {
    if (name === 'agents') return fakeAgents('session-dedicated')
    if (name === 'workspaceRegistry') {
      return {
        async resolveByPath(path: string) {
          const id = resolve(path)
          return id === undefined ? undefined : { id, path: workspaceRoot, attachSession: attach }
        },
      }
    }
    return undefined
  })
  const plugin = apply(ctx, {
    dataDir,
    createUserMessage: ({ text }: { text: string }) => ({
      id: 'm',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
  })
  try {
    const started = await plugin.api.startDedicatedSession({ workspacePath: workspaceRoot, sourceSessionId: null })
    return started.sessionId
  } finally {
    await plugin.dispose()
  }
}

test('startDedicatedSession attaches the new session to the owning workspace', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const attached: string[] = []
    const sessionId = await withWorkspaceRegistry(
      fixture.dataDir,
      fixture.root,
      async (id) => {
        attached.push(id)
      },
      (path) => (path === fixture.root ? 'ws-1' : undefined),
    )
    assert.deepEqual(attached, [sessionId], 'the session must join the workspace so the sidebar groups it')
  } finally {
    await fixture.cleanup()
  }
})

test('startDedicatedSession succeeds when the workspace cannot be resolved', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const attached: string[] = []
    const sessionId = await withWorkspaceRegistry(
      fixture.dataDir,
      fixture.root,
      async (id) => {
        attached.push(id)
      },
      () => undefined,
    )
    assert.match(sessionId, /^session-/)
    assert.deepEqual(attached, [], 'an unregistered directory stays ungrouped without failing')
  } finally {
    await fixture.cleanup()
  }
})

test('a failing workspace attach never blocks session creation', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const sessionId = await withWorkspaceRegistry(
      fixture.dataDir,
      fixture.root,
      async () => {
        throw new Error('cannot attach session: cwd mismatch')
      },
      () => 'ws-1',
    )
    assert.match(sessionId, /^session-/)
  } finally {
    await fixture.cleanup()
  }
})

test('requestInitialPlan sends a complete UserMessage', async () => {
  const captured: unknown[] = []
  let idle = false
  const handle = {
    agent: {
      id: 'a',
      session: { id: 's' },
      followup: (message: unknown) => {
        captured.push(message)
      },
      whenIdle: async () => {
        idle = true
      },
    },
    dispose: async () => undefined,
  }
  await requestInitialPlan(handle, 'plan my commits', ({ text }: { text: string }) => ({
    id: 'msg-1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  assert.equal(captured.length, 1)
  const message = captured[0] as Record<string, unknown>
  assert.equal(message['role'], 'user')
  assert.deepEqual(message['content'], [{ type: 'text', text: 'plan my commits' }])
  assert.deepEqual(message['source'], { kind: 'user' })
  assert.equal(typeof message['id'], 'string')
  assert.equal(idle, true, 'requestInitialPlan should await whenIdle')
})

test('the fallback user message carries every field the loop needs', () => {
  const message = fallbackUserMessage('hello') as Record<string, unknown>
  assert.equal(message['role'], 'user')
  assert.equal(typeof message['id'], 'string')
  assert.ok((message['id'] as string).length > 0)
  assert.deepEqual(message['content'], [{ type: 'text', text: 'hello' }])
  assert.deepEqual(message['source'], { kind: 'user' })
})

/** A fake agent registry that runs the host half of session creation. */
function recordingAgents(overrides: {
  create?: (options: { meta?: unknown; setup?: unknown }) => Promise<ReturnType<typeof fixedAgent>>
  resume?: (options: { resumeSessionId: string; setup?: unknown }) => Promise<ReturnType<typeof fixedAgent>>
}): HostAgentRegistry {
  return {
    async create(options: { meta?: unknown; setup?: unknown }) {
      return await overrides.create?.(options) ?? {
        agent: { id: '', session: { id: '' }, followup: () => undefined, whenIdle: async () => undefined },
        dispose: async () => undefined,
      }
    },
    async resume(options: { resumeSessionId: string; setup?: unknown }) {
      return await overrides.resume?.(options) ?? {
        agent: { id: '', session: { id: '' }, followup: () => undefined, whenIdle: async () => undefined },
        dispose: async () => undefined,
      }
    },
    get: () => undefined,
  } as unknown as HostAgentRegistry
}

/** A session-capable host ctx: fake agents plus an optional preset registry. */
function sessionHost(
  registry: HostAgentRegistry,
  agentPresets?: { mount: (scope: unknown, id?: string) => Promise<{ id: string }> },
  settings?: { describe: () => Array<{ ns: string; value: unknown }> },
): HostPluginContext {
  return ctxWithThrowingAgents((name) => {
    if (name === 'agents') return registry
    if (name === 'agentPresets') return agentPresets
    if (name === 'settings') return settings
    return undefined
  })
}

const fixedAgent = (id: string) => ({
  agent: { id, session: { id }, followup: (_message?: unknown) => undefined, whenIdle: async () => undefined },
  dispose: async () => undefined,
})

test('the dedicated session is bound to the git-commit preset and its header records it', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const mounts: Array<{ scope: unknown; id?: string }> = []
    const captured: Array<{ meta?: unknown; setup?: unknown }> = []
    const agentPresets = {
      async mount(scope: unknown, id?: string) {
        mounts.push({ scope, id })
        return { id: id ?? COMMIT_AGENT_PRESET_ID }
      },
    }
    const registry = recordingAgents({
      async create(options) {
        captured.push(options)
        const scope = { tools: {} }
        if (typeof options.setup === 'function') {
          await (options.setup as (agentCtx: unknown) => void | Promise<void>)(scope)
        }
        return fixedAgent('session-git-commit-1')
      },
    })
    const plugin = apply(sessionHost(registry, agentPresets), { dataDir: fixture.dataDir })
    const started = await plugin.api.startDedicatedSession({
      workspacePath: fixture.root,
      sourceSessionId: 'session-source',
    })
    assert.match(started.sessionId, /^session-git-commit-[0-9a-f-]{36}$/)
    const createOptions = captured[0]
    assert.ok(createOptions)
    // The host runs the supplied setup, which binds the agent scope to the
    // registered preset — the webhook session creator's exact pattern.
    assert.equal(typeof createOptions.setup, 'function')
    assert.equal((createOptions.meta as { agentPreset?: string }).agentPreset, COMMIT_AGENT_PRESET_ID)
    assert.equal(mounts.length, 1)
    assert.deepEqual(mounts[0], { scope: { tools: {} }, id: COMMIT_AGENT_PRESET_ID })
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('a failed preset mount never fails session creation', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const agentPresets = {
      async mount(): Promise<{ id: string }> {
        throw new Error('agent-preset/not-found')
      },
    }
    const registry = recordingAgents({
      async create(options) {
        if (typeof options.setup === 'function') {
          await (options.setup as (agentCtx: unknown) => void | Promise<void>)({ tools: {} })
        }
        return fixedAgent('session-git-commit-2')
      },
    })
    const plugin = apply(sessionHost(registry, agentPresets), { dataDir: fixture.dataDir })
    // Binding is best-effort: the tools arrive through the `agent/created`
    // listener regardless, so a mount failure leaves the session unbound but
    // alive instead of aborting the button flow.
    const started = await plugin.api.startDedicatedSession({
      workspacePath: fixture.root,
      sourceSessionId: null,
    })
    assert.match(started.sessionId, /^session-git-commit-[0-9a-f-]{36}$/)
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('resumeDedicatedSession re-binds the git-commit preset through its setup', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const mounts: Array<{ id?: string }> = []
    const agentPresets = {
      async mount(_scope: unknown, id?: string) {
        mounts.push({ id })
        return { id: id ?? COMMIT_AGENT_PRESET_ID }
      },
    }
    const registry = recordingAgents({
      async resume(options) {
        if (typeof options.setup === 'function') {
          await (options.setup as (agentCtx: unknown) => void | Promise<void>)({ tools: {} })
        }
        return fixedAgent('session-git-commit-9')
      },
    })
    const plugin = apply(sessionHost(registry, agentPresets), { dataDir: fixture.dataDir })
    const resumed = await plugin.api.resumeDedicatedSession('session-git-commit-9')
    assert.equal(resumed.sessionId, 'session-git-commit-9')
    assert.ok(mounts[0])
    assert.deepEqual(mounts[0], { id: COMMIT_AGENT_PRESET_ID })
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('without an agentPresets service the session stays unbound (no setup, no header)', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const captured: Array<{ meta?: unknown; setup?: unknown }> = []
    const registry = recordingAgents({
      async create(options) {
        captured.push(options)
        return fixedAgent('session-git-commit-3')
      },
    })
    const plugin = apply(sessionHost(registry), { dataDir: fixture.dataDir })
    const started = await plugin.api.startDedicatedSession({
      workspacePath: fixture.root,
      sourceSessionId: null,
    })
    assert.match(started.sessionId, /^session-git-commit-[0-9a-f-]{36}$/)
    const createOptions = captured[0]
    assert.ok(createOptions)
    assert.equal(createOptions.setup, undefined)
    assert.equal((createOptions.meta as { agentPreset?: string }).agentPreset, undefined)
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('the resolved factory falls back cleanly when the host package is unresolvable', async () => {
  resetUserMessageFactoryCache()
  const factory = await resolveUserMessageFactory()
  const message = factory({ text: 'from fallback' }) as Record<string, unknown>
  assert.equal(message['role'], 'user')
  assert.equal(message['source'] && (message['source'] as Record<string, unknown>)['kind'], 'user')
  assert.deepEqual(message['content'], [{ type: 'text', text: 'from fallback' }])
  resetUserMessageFactoryCache()
})

test('the stored prompt-language preference selects the language of the seeding prompt', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const texts: string[] = []
    const registry = recordingAgents({
      async create() {
        return {
          agent: {
            id: 'session-git-commit-lang',
            session: { id: 'session-git-commit-lang' },
            followup: (message: unknown) => {
              const content = (message as { content?: Array<{ text?: string }> }).content
              texts.push(content?.[0]?.text ?? String(message))
            },
            whenIdle: async () => undefined,
          },
          dispose: async () => undefined,
        }
      },
    })
    const plugin = apply(sessionHost(registry, undefined, {
      // The settings namespace is the cordis row id (`git-commit-agent`), not
      // the module name: the host settings service rejects any other key.
      describe: () => [{ ns: 'git-commit-agent', value: { promptLanguage: 'zh' } }],
    }), { dataDir: fixture.dataDir })
    const started = await plugin.api.startDedicatedSession({
      workspacePath: fixture.root,
      sourceSessionId: null,
    })
    assert.match(started.sessionId, /^session-git-commit-[0-9a-f-]{36}$/)
    assert.equal(texts.length, 1)
    assert.ok(texts[0]?.includes('请为'), 'the seeding prompt should be Chinese when zh is stored')
    assert.ok(texts[0]?.includes('commit_agent_inspect'))
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('without a stored preference the seeding prompt stays English on the host plane', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const texts: string[] = []
    const registry = recordingAgents({
      async create() {
        return {
          agent: {
            id: 'session-git-commit-default',
            session: { id: 'session-git-commit-default' },
            followup: (message: unknown) => {
              const content = (message as { content?: Array<{ text?: string }> }).content
              texts.push(content?.[0]?.text ?? String(message))
            },
            whenIdle: async () => undefined,
          },
          dispose: async () => undefined,
        }
      },
    })
    // No settings service at all: the host plane has no UI locale to follow,
    // so the default stays English (the pre-preference behavior).
    const plugin = apply(sessionHost(registry), { dataDir: fixture.dataDir })
    const started = await plugin.api.startDedicatedSession({
      workspacePath: fixture.root,
      sourceSessionId: null,
    })
    assert.match(started.sessionId, /^session-git-commit-[0-9a-f-]{36}$/)
    assert.equal(texts.length, 1)
    assert.ok(texts[0]?.includes('Plan commits'), 'the seeding prompt should default to English on the host plane')
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})

test('a settings row under the module name is ignored: only the entry id namespace counts', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const texts: string[] = []
    const registry = recordingAgents({
      async create() {
        return {
          agent: {
            id: 'session-git-commit-ns',
            session: { id: 'session-git-commit-ns' },
            followup: (message: unknown) => {
              const content = (message as { content?: Array<{ text?: string }> }).content
              texts.push(content?.[0]?.text ?? String(message))
            },
            whenIdle: async () => undefined,
          },
          dispose: async () => undefined,
        }
      },
    })
    // The host settings service addresses entries by the cordis row id
    // (`git-commit-agent`); a row described under the module name would never
    // match and the preference must not leak through.
    const plugin = apply(sessionHost(registry, undefined, {
      describe: () => [{ ns: 'dsh-git-commit-agent', value: { promptLanguage: 'zh' } }],
    }), { dataDir: fixture.dataDir })
    const started = await plugin.api.startDedicatedSession({
      workspacePath: fixture.root,
      sourceSessionId: null,
    })
    assert.match(started.sessionId, /^session-git-commit-[0-9a-f-]{36}$/)
    assert.equal(texts.length, 1)
    assert.ok(texts[0]?.includes('Plan commits'), 'a mismatched namespace must fall back to the default language')
    await plugin.dispose()
  } finally {
    await fixture.cleanup()
  }
})
