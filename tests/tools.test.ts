/**
 * Host-surface tests: tool definition shape, scope restriction, and the
 * end-to-end path from a tool call through the service to a real commit.
 *
 * The host services are faked structurally (the plugin deliberately has no
 * compile-time dependency on them), which is exactly how the host injects them.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommitAgentService } from '../src/core/service.js'
import {
  buildCommitAgentTools,
  COMMIT_AGENT_TOOL_NAMES,
  registerCommitAgentTools,
  restrictCommitAgentScope,
} from '../src/host/tools.js'
import type { HostPluginContext, HostToolDefinition, HostToolRunContext } from '../src/host/types.js'
import { createInitialisedFixture, type Fixture } from './helpers/fixture.js'
import { writeFile } from './helpers/fixture.js'

/** A fake tool execution context for one agent session. */
function execContext(sessionId = 'session-agent'): HostToolRunContext {
  const controller = new AbortController()
  return {
    agent: { id: sessionId, session: { id: sessionId } },
    signal: controller.signal,
  }
}

/** Tool by name. */
function toolNamed(tools: readonly HostToolDefinition[], name: string): HostToolDefinition {
  const tool = tools.find((t) => t.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

/** Build tools wired to a service for one fixture. */
function toolsFor(fixture: Fixture): { service: CommitAgentService; tools: HostToolDefinition[] } {
  const service = new CommitAgentService({ dataDir: fixture.dataDir })
  const tools = buildCommitAgentTools({
    service,
    resolveWorkspace: async () => fixture.root,
  })
  return { service, tools }
}

test('every declared tool is registered with a well-formed definition', () => {
  const tools = buildCommitAgentTools({ service: new CommitAgentService({ dataDir: '/tmp/unused' }), resolveWorkspace: async () => null })
  assert.deepEqual(
    tools.map((t) => t.name),
    [...COMMIT_AGENT_TOOL_NAMES],
  )
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`)
    assert.equal((tool.parameters as { type?: string }).type, 'object', `${tool.name} parameters must be an object schema`)
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('no tool exposes a general-purpose escape hatch', () => {
  const tools = buildCommitAgentTools({ service: new CommitAgentService({ dataDir: '/tmp/unused' }), resolveWorkspace: async () => null })
  for (const tool of tools) {
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    for (const forbidden of ['command', 'args', 'argv', 'cwd', 'shell', 'path', 'content', 'patch', 'url']) {
      assert.equal(forbidden in properties, false, `${tool.name} must not accept "${forbidden}"`)
    }
  }
})

test('registerCommitAgentTools registers all tools and disposes them in reverse', () => {
  const registered: string[] = []
  const disposed: string[] = []
  const ctx = {
    tools: {
      register(definition: HostToolDefinition) {
        registered.push(definition.name)
        return () => disposed.push(definition.name)
      },
      restrict: () => () => undefined,
      guard: () => () => undefined,
    },
  } as unknown as HostPluginContext
  const dispose = registerCommitAgentTools(ctx, { service: new CommitAgentService({ dataDir: '/tmp/unused' }), resolveWorkspace: async () => null })
  assert.deepEqual(registered, [...COMMIT_AGENT_TOOL_NAMES])
  dispose()
  assert.deepEqual(disposed, [...COMMIT_AGENT_TOOL_NAMES].reverse())
})

test('the scope restriction allows only commit-agent tools and fails closed', () => {
  const restrictions: Array<{ allow?: readonly string[]; deny?: readonly string[] }> = []
  let guard: ((execution: unknown) => string | undefined) | null = null
  const agentCtx = {
    tools: {
      register: () => () => undefined,
      restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }) {
        restrictions.push(filter)
        return () => undefined
      },
      guard(fn: (execution: unknown) => string | undefined) {
        guard = fn
        return () => undefined
      },
    },
  }
  restrictCommitAgentScope(agentCtx)
  assert.deepEqual(restrictions[0]?.allow, [...COMMIT_AGENT_TOOL_NAMES])
  assert.ok(guard !== null)
  const check = guard as unknown as (execution: unknown) => string | undefined
  assert.equal(check({ toolName: 'commit_agent_status' }), undefined)
  assert.equal(typeof check({ toolName: 'run_code' }), 'string')
  // Fail closed when the execution record shape is unknown.
  assert.equal(typeof check({}), 'string')
  assert.equal(typeof check(null), 'string')
})

test('commit_agent_status reports changes for the bound task', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const { tools } = toolsFor(fixture)
    const result = (await toolNamed(tools, 'commit_agent_status').execute({}, execContext())) as Record<string, unknown>
    const changes = result['changes'] as Array<Record<string, unknown>>
    assert.equal(changes.length, 1)
    assert.equal(changes[0]?.['path'], 'a.txt')
    assert.equal(changes[0]?.['layer'], 'untracked')
    assert.equal(result['indexEmpty'], true)
    assert.equal(result['indexStrategy'], 'index-empty-whole-file')
  } finally {
    await fixture.cleanup()
  }
})

test('publish_plan then execute_plan commits through the tool surface', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/feature.ts', 'export const feature = 1\n')
    const { service, tools } = toolsFor(fixture)
    const exec = execContext()

    const status = (await toolNamed(tools, 'commit_agent_status').execute({}, exec)) as Record<string, unknown>
    const taskId = status['taskId'] as string
    const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string

    const published = (await toolNamed(tools, 'commit_agent_publish_plan').execute(
      { commits: [{ message: 'feat: add feature module', changes: [changeId] }] },
      exec,
    )) as Record<string, unknown>
    const plan = published['plan'] as Record<string, unknown>
    assert.deepEqual(plan['blockers'], [])

    // The model cannot execute before the user approves.
    await assert.rejects(() =>
      Promise.resolve(
        toolNamed(tools, 'commit_agent_execute_plan').execute(
          { planId: plan['planId'], revision: plan['revision'] },
          exec,
        ),
      ),
    )

    await service.approvePlan({
      taskId,
      planId: plan['planId'] as string,
      revision: plan['revision'] as number,
      planDigest: plan['planDigest'] as string,
      requestId: 'req-tool',
      approvedBy: 'user:test',
    })

    const executed = (await toolNamed(tools, 'commit_agent_execute_plan').execute(
      { planId: plan['planId'], revision: plan['revision'] },
      exec,
    )) as Record<string, unknown>
    assert.equal(executed['outcome'], 'completed')
    assert.equal((executed['commits'] as unknown[]).length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('a tool call from a session with no bound worktree fails with a clear error', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const tools = buildCommitAgentTools({ service, resolveWorkspace: async () => null })
    await assert.rejects(() => Promise.resolve(toolNamed(tools, 'commit_agent_status').execute({}, execContext('session-unbound'))))
  } finally {
    await fixture.cleanup()
  }
})

test('read_context excludes secret-looking files with a reason', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, '.env', 'SECRET=1\n')
    await writeFile(fixture.root, 'src/app.ts', 'export const app = 1\n')
    const { tools } = toolsFor(fixture)
    const result = (await toolNamed(tools, 'commit_agent_read_context').execute(
      { paths: ['.env', 'src/app.ts'] },
      execContext(),
    )) as { files: Array<{ path: string; content: string | null; excludedReason: string | null }> }
    const env = result.files.find((f) => f.path === '.env')
    const app = result.files.find((f) => f.path === 'src/app.ts')
    assert.equal(env?.content, null)
    assert.match(env?.excludedReason ?? '', /credential|secret|environment/i)
    assert.ok(app?.content?.includes('export const app'))
  } finally {
    await fixture.cleanup()
  }
})

test('the tool layer rejects path traversal', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const { tools } = toolsFor(fixture)
    await assert.rejects(() =>
      Promise.resolve(
        toolNamed(tools, 'commit_agent_read_context').execute({ paths: ['../../../etc/passwd'] }, execContext()),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
})
