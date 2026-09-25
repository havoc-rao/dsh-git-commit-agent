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
  COMMIT_AGENT_SESSION_PREFIX,
  COMMIT_AGENT_TOOL_NAMES,
  installCommitAgentScope,
  isCommitAgentSession,
  type UserApprovalDecision,
  type UserApprovalPrompt,
} from '../src/host/tools.js'
import type { HostToolDefinition, HostToolRunContext } from '../src/host/types.js'
import { createInitialisedFixture, git, writeFile, type Fixture } from './helpers/fixture.js'

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
function toolsFor(
  fixture: Fixture,
  askUserApproval?: (prompt: UserApprovalPrompt) => Promise<UserApprovalDecision>,
): { service: CommitAgentService; tools: HostToolDefinition[] } {
  const service = new CommitAgentService({ dataDir: fixture.dataDir })
  const tools = buildCommitAgentTools({
    service,
    resolveWorkspace: async () => fixture.root,
    ...(askUserApproval === undefined ? {} : { askUserApproval }),
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

test('installCommitAgentScope registers all tools, closes the inherited surface and fails closed', () => {
  const registered: string[] = []
  const disposed: string[] = []
  const restrictions: Array<{ allow?: readonly string[]; deny?: readonly string[] }> = []
  let guard: ((execution: unknown) => string | undefined) | null = null
  const agentCtx = {
    tools: {
      register(definition: HostToolDefinition) {
        registered.push(definition.name)
        return () => disposed.push(definition.name)
      },
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
  const definitions = buildCommitAgentTools({
    service: new CommitAgentService({ dataDir: '/tmp/unused' }),
    resolveWorkspace: async () => null,
  })
  const dispose = installCommitAgentScope(agentCtx, definitions)

  // The five are the scope's OWN registrations: they shadow a global of the
  // same name and are exempt from the restriction below.
  assert.deepEqual(registered, [...COMMIT_AGENT_TOOL_NAMES])
  // An empty `allow` is the valid "hide everything inherited" mask. Naming the
  // five here would throw once they are no longer registered globally.
  assert.deepEqual(restrictions, [{ allow: [] }])
  assert.ok(guard !== null)
  const check = guard as unknown as (execution: unknown) => string | undefined
  assert.equal(check({ toolName: 'commit_agent_inspect' }), undefined)
  assert.equal(typeof check({ toolName: 'run_code' }), 'string')
  // Fail closed when the execution record shape is unknown.
  assert.equal(typeof check({}), 'string')
  assert.equal(typeof check(null), 'string')

  dispose()
  assert.deepEqual(disposed, [...COMMIT_AGENT_TOOL_NAMES].reverse())
})

test('only the reserved session-id prefix marks a commit session', () => {
  assert.equal(COMMIT_AGENT_SESSION_PREFIX, 'session-git-commit-')
  assert.equal(isCommitAgentSession(`${COMMIT_AGENT_SESSION_PREFIX}1f2e`), true)
  assert.equal(isCommitAgentSession('session-1f2e'), false)
  assert.equal(isCommitAgentSession(''), false)
})

test('commit_agent_inspect reports changes and the index rule for the bound task', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const { tools } = toolsFor(fixture)
    const result = (await toolNamed(tools, 'commit_agent_inspect').execute({}, execContext())) as Record<string, unknown>
    const changes = result['changes'] as Array<Record<string, unknown>>
    assert.equal(result['kind'], 'status')
    assert.equal(changes.length, 1)
    assert.equal(changes[0]?.['path'], 'a.txt')
    assert.equal(changes[0]?.['layer'], 'untracked')
    assert.equal(result['indexEmpty'], true)
    assert.equal(result['indexStrategy'], 'index-empty-whole-file')
    assert.match(result['indexRule'] as string, /freely|first commit/i)
  } finally {
    await fixture.cleanup()
  }
})

test('commit_agent_inspect status exposes the staged-changes-must-enter-first-commit rule', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'staged.txt', 'staged\n')
    git(fixture.root, ['add', '--', 'staged.txt'])
    const { tools } = toolsFor(fixture)
    const result = (await toolNamed(tools, 'commit_agent_inspect').execute({}, execContext())) as Record<string, unknown>
    assert.equal(result['indexEmpty'], false)
    assert.equal(result['indexStrategy'], 'reuse-existing-index')
    assert.match(result['indexRule'] as string, /first commit/i)
    // The model-visible render must carry the same constraint so the failure
    // mode that blocked the first dotfiles plan cannot recur silently.
    const blocks = toolNamed(tools, 'commit_agent_inspect').output.render({}, result)
    const text = blocks.map((b) => b.text).join('\n')
    assert.match(text, /staged change must land in the first commit/i)
  } finally {
    await fixture.cleanup()
  }
})

test('prepare_plan then apply_plan commits through the tool surface', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'src/feature.ts', 'export const feature = 1\n')
    const { service, tools } = toolsFor(fixture, async () => ({ approved: true, selected: ['Approve'] }))
    const exec = execContext()

    const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
    const taskId = status['taskId'] as string
    const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string

    const prepared = (await toolNamed(tools, 'commit_agent_prepare_plan').execute(
      { commits: [{ message: 'feat: add feature module', changes: [changeId] }] },
      exec,
    )) as Record<string, unknown>
    const plan = prepared['plan'] as Record<string, unknown>
    assert.deepEqual(plan['blockers'], [])

    // On a host without an approval surface the model cannot apply anything:
    // the tool refuses instead of self-approving.
    const bare = toolsFor(fixture)
    await assert.rejects(
      () => Promise.resolve(
        toolNamed(bare.tools, 'commit_agent_apply_plan').execute(
          { planId: plan['planId'], revision: plan['revision'] },
          exec,
        ),
      ),
      (error: unknown) => (error as { code?: string }).code === 'BAD_ARGUMENT',
    )

    // One apply call: the human approves, the host executes.
    const applied = (await toolNamed(tools, 'commit_agent_apply_plan').execute(
      { planId: plan['planId'], revision: plan['revision'] },
      exec,
    )) as Record<string, unknown>
    assert.equal(applied['approved'], true)
    assert.equal(applied['outcome'], 'completed')
    assert.equal((applied['commits'] as unknown[]).length, 1)
    assert.equal(git(fixture.root, ['log', '--format=%s', '-n1']).trim(), 'feat: add feature module')
    const stored = await service.plansOf(taskId)
    assert.equal(stored.find((p) => p.planId === plan['planId'])?.status, 'completed')
  } finally {
    await fixture.cleanup()
  }
})

test('a tool call from a session with no bound worktree fails with a clear error', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const tools = buildCommitAgentTools({ service, resolveWorkspace: async () => null })
    await assert.rejects(() => Promise.resolve(toolNamed(tools, 'commit_agent_inspect').execute({}, execContext('session-unbound'))))
  } finally {
    await fixture.cleanup()
  }
})

test('read_files excludes secret-looking files with a reason', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, '.env', 'SECRET=1\n')
    await writeFile(fixture.root, 'src/app.ts', 'export const app = 1\n')
    const { tools } = toolsFor(fixture)
    const result = (await toolNamed(tools, 'commit_agent_read_files').execute(
      { paths: ['.env', 'src/app.ts'] },
      execContext(),
    )) as Record<string, unknown> & { files: Array<{ path: string; content: string | null; excludedReason: string | null }> }
    assert.equal(result['kind'], 'files')
    const env = result.files.find((f) => f.path === '.env')
    const app = result.files.find((f) => f.path === 'src/app.ts')
    assert.equal(env?.content, null)
    assert.match(env?.excludedReason ?? '', /credential|secret|environment/i)
    assert.ok(app?.content?.includes('export const app'))
  } finally {
    await fixture.cleanup()
  }
})

test('read_files without paths fails with a clear error', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const { tools } = toolsFor(fixture)
    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_read_files').execute({}, execContext())),
      (error: unknown) => (error as { code?: string }).code === 'BAD_ARGUMENT',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('inspect serves recent and reconcile; diff is a dedicated tool', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'a.txt', 'a\n')
    const { tools } = toolsFor(fixture)
    const exec = execContext()

    const status = (await toolNamed(tools, 'commit_agent_inspect').execute({}, exec)) as Record<string, unknown>
    const changeId = (status['changes'] as Array<Record<string, unknown>>)[0]?.['changeId'] as string

    const diff = (await toolNamed(tools, 'commit_agent_diff').execute({ changeId }, exec)) as Record<string, unknown>
    assert.equal(diff['kind'], 'diff')
    assert.match(diff['patch'] as string, /a\.txt/)

    const recent = (await toolNamed(tools, 'commit_agent_inspect').execute({ mode: 'recent' }, exec)) as Record<string, unknown>
    assert.equal(recent['kind'], 'recent')
    assert.ok((recent['commits'] as unknown[]).length >= 1, 'the fixture has an initial commit')

    const published = (await toolNamed(tools, 'commit_agent_prepare_plan').execute(
      { commits: [{ message: 'feat: add a', changes: [changeId] }] },
      exec,
    )) as Record<string, unknown>
    const plan = published['plan'] as Record<string, unknown>

    // Plan preview: commit_agent_diff renders each planned commit's diff.
    const preview = (await toolNamed(tools, 'commit_agent_diff').execute({ planId: plan['planId'] }, exec)) as Record<string, unknown>
    assert.equal(preview['kind'], 'diff')
    assert.match(preview['patch'] as string, /### c1/)

    const reconciled = (await toolNamed(tools, 'commit_agent_inspect').execute(
      { mode: 'reconcile', planId: plan['planId'], revision: plan['revision'] },
      exec,
    )) as Record<string, unknown>
    assert.equal(reconciled['kind'], 'reconcile')
    assert.deepEqual(reconciled['landed'], [], 'a not-yet-executed plan has no landed commits')

    // reconcile requires an exact revision; there is no "newest" default.
    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_inspect').execute({ mode: 'reconcile' }, exec)),
      (error: unknown) => (error as { code?: string }).code === 'BAD_ARGUMENT',
    )
    // An unknown mode is refused rather than silently approximated.
    await assert.rejects(
      () => Promise.resolve(toolNamed(tools, 'commit_agent_inspect').execute({ mode: 'run' }, exec)),
      (error: unknown) => (error as { code?: string }).code === 'BAD_ARGUMENT',
    )

    // The status render carries the published plan's digest, not a placeholder.
    const statusAfter = (await toolNamed(tools, 'commit_agent_inspect').execute({ mode: 'status' }, exec)) as Record<string, unknown>
    const statusText = toolNamed(tools, 'commit_agent_inspect').output.render({}, statusAfter).map((b) => b.text).join('\n')
    assert.match(statusText, /digest [0-9a-f]{16,}/)
    assert.ok(!statusText.includes('digest undefined'), 'the plan digest must be rendered from the status projection')
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
        toolNamed(tools, 'commit_agent_read_files').execute({ paths: ['../../../etc/passwd'] }, execContext()),
      ),
    )
  } finally {
    await fixture.cleanup()
  }
})
