import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { repositoryWebUrl, parseRepositoryLinks, mountRepositoryLinksRoute, type RepositorySubprocess } from '../src/host/repository-links.js'
import type { PlanHttpHost } from '../src/host/plan-http.js'
import type { HostPluginContext } from '../src/host/types.js'
import { createInitialisedFixture, git } from './helpers/fixture.js'

test('safe transports become credential-free HTTPS repository links', () => {
  for (const [input, expected] of [
    ['https://user:secret@github.com/team/repo.git?token=secret#frag', 'https://github.com/team/repo'],
    ['http://example.com:8080/team/repo.git/', 'https://example.com:8080/team/repo'],
    ['git://example.com:9418/team/repo.git', 'https://example.com/team/repo'],
    ['ssh://git:secret@example.com:2222/team/repo.git', 'https://example.com/team/repo'],
    ['git@github.com:team/repo.git', 'https://github.com/team/repo'],
    ['github.com:team/repo.git', 'https://github.com/team/repo'],
    ['ssh://git@[2001:db8::1]:2222/team/repo.git', 'https://[2001:db8::1]/team/repo'],
  ]) assert.equal(repositoryWebUrl(input!), expected, input)
  for (const value of ['', '/tmp/repo', './repo', 'C:/repo', 'file:///tmp/repo', 'javascript:alert(1)', 'ext::evil', 'https://host/', 'https://host/a/../b', 'https://host/a/%2e%2e/b', 'https://host/a%2fb', 'https://host/a%00b', 'https://host/a\\b', 'ssh://host/a\nb', 'https://host/a b', 'https://host/%zz']) assert.equal(repositoryWebUrl(value), null, value)
})

test('NUL records preserve names, remove unsafe remotes, deduplicate and put origin first', () => {
  const input = 'remote.upstream.url\nssh://git@example.com:2222/t/up.git\0remote.origin.url\nhttps://user:secret@example.com/t/main.git?key=x\0remote.local.url\n/tmp/local\0remote.upstream.url\nssh://git@example.com:2222/t/up.git\0remote.bad\nhttps://example.com/x\0'
  assert.deepEqual(parseRepositoryLinks(input), [{ name: 'origin', url: 'https://example.com/t/main' }, { name: 'upstream', url: 'https://example.com/t/up' }])
})

/** Test-only subprocess adapter executes the exact public argv seam. */
function subprocess(calls: { cwd: string; argv: readonly string[] }[]): RepositorySubprocess {
  return { async spawn(spec) {
    calls.push({ cwd: spec.cwd, argv: spec.argv })
    assert.equal(spec.argv[0], 'git'); assert.equal(spec.stdio.stdin, 'ignore')
    assert.equal(spec.env.GIT_DIR, undefined)
    let output = ''; let lossy = false
    const done = new Promise<{ exitCode: number | null }>((resolve, reject) => {
      const env = { ...process.env, ...spec.env }
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
      execFile(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env, signal: spec.signal, maxBuffer: spec.stdio.stdout.maxBytes }, (error, stdout) => {
        output = stdout
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') { reject(error); return }
        lossy = output.length > spec.stdio.stdout.maxBytes
        resolve({ exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0 })
      })
    })
    return { done, collected: { stdout: { readFrom() { return { text: output, lossy } } } } }
  } }
}

test('authenticated HTTP route enforces session/repository/worktree authority and remains read-only', async () => {
  const fixture = await createInitialisedFixture()
  const foreign = await createInitialisedFixture()
  try {
    git(fixture.root, ['remote', 'add', 'origin', 'https://user:secret@example.com/team/repo.git?token=secret'])
    git(fixture.root, ['remote', 'add', 'local', '/tmp/local'])
    const checkout = join(fixture.dataDir, 'checkout')
    git(fixture.root, ['worktree', 'add', '--quiet', '-b', 'linked', checkout])
    const before = await readFile(join(fixture.root, '.git', 'config'), 'utf8')
    let route: Parameters<PlanHttpHost['webServer']['register']>[0] | undefined
    let dispose: (() => void) | undefined
    let rejection: 401 | 403 | undefined
    let closed = 0
    const calls: { cwd: string; argv: readonly string[] }[] = []
    const processService = subprocess(calls)
    const services: Record<string, unknown> = {
      subprocess: processService,
      sessions: { get(id: string) { return id === 'live' ? { header: { cwd: fixture.root } } : undefined } },
      sessionPersistence: { async open(id: string, mode: string) { assert.equal(mode, 'read'); if (id !== 'cold') throw Object.assign(new Error(), { code: 'SESSION_NOT_FOUND' }); return { header: { cwd: fixture.root }, async close() { closed++ } } } },
    }
    const owner = {
      get(name: string) { return services[name] },
      webServer: { register(value: NonNullable<typeof route>) { route = value; return () => { route = undefined } } },
      connection: { admit() { return rejection ? { rejection } : { peer: {} } } },
      effect(fn: () => (() => void)) { dispose = fn() },
    } as unknown as HostPluginContext
    mountRepositoryLinksRoute(owner)
    async function request(query: string, method = 'GET') {
      let status = 0; let body = ''; const headers: Record<string, unknown> = {}
      const response = { setHeader(key: string, value: unknown) { headers[key] = value }, writeHead(code: number, values: Record<string, unknown>) { status = code; Object.assign(headers, values) }, end(value: string) { body = value } } as unknown as ServerResponse
      await route!.handler({ method, url: `/git-commit-agent/api/repository-links?${query}` } as IncomingMessage, response)
      return { status, body: JSON.parse(body), headers }
    }
    rejection = 401; assert.equal((await request('')).status, 401)
    rejection = 403; assert.equal((await request('scope=live')).status, 403)
    assert.equal(calls.length, 0)
    rejection = undefined
    for (const query of ['', 'scope=', 'scope=a&scope=b', 'scope=live&extra=x', 'scope=live&repoRoot=relative', 'scope=live&worktree=', 'scope=live&worktree=/x&worktree=/y', 'scope=live&scope=%00']) assert.equal((await request(query)).status, 400, query)
    const post = await request('scope=live', 'POST'); assert.equal(post.status, 405); assert.equal(post.headers.Allow, 'GET')
    assert.equal((await request('scope=missing')).status, 404)
    assert.equal(calls.length, 0)
    const expected = { links: [{ name: 'origin', url: 'https://example.com/team/repo' }] }
    const live = await request('scope=live'); assert.equal(live.status, 200); assert.deepEqual(live.body, expected); assert.equal(live.headers['Cache-Control'], 'no-store')
    assert.deepEqual((await request('scope=cold')).body, expected); assert.equal(closed, 1)
    assert.deepEqual((await request(`scope=live&repoRoot=${encodeURIComponent(fixture.root)}&worktree=${encodeURIComponent(checkout)}`)).body, expected)
    const prior = calls.length
    assert.equal((await request(`scope=live&repoRoot=${encodeURIComponent(foreign.root)}`)).status, 403)
    assert.ok(calls.slice(prior).every(call => call.cwd !== foreign.root))
    assert.equal((await request(`scope=live&worktree=${encodeURIComponent(foreign.root)}`)).status, 403)
    assert.ok(calls.every(call => call.cwd !== foreign.root))
    assert.equal(await readFile(join(fixture.root, '.git', 'config'), 'utf8'), before)
    services.agents = { get() { return { ctx: { get() { return {} } } } } }
    const remotePrior = calls.length
    assert.equal((await request('scope=live')).status, 503); assert.equal(calls.length, remotePrior)
    delete services.agents
    delete services.subprocess
    assert.equal((await request('scope=live')).status, 503)
    dispose!(); assert.equal(route, undefined)
  } finally { await fixture.cleanup(); await foreign.cleanup() }
})

test('container workspace selects only discovered direct child repositories', async () => {
  const fixture = await createInitialisedFixture()
  try {
    const root = join(fixture.dataDir, 'container'); const child = join(root, 'project')
    await mkdir(child, { recursive: true }); git(child, ['init', '--quiet']); git(child, ['remote', 'add', 'upstream', 'git@example.com:team/repo.git'])
    const services: Record<string, unknown> = { subprocess: subprocess([]), sessions: { get() { return { header: { cwd: root } } } } }
    const { repositoryLinksForSession } = await import('../src/host/repository-links.js')
    const owner = { get(name: string) { return services[name] } } as unknown as HostPluginContext
    assert.deepEqual(await repositoryLinksForSession(owner, 'container', child), [{ name: 'upstream', url: 'https://example.com/team/repo' }])
    await assert.rejects(repositoryLinksForSession(owner, 'container', fixture.root), /invalid repository scope/)
  } finally { await fixture.cleanup() }
})
