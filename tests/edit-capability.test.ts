import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { EditCapabilityController, validateEditPath } from '../src/host/edit-capability.js'
import { buildCommitAgentTools, installCommitAgentScope } from '../src/host/tools.js'
import { CommitAgentService } from '../src/core/service.js'
import { createInitialisedFixture } from './helpers/fixture.js'

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'commit-edit-')))
  await writeFile(join(root, 'a.ts'), 'original')
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'config'), 'secret')
  await writeFile(join(root, '.env'), 'secret')
  let busy = false
  let invalidations = 0
  const controller = new EditCapabilityController({
    isWorkspaceBusy: () => busy,
    acquireWorkspaceEdit: () => { if (busy) throw new Error('busy'); busy = true; return () => { busy = false } },
    invalidatePlansAfterEdit: async () => { assert.equal(busy, true); invalidations++ },
  })
  controller.bindSession('s', 't', root)
  const detach = controller.attachPipeline('s')
  const execution = (name = 'edit', args: Record<string, unknown> = { file_path: 'a.ts' }) => ({ name, arguments: args, agent: { session: { id: 's' } } })
  return { root, controller, execution, busy: () => busy, invalidations: () => invalidations, cleanup: async () => { detach(); controller.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('exact grants, native argument shape, secrets, symlinks, and escalation fail closed', async () => {
  const f = await fixture()
  try {
    assert.match(f.controller.guard(f.execution(), 's')!, /no user-approved/)
    f.controller.prepareRequest('s', ['a.ts']).grant()
    assert.equal(f.controller.guard(f.execution(), 's'), undefined)
    assert.equal(f.controller.guard(f.execution('read'), 's'), undefined)
    for (const path of ['../a.ts', '.git/config', '.env', 'missing', 'a.ts/../.env']) {
      assert.throws(() => f.controller.prepareRequest('s', [path]))
      assert.ok(f.controller.guard(f.execution('read', { file_path: path }), 's'))
    }
    for (const field of ['sandbox_permissions', 'justification', 'escalation']) {
      assert.ok(f.controller.guard(f.execution('edit', { file_path: 'a.ts', [field]: 'danger-full-access' }), 's'))
      assert.ok(f.controller.guard(f.execution('read', { file_path: 'a.ts', [field]: 'danger-full-access' }), 's'))
    }
    assert.ok(f.controller.guard({ name: 'edit', args: { file_path: 'a.ts' } }, 's'))
    await symlink(join(f.root, 'a.ts'), join(f.root, 'alias'))
    assert.throws(() => validateEditPath(f.root, 'alias'))
    await rm(join(f.root, 'a.ts'))
    await symlink(join(f.root, '.env'), join(f.root, 'a.ts'))
    assert.ok(f.controller.guard(f.execution(), 's'))
  } finally { await f.cleanup() }
})

test('lease spans asynchronous native completion and invalidation, released on errors', async () => {
  const f = await fixture()
  try {
    f.controller.prepareRequest('s', ['a.ts']).grant()
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const work = f.controller.around(f.execution(), 's', async () => { await gate; return { isError: false } })
    assert.equal(f.busy(), true)
    assert.match(f.controller.guard(f.execution('read'), 's')!, /already in progress/)
    await assert.rejects(f.controller.around(f.execution(), 's', async () => ({})))
    finish()
    await work
    assert.equal(f.busy(), false)
    assert.equal(f.invalidations(), 1)
    await assert.rejects(f.controller.around(f.execution(), 's', async () => { throw new Error('native failure') }))
    assert.equal(f.busy(), false)
    await f.controller.around(f.execution(), 's', async () => ({ isError: true }))
    assert.equal(f.invalidations(), 3)
  } finally { await f.cleanup() }
})

test('revoke/dispose invalidate pending approvals and grants; absent pipeline denies edit', async () => {
  const f = await fixture()
  try {
    const pending = f.controller.prepareRequest('s', ['a.ts'])
    f.controller.revoke('s')
    assert.throws(() => pending.grant(), /revoked/)
    f.controller.prepareRequest('s', ['a.ts']).grant()
    f.controller.disposeSession('s')
    assert.ok(f.controller.guard(f.execution(), 's'))
    f.controller.bindSession('s', 't', f.root)
    assert.deepEqual(f.controller.status('s'), [])
    const fresh = new EditCapabilityController({ acquireWorkspaceEdit: () => () => {}, isWorkspaceBusy: () => false, invalidatePlansAfterEdit: async () => {} })
    fresh.bindSession('s', 't', f.root)
    assert.throws(() => fresh.prepareRequest('s', ['a.ts']), /pipeline/)
    assert.ok(fresh.guard(f.execution(), 's'))
    fresh.dispose()
  } finally { await f.cleanup() }
})

test('request tool requires human approval, shows exact paths/reason and revokes session grants', async () => {
  const f = await createInitialisedFixture()
  const service = new CommitAgentService({ dataDir: f.dataDir })
  const controller = new EditCapabilityController(service)
  const detach = controller.attachPipeline('s')
  let approved = false
  let asks = 0
  const tools = buildCommitAgentTools({ service, editCapabilities: controller, resolveWorkspace: async () => f.root,
    askUserApproval: async prompt => { asks++; assert.match(prompt.question, /README.md/); assert.match(prompt.question, /fix typo/); return { approved } },
  })
  const tool = tools.find(t => t.name === 'commit_agent_request_edit')!
  const exec = { agent: { id: 's', session: { id: 's' } }, signal: new AbortController().signal }
  try {
    assert.equal((await tool.execute({ paths: ['README.md'], reason: 'fix typo' }, exec) as { approved: boolean }).approved, false)
    assert.deepEqual(controller.status('s'), [])
    approved = true
    await tool.execute({ paths: ['README.md'], reason: 'fix typo' }, exec)
    assert.deepEqual(controller.status('s'), ['README.md'])
    await tool.execute({ action: 'revoke' }, exec)
    assert.deepEqual(controller.status('s'), [])
    assert.equal(asks, 2)
    await assert.rejects(tool.execute({ paths: ['../outside'], reason: 'fix typo' }, exec))
    assert.equal(asks, 2)
  } finally { detach(); controller.dispose(); await f.cleanup() }
})

test('installer keeps fixed inherited read/edit and rolls back missing native tools or registrations', () => {
  const definitions = buildCommitAgentTools({ service: new CommitAgentService({ dataDir: '/tmp/unused' }), resolveWorkspace: async () => null })
  const events: string[] = []
  const ctx = { tools: {
    restrict: (filter: { allow?: readonly string[] }) => { assert.deepEqual(filter.allow, ['read', 'edit']); events.push('restrict'); return () => { events.push('-restrict') } },
    guard: (_guard: (e: unknown) => string | undefined) => { events.push('guard'); return () => { events.push('-guard') } },
    register: () => { events.push('register'); throw new Error('register failed') },
  } }
  assert.throws(() => installCommitAgentScope(ctx, definitions), /register failed/)
  assert.deepEqual(events, ['restrict', 'guard', 'register', '-guard', '-restrict'])
  let registered = false
  assert.throws(() => installCommitAgentScope({ tools: { ...ctx.tools, restrict: () => { throw new Error('unknown global tool edit') }, register: () => { registered = true; return () => {} } } }, definitions), /unknown global tool/)
  assert.equal(registered, false)
})
