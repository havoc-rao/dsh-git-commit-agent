/** Read-only repository links. Client paths are selectors, never execution authority. */
import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostAgentRegistry, HostPluginContext, HostSessionStore } from './types.js'
import type { PlanHttpHost } from './plan-http.js'

export interface RepositoryLink { name: string; url: string }

/** Convert transport remotes to credential-free HTTPS, never execute/contact them. */
export function repositoryWebUrl(remote: string): string | null {
  if (!remote || remote.length > 8192 || /[\s\x00-\x1f\x7f\\]/.test(remote)) return null
  let parsed: URL
  let transport: string
  try {
    if (/^(https?|git|ssh):\/\//i.test(remote)) {
      parsed = new URL(remote)
      transport = parsed.protocol
    } else {
      // SCP requires an explicit user or a DNS-like host, excluding drive/local paths.
      const scp = /^(?:([^/@:]+)@)?(\[[0-9a-f:]+\]|[a-z0-9.-]+):(.+)$/i.exec(remote)
      if (!scp || (!scp[1] && !scp[2]!.includes('.')) || /^[a-z]:/i.test(remote)) return null
      parsed = new URL(`ssh://${scp[1] ? `${scp[1]}@` : ''}${scp[2]}/${scp[3]!.replace(/^\/+/, '')}`)
      transport = 'ssh:'
    }
    if (!parsed.hostname || parsed.hostname === '.' || parsed.hostname === '..') return null
    let path = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
    if (!path || path === '/') return null
    // Refuse escaped control characters, separators and dot segments. URL parsing
    // normalizes dot segments, so validate the original path before accepting it.
    const rawPath = remote.replace(/^[^:]+:\/\/[^/]+/, '').split(/[?#]/, 1)[0]!
    for (const segment of rawPath.split('/')) {
      const decoded = decodeURIComponent(segment)
      if (decoded === '.' || decoded === '..' || /[\x00-\x1f\x7f\\]/.test(decoded) || /%2f|%5c/i.test(segment)) return null
    }
    parsed.protocol = 'https:'
    // Non-special URL protocols cannot always be reassigned to a special one.
    const web = new URL(`https://${parsed.hostname}${transport === 'http:' || transport === 'https:' ? (parsed.port ? `:${parsed.port}` : '') : ''}${path}`)
    web.username = ''; web.password = ''; web.search = ''; web.hash = ''
    return web.href
  } catch { return null }
}

/** Parse NUL-framed `git config --get-regexp` records (key LF value NUL). */
export function parseRepositoryLinks(output: string): RepositoryLink[] {
  const links: RepositoryLink[] = []
  const seen = new Set<string>()
  for (const record of output.split('\0')) {
    const newline = record.indexOf('\n')
    if (newline < 0) continue
    const key = record.slice(0, newline)
    const match = /^remote\.(.+)\.url$/i.exec(key)
    if (!match || /[\x00-\x1f\x7f]/.test(match[1]!) || match[1]!.length > 256) continue
    const url = repositoryWebUrl(record.slice(newline + 1))
    if (!url) continue
    const name = match[1]!
    const identity = JSON.stringify([name, url])
    if (seen.has(identity)) continue
    seen.add(identity); links.push({ name, url })
  }
  return links.sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin') || a.name.localeCompare(b.name) || a.url.localeCompare(b.url))
}

/** Structural mirror of DSH subprocess's argv-only, bounded collection seam. */
export interface RepositorySubprocess {
  spawn(spec: {
    argv: readonly string[]; cwd: string; graceMs: number; signal: AbortSignal; env: NodeJS.ProcessEnv
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
  }): {
    done: Promise<{ exitCode: number | null }>
    collected: { stdout?: { readFrom(offset: number): { text: string; lossy: boolean } } }
  } | Promise<{
    done: Promise<{ exitCode: number | null }>
    collected: { stdout?: { readFrom(offset: number): { text: string; lossy: boolean } } }
  }>
}
interface Persistence {
  open(id: string, access: 'read'): Promise<{ header: { cwd?: string }; close(): Promise<void> }>
}
class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const identity = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const absolute = (path: string): string => {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new RouteError(400, 'invalid query')
  return resolve(path)
}

/** Only host-selected executable/arguments enter the subprocess abstraction. */
async function runGit(subprocess: RepositorySubprocess, cwd: string, args: readonly string[], allowEmpty = false): Promise<string> {
  const env: NodeJS.ProcessEnv = {}
  // Remove ambient repository/config injection, while retaining normal on-disk
  // configuration. No shell, hooks, transport or helper command is invoked.
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) env[key] = undefined
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' })
  const child = await subprocess.spawn({
    argv: ['git', '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], cwd,
    graceMs: 1000, signal: AbortSignal.timeout(5000), env,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 4096 } },
  })
  const outcome = await child.done
  const output = child.collected.stdout?.readFrom(0)
  if (output?.lossy || !output || (outcome.exitCode !== 0 && !(allowEmpty && outcome.exitCode === 1 && output.text === ''))) throw new RouteError(503, 'repository links unavailable')
  return output.text
}

async function sessionCwd(owner: HostPluginContext, sessionId: string): Promise<string> {
  const cwd = owner.get?.<HostSessionStore>('sessions')?.get(sessionId)?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return absolute(cwd)
  const persistence = owner.get?.<Persistence>('sessionPersistence')
  if (!persistence) throw new RouteError(404, 'session not found')
  let handle: Awaited<ReturnType<Persistence['open']>>
  try { handle = await persistence.open(sessionId, 'read') }
  catch (error) {
    if ((error as { code?: string }).code === 'SESSION_NOT_FOUND' || (error as Error).name === 'SessionPersistenceNotFoundError') throw new RouteError(404, 'session not found')
    throw error
  }
  try {
    if (!handle.header.cwd) throw new RouteError(404, 'session workspace unavailable')
    return absolute(handle.header.cwd)
  } finally { await handle.close() }
}

/** Mirror sidebar's current/direct-child inventory, with strict selection and symlink fencing. */
async function repositoryRoots(subprocess: RepositorySubprocess, cwd: string): Promise<string[]> {
  const probe = async (path: string): Promise<string | null> => {
    try { return absolute((await runGit(subprocess, path, ['rev-parse', '--show-toplevel'])).trim()) }
    catch { return null }
  }
  const direct = await probe(cwd)
  if (direct) return [direct]
  const canonicalCwd = await realpath(cwd)
  const entries = (await readdir(cwd, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 32)
  const roots: string[] = []
  for (const entry of entries) {
    const candidate = await realpath(join(cwd, entry.name))
    const rel = relative(canonicalCwd, candidate)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    const root = await probe(candidate)
    if (root && !roots.some(existing => identity(existing) === identity(root))) roots.push(root)
  }
  return roots
}

export async function repositoryLinksForSession(owner: HostPluginContext, scope: string, repoRoot?: string, worktree?: string): Promise<RepositoryLink[]> {
  const cwd = await sessionCwd(owner, scope)
  // Prefer the session provider (e.g. SSH); never resume/create an agent merely
  // to read remotes. Missing providers fail closed, not local exec fallback.
  const agent = owner.get?.<HostAgentRegistry>('agents')?.get(scope)
  const scoped = agent?.ctx as (HostPluginContext | undefined)
  const subprocess = owner.get?.<RepositorySubprocess>('subprocess')
  const sessionSubprocess = scoped?.get?.<RepositorySubprocess>('subprocess')
  // Local discovery cannot share SSH paths/providers. Reject remote mirrors
  // too (including detached sessions) instead of probing the wrong machine.
  // Cordis returns context-bound proxies, so object inequality is not provider
  // inequality. Compare underlying services, but execute through the bound proxy.
  const original = (service: RepositorySubprocess): unknown => Reflect.get(service, Symbol.for('cordis.original')) ?? service
  if (!subprocess || (sessionSubprocess && original(sessionSubprocess) !== original(subprocess)) || /(?:^|[\\/])remote-workspaces(?:[\\/]|$)/i.test(cwd)) throw new RouteError(503, 'repository links unavailable')
  const roots = await repositoryRoots(subprocess, cwd)
  if (!roots.length) throw new RouteError(404, 'repository not found')
  const requestedRoot = repoRoot === undefined ? undefined : await realpath(repoRoot).catch(() => repoRoot)
  const selected = requestedRoot === undefined ? roots[0]! : roots.find(root => identity(root) === identity(requestedRoot))
  if (!selected) throw new RouteError(403, 'invalid repository scope')
  let checkout = selected
  if (worktree !== undefined) {
    const requestedWorktree = await realpath(worktree).catch(() => worktree)
    const inventory = await runGit(subprocess, selected, ['worktree', 'list', '--porcelain', '-z'])
    const match = inventory.split('\0\0').map(record => record.split('\0'))
      .find(fields => !fields.some(field => field.startsWith('prunable')) && fields.some(field => field.startsWith('worktree ') && identity(field.slice(9)) === identity(requestedWorktree)))
    const field = match?.find(value => value.startsWith('worktree '))
    if (!field) throw new RouteError(403, 'invalid worktree scope')
    checkout = absolute(field.slice(9))
  }
  return parseRepositoryLinks(await runGit(subprocess, checkout, ['config', '--null', '--get-regexp', '^remote\\..*\\.url$'], true))
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}
export function mountRepositoryLinksRoute(owner: HostPluginContext): void {
  const host = owner as HostPluginContext & PlanHttpHost
  const dispose = host.webServer.register({ kind: 'exact', path: '/git-commit-agent/api/repository-links', handler: async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const admitted = host.connection.admit(req)
      if ('rejection' in admitted) { send(res, admitted.rejection, { error: admitted.rejection === 401 ? 'unauthorized' : 'forbidden' }); return }
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(res, 405, { error: 'method not allowed' }); return }
      const url = new URL(req.url ?? '/', 'http://local')
      for (const key of url.searchParams.keys()) if (!['scope', 'repoRoot', 'worktree'].includes(key)) throw new RouteError(400, 'invalid query')
      const value = (key: string, required = false): string | undefined => {
        const values = url.searchParams.getAll(key)
        if (!values.length && !required) return undefined
        if (values.length !== 1 || !values[0] || values[0].length > 8192 || /[\x00-\x1f\x7f]/.test(values[0])) throw new RouteError(400, 'invalid query')
        return values[0]
      }
      const scope = value('scope', true)!
      const repoRoot = value('repoRoot'); const worktree = value('worktree')
      send(res, 200, { links: await repositoryLinksForSession(owner, scope, repoRoot === undefined ? undefined : absolute(repoRoot), worktree === undefined ? undefined : absolute(worktree)) })
    } catch (error) {
      // Never return/log raw Git stdout/stderr: it may contain remote credentials.
      const status = error instanceof RouteError ? error.status : 503
      send(res, status, { error: error instanceof RouteError ? error.message : 'repository links unavailable' })
    }
  } })
  owner.effect?.(() => dispose)
}
