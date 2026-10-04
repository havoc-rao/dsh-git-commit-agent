import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, rename, readdir, writeFile as writeRawFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { CommitAgentService } from '../src/core/service.js'
import { buildCommitAgentTools } from '../src/host/tools.js'
import { exactPlanPresentation, recentPlanIndex, mountPlanHttpRoutes, sessionPlanPresentations, type PlanHttpHost } from '../src/host/plan-http.js'
import { persistPlanPresentation, type PlanPresentation } from '../src/host/plan-presentation.js'
import type { HostPluginContext } from '../src/host/types.js'
import { createInitialisedFixture, writeFile } from './helpers/fixture.js'

test('prepare presentation survives restart and repository disappearance byte-for-byte', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'README.md', '# Changed\n+ exact patch\n')
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const tools = buildCommitAgentTools({ service, resolveWorkspace: async () => fixture.root })
    const exec = { agent: { id: 'session-git-commit-test', session: { id: 'session-git-commit-test' } }, signal: new AbortController().signal }
    const inspect = tools.find(t => t.name === 'commit_agent_inspect')!
    const state = await inspect.execute({}, exec) as { changes: { changeId: string }[] }
    const prepare = tools.find(t => t.name === 'commit_agent_prepare_plan')!
    const value = await prepare.execute({ commits: [{ message: 'docs: change', changes: state.changes.map(c => c.changeId) }] }, exec)
    const expected = prepare.output.presentationMeta!({}, value) as PlanPresentation
    assert.match((expected.preview as { patch: string }[])[0]!.patch, /exact patch/)
    const before = await readFile(join(fixture.dataDir, 'store.json'), 'utf8')
    // Move the isolated fixture's .git away temporarily: recovery must not ask Git.
    await rename(join(fixture.root, '.git'), join(fixture.root, '.git-away'))
    const restarted = new CommitAgentService({ dataDir: fixture.dataDir })
    assert.deepEqual(await sessionPlanPresentations(restarted, exec.agent.id), [expected])
    assert.deepEqual(await sessionPlanPresentations(restarted, 'foreign-session'), [])
    assert.equal(await readFile(join(fixture.dataDir, 'store.json'), 'utf8'), before)
  } finally { await fixture.cleanup() }
})

test('historical recovery uses only read handles, closes them, and checks persisted session identity', async () => {
  const fixture = await createInitialisedFixture()
  try {
    await writeFile(fixture.root, 'README.md', '# Historic\n')
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const state = await service.openTask({ sourceSessionId: null, agentSessionId: 'stale-reused-task-session', workspaceRoot: fixture.root })
    const published = await service.publishPlan(state.task.taskId, { commits: [{ message: 'docs: historic', changes: state.snapshot.entries.map(c => c.changeId) }] })
    const p = published.plan
    const meta: PlanPresentation = { taskId: p.taskId, planId: p.planId, revision: p.revision, planDigest: p.planDigest, commits: p.commits, reviewDetail: p.reviewDetail, preview: published.preview }
    let closed = 0
    const persistence = { async open(id: string, access: 'read') {
      assert.equal(access, 'read')
      return { inheritedEventCount: 2, async read(offset?: number) { assert.equal(offset, 2); return { events: id === 'historical' ? [{ type: 'tool/call', data: { name: 'commit_agent_prepare_plan', callId: 'call' } }, { type: 'tool/result', data: { message: { toolCallId: 'call', isError: false }, meta } }, { type: 'tool/result', data: { message: { toolCallId: 'fake' }, meta: { ...meta, planId: 'fake' } } }, { type: 'tool/result', data: { message: { toolCallId: 'call', isError: true }, meta: { ...meta, planId: 'error' } } }] : [] } }, async close() { closed++ } }
    } }
    assert.deepEqual(await sessionPlanPresentations(service, 'historical', persistence), [meta])
    assert.equal(closed, 1)
    assert.deepEqual(await sessionPlanPresentations(service, 'foreign', persistence), [])
    assert.equal(closed, 2)
    assert.deepEqual(await sessionPlanPresentations(service, 'historical'), [], 'missing patches are not invented')
  } finally { await fixture.cleanup() }
})

test('HTTP admission, strict exact identity, methods, errors, polling and disposal', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const state = await service.openTask({ sourceSessionId: null, agentSessionId: 'session', workspaceRoot: fixture.root })
    const published = await service.publishPlan(state.task.taskId, { commits: [] })
    const p = published.plan
    const meta: PlanPresentation = { taskId: p.taskId, planId: p.planId, revision: p.revision, planDigest: p.planDigest, commits: [], preview: [{ patch: 'stored', patchTruncated: false }] }
    const routes = new Map<string, Parameters<PlanHttpHost['webServer']['register']>[0]>()
    const disposers: (() => void)[] = []
    let rejection: 401 | 403 | undefined
    let admissions = 0
    const owner = {
      webServer: { register(route: Parameters<PlanHttpHost['webServer']['register']>[0]) { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
      connection: { admit() { admissions++; return rejection === undefined ? { peer: {} } : { rejection } } },
      effect(fn: () => (() => void) | void) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    } as unknown as HostPluginContext
    mountPlanHttpRoutes(owner, service)
    async function request(path: string, query: string, method = 'GET') {
      let status = 0; let body = ''; const headers: Record<string, unknown> = {}
      const response = { headersSent: false, setHeader(k: string, v: unknown) { headers[k] = v }, writeHead(n: number, h: Record<string, unknown>) { status = n; Object.assign(headers, h) }, end(s: string) { body = s } } as unknown as ServerResponse
      await routes.get(path)!.handler({ method, url: `${path}?${query}` } as IncomingMessage, response)
      return { status, body: JSON.parse(body) as unknown, headers }
    }
    const list = '/git-commit-agent/api/plans'; const exact = '/git-commit-agent/api/plan'; const index = '/git-commit-agent/api/plan-index'
    rejection = 401; assert.equal((await request(index, 'limit=bad')).status, 401)
    rejection = 403; assert.equal((await request(index, '')).status, 403)
    rejection = undefined
    assert.deepEqual((await request(index, '')).body, { schemaVersion: 1, plans: [], hasMore: false })
    for (const bad of ['limit=0', 'limit=101', 'limit=1.0', 'limit=-1', 'limit=01', 'limit=', 'limit=1&limit=2', 'offset=-1', 'offset=1.5', 'offset=9007199254740992', 'offset=0&offset=1', 'workspaceRoot=', 'workspaceRoot=x&workspaceRoot=y', 'sessionId=session', 'extra=x']) assert.equal((await request(index, bad)).status, 400, bad)
    assert.equal((await request(index, '', 'POST')).status, 405)
    rejection = 401; assert.equal((await request(exact, '')).status, 401)
    rejection = 403; assert.equal((await request(list, 'sessionId=session')).status, 403)
    rejection = undefined
    assert.deepEqual((await request(list, 'sessionId=session')).body, { schemaVersion: 1, sessionId: 'session', plans: [] })
    await persistPlanPresentation(service.directory, meta, 'session')
    assert.deepEqual((await request(list, 'sessionId=session')).body, { schemaVersion: 1, sessionId: 'session', plans: [meta] })
    const indexed = await request(index, 'limit=100&offset=0')
    assert.equal(indexed.status, 200)
    assert.deepEqual(indexed.body, { schemaVersion: 1, plans: [{ sourceSessionId: 'session', taskId: p.taskId, planId: p.planId, revision: p.revision, digest: p.planDigest, createdAt: p.createdAt, workspaceRoot: p.target.worktreePath, worktreePath: p.target.worktreePath, branch: p.target.branch, status: p.status, commitCount: 0 }], hasMore: false })
    assert.ok(!JSON.stringify(indexed.body).includes('stored'))
    assert.deepEqual((await request(index, 'offset=1')).body, { schemaVersion: 1, plans: [], hasMore: false })
    assert.deepEqual((await request(index, 'workspaceRoot=foreign')).body, { schemaVersion: 1, plans: [], hasMore: false })
    const q = new URLSearchParams({ sessionId: 'session', taskId: p.taskId, planId: p.planId, revision: String(p.revision), digest: p.planDigest }).toString()
    const got = await request(exact, q)
    assert.equal(got.status, 200); assert.deepEqual(got.body, meta); assert.equal(got.headers['Cache-Control'], 'no-store')
    assert.equal((await request(exact, q.replace('sessionId=session', 'sessionId=foreign'))).status, 404)
    assert.equal((await request(exact, q.replace(p.planDigest, 'wrong'))).status, 404)
    assert.equal((await request(exact, new URLSearchParams({ sessionId: 'session', taskId: '__proto__', planId: p.planId, revision: String(p.revision), digest: p.planDigest }).toString())).status, 404)
    assert.equal((await request(index, new URLSearchParams({ workspaceRoot: p.target.worktreePath }).toString())).status, 200)
    for (const bad of ['', q + '&revision=1', q + '&extra=x', q.replace('revision=1', 'revision=1.0'), q.replace('revision=1', 'revision=9007199254740992')]) assert.equal((await request(exact, bad)).status, 400)
    const post = await request(list, 'sessionId=session', 'POST'); assert.equal(post.status, 405); assert.equal(post.headers.Allow, 'GET')
    const storeFile = join(service.directory, 'store.json')
    const before = await readFile(storeFile, 'utf8')
    await writeRawFile(storeFile, '{broken', 'utf8')
    assert.equal((await request(index, '')).status, 500)
    assert.equal((await request(exact, q)).status, 500)
    assert.equal(await readFile(storeFile, 'utf8'), '{broken')
    await writeRawFile(storeFile, before, 'utf8')
    assert.ok(admissions > 10)
    for (const dispose of disposers) dispose()
    assert.equal(routes.size, 0)
  } finally { await fixture.cleanup() }
})


test('index uses publication origin, recent pagination, and exact ignores unrelated corrupt patches', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const state = await service.openTask({ sourceSessionId: 'initiator', agentSessionId: 'planner', workspaceRoot: fixture.root })
    const published = await service.publishPlan(state.task.taskId, { commits: [] })
    const first = published.plan
    const meta: PlanPresentation = { taskId: first.taskId, planId: first.planId, revision: first.revision, planDigest: first.planDigest, commits: [], preview: [{ patch: 'SECRET_PATCH' }] }
    await persistPlanPresentation(service.directory, meta, 'publication-session')
    const storeFile = join(service.directory, 'store.json')
    const doc = JSON.parse(await readFile(storeFile, 'utf8'))
    const second = { ...first, planId: 'second', revision: 2, planDigest: 'second-digest', createdAt: '2099-01-01T00:00:00Z' }
    doc.tasks[first.taskId].plans.push(second)
    await writeRawFile(storeFile, JSON.stringify(doc))
    const secondMeta = { ...meta, planId: second.planId, revision: second.revision, planDigest: second.planDigest }
    await persistPlanPresentation(service.directory, secondMeta, 'planner-two')
    const before = await readFile(storeFile, 'utf8')
    await rename(join(fixture.root, '.git'), join(fixture.root, '.git-away'))
    const persistence = { async open(): Promise<never> { throw new Error('must not open a session') } }
    const page = await recentPlanIndex(service, { limit: 1 }, persistence)
    assert.equal(page.hasMore, true)
    assert.equal(page.plans[0]!.sourceSessionId, 'planner-two')
    assert.equal(page.plans[0]!.planId, 'second')
    const next = await recentPlanIndex(service, { limit: 1, offset: 1 }, persistence)
    assert.equal(next.hasMore, false)
    assert.equal(next.plans[0]!.sourceSessionId, 'publication-session')
    assert.ok(!JSON.stringify(next).includes('SECRET_PATCH'))
    const files = await readdir(join(service.directory, 'presentations'))
    for (const file of files) {
      const path = join(service.directory, 'presentations', file)
      const envelope = JSON.parse(await readFile(path, 'utf8'))
      if (envelope.payload.planId === 'second') await writeRawFile(path, '{broken')
    }
    const wanted = { taskId: first.taskId, planId: first.planId, revision: first.revision, digest: first.planDigest }
    assert.deepEqual(await exactPlanPresentation(service, 'publication-session', wanted, persistence), meta)
    assert.equal(await exactPlanPresentation(service, 'publication-session', { ...wanted, taskId: 'absent' }, persistence), null)
    assert.equal(await readFile(storeFile, 'utf8'), before)
    doc.tasks[first.taskId].plans = [second]
    await writeRawFile(storeFile, JSON.stringify(doc))
    assert.equal(await exactPlanPresentation(service, 'publication-session', wanted, persistence), null, 'orphan presentation cannot bypass store identity')
  } finally { await fixture.cleanup() }
})

test('legacy index confirms only agent-session local results and incrementally reads log tails', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const service = new CommitAgentService({ dataDir: fixture.dataDir })
    const state = await service.openTask({ sourceSessionId: 'initiator-not-planner', agentSessionId: 'planner', workspaceRoot: fixture.root })
    const published = await service.publishPlan(state.task.taskId, { commits: [] })
    const p = published.plan
    const meta: PlanPresentation = { taskId: p.taskId, planId: p.planId, revision: p.revision, planDigest: p.planDigest, commits: [], preview: [{ patch: 'LEGACY_SECRET' }] }
    let closed = 0
    const offsets: number[] = []
    const events = [{ type: 'tool/call', data: { name: 'commit_agent_prepare_plan', callId: 'call' } }, { type: 'tool/result', data: { message: { toolCallId: 'call' }, meta } }]
    const persistence = { async open(id: string, access: 'read') {
      assert.equal(id, 'planner'); assert.equal(access, 'read')
      return { inheritedEventCount: 4, async read(offset = 0) { offsets.push(offset); return { events: events.slice(offset - 4) } }, async close() { closed++ } }
    } }
    const index = await recentPlanIndex(service, {}, persistence)
    assert.equal(index.plans[0]!.sourceSessionId, 'planner')
    assert.ok(!JSON.stringify(index).includes('LEGACY_SECRET'))
    assert.deepEqual(await recentPlanIndex(service, {}, persistence), index)
    assert.deepEqual(offsets, [4]); assert.equal(closed, 1)
    assert.deepEqual(await exactPlanPresentation(service, 'planner', { taskId: p.taskId, planId: p.planId, revision: p.revision, digest: p.planDigest }, persistence), meta)
    const doc = JSON.parse(await readFile(join(service.directory, 'store.json'), 'utf8'))
    doc.tasks[p.taskId].plans.push({ ...p, planId: 'missing', revision: 2, planDigest: 'missing-digest' })
    await writeRawFile(join(service.directory, 'store.json'), JSON.stringify(doc))
    assert.equal((await recentPlanIndex(service, {}, persistence)).plans.length, 1)
    assert.equal(offsets.at(-1), 6, 'unconfirmed new identities read only the tail')
  } finally { await fixture.cleanup() }
})
