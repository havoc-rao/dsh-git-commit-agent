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
    assert.match(started.sessionId, /^session-[0-9a-f-]{36}$/)
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
