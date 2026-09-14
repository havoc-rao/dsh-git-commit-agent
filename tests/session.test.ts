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
import { apply, createCommitAgentPlugin } from '../src/index.js'
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
    // The reserved prefix is what makes the host install the nine tools into
    // this session's scope (see `isCommitAgentSession`).
    assert.match(started.sessionId, /^session-git-commit-[0-9a-f-]{36}$/)
    assert.ok(started.prompt.includes('commit_agent_status'))
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

test('the resolved factory falls back cleanly when the host package is unresolvable', async () => {
  resetUserMessageFactoryCache()
  const factory = await resolveUserMessageFactory()
  const message = factory({ text: 'from fallback' }) as Record<string, unknown>
  assert.equal(message['role'], 'user')
  assert.equal(message['source'] && (message['source'] as Record<string, unknown>)['kind'], 'user')
  assert.deepEqual(message['content'], [{ type: 'text', text: 'from fallback' }])
  resetUserMessageFactoryCache()
})
