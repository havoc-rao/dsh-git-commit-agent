import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { GitCommitError } from '../core/errors.js'

/** Shared with the service's default read exclusions; never weaken native reads. */
const SENSITIVE = [/(^|\/)\.env(\.|$)/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /\.(pem|p12|pfx|key)$/i, /(^|\/)\.git-credentials$/, /(^|\/)\.npmrc$/,
  /(^|\/)credentials(\.|$)/i, /(^|\/)secrets?(\.|$)/i]

export interface WorkspaceEditService {
  acquireWorkspaceEdit(worktreePath: string): () => void
  isWorkspaceBusy(worktreePath: string): boolean
  invalidatePlansAfterEdit(taskId: string): Promise<void>
}
interface Binding {
  readonly taskId: string
  readonly root: string
  readonly cwd: string
  readonly grants: Set<string>
  generation: number
}
interface NativeExecution { name: string; arguments: Record<string, unknown>; agent?: { session?: { id?: string } } }

function deny(message: string): never { throw new GitCommitError('UNSAFE_ARGUMENT', message) }
function confined(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
/** Validate existing regular files at every decision AND immediately before dispatch. */
export function validateEditPath(root: string, path: string, repositoryRelative = true, cwd = root): string {
  if (typeof path !== 'string' || path === '' || path.includes('\0') || path.includes('\\')) deny('an exact file path is required')
  if (repositoryRelative && (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split('/').some(p => p === '' || p === '.' || p === '..'))) {
    deny('approval paths must be exact repository-relative paths without traversal')
  }
  if (path.split('/').some(p => p.toLowerCase() === '.git')) deny('Git metadata is not accessible')
  const canonicalRoot = realpathSync(root)
  if (canonicalRoot !== root) deny('the bound worktree changed its canonical location')
  const target = resolve(cwd, path)
  if (!confined(root, target)) deny('path is outside the bound worktree')
  const repoPath = relative(root, target).split(sep).join('/')
  if (repoPath.split('/').some(p => p.toLowerCase() === '.git')) deny('Git metadata is not accessible')
  if (SENSITIVE.some(pattern => pattern.test(repoPath))) deny('sensitive files are not accessible')
  let current = root
  const components = repoPath.split('/')
  for (let i = 0; i < components.length; i++) {
    current = resolve(current, components[i]!)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) deny('symlink paths are not accessible')
    if (i < components.length - 1 && !stat.isDirectory()) deny('file parent must be a directory')
    if (i === components.length - 1 && !stat.isFile()) deny('path must be an existing regular file')
    if (realpathSync(current) !== current) deny('path canonicalization changed')
  }
  return repoPath
}

/** Ephemeral session-owned grants. No file mutation is performed by this controller. */
export class EditCapabilityController {
  private readonly sessions = new Map<string, Binding>()
  private readonly pipelines = new Map<string, number>()
  private disposed = false
  constructor(private readonly service: WorkspaceEditService) {}

  bindSession(sessionId: string, taskId: string, worktreePath: string, workspacePath = worktreePath): void {
    if (this.disposed) deny('edit capability controller is disposed')
    const root = realpathSync(worktreePath)
    const cwd = realpathSync(workspacePath)
    if (cwd !== root && !confined(root, cwd)) deny('session workspace is outside the worktree')
    const old = this.sessions.get(sessionId)
    if (old?.root === root && old.taskId === taskId && old.cwd === cwd) return
    this.disposeSession(sessionId)
    this.sessions.set(sessionId, { taskId, root, cwd, grants: new Set(), generation: 0 })
  }
  private binding(sessionId: string): Binding {
    const binding = this.sessions.get(sessionId)
    if (this.disposed || binding === undefined) deny('first inspect the bound repository before using native file tools')
    return binding
  }
  attachPipeline(sessionId: string): () => void {
    this.pipelines.set(sessionId, (this.pipelines.get(sessionId) ?? 0) + 1)
    let released = false
    return () => { if (!released) { released = true; const n = (this.pipelines.get(sessionId) ?? 1) - 1; if (n === 0) this.pipelines.delete(sessionId); else this.pipelines.set(sessionId, n) } }
  }
  status(sessionId: string): readonly string[] { return [...this.binding(sessionId).grants].sort() }
  revoke(sessionId: string): void { const b = this.binding(sessionId); b.grants.clear(); b.generation++ }
  prepareRequest(sessionId: string, paths: unknown): { paths: string[]; grant: () => void } {
    const b = this.binding(sessionId)
    if (!this.pipelines.has(sessionId)) deny('native edit authorization requires the scoped around-execution pipeline')
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 40 || paths.some(p => typeof p !== 'string')) deny('request requires 1–40 exact file paths')
    const checked = [...new Set((paths as string[]).map(p => validateEditPath(b.root, p)))]
    const generation = b.generation
    return { paths: checked, grant: () => {
      if (this.binding(sessionId) !== b || b.generation !== generation) deny('edit request was revoked while awaiting approval')
      if (!this.pipelines.has(sessionId)) deny('native edit pipeline is unavailable')
      for (const path of checked) validateEditPath(b.root, path)
      for (const path of checked) b.grants.add(path)
    } }
  }
  guard(execution: unknown, sessionId: string): string | undefined {
    try { this.validateExecution(execution, sessionId); return undefined } catch (error) { return `commit agent file guard: ${error instanceof Error ? error.message : 'invalid execution'}` }
  }
  private validateExecution(execution: unknown, sessionId: string): { b: Binding; name: string } {
    if (execution === null || typeof execution !== 'object') deny('invalid native execution')
    const e = execution as NativeExecution
    if (e.name !== 'read' && e.name !== 'edit') deny('invalid native tool')
    if (e.agent?.session?.id !== sessionId) deny('execution does not belong to this session')
    const b = this.binding(sessionId)
    if (e.arguments === null || typeof e.arguments !== 'object' || Array.isArray(e.arguments)) deny('invalid native arguments')
    const a = e.arguments
    if (Object.keys(a).some(k => /sandbox|permission|escalat|justification/i.test(k))) deny('native file tools cannot request permission escalation')
    if (typeof a['file_path'] !== 'string') deny('native tool requires file_path')
    const path = validateEditPath(b.root, a['file_path'], false, b.cwd)
    if (this.service.isWorkspaceBusy(b.root)) deny('workspace operation is already in progress')
    if (e.name === 'edit') {
      if (!this.pipelines.has(sessionId)) deny('native edit pipeline is unavailable')
      if (!b.grants.has(path)) deny('this exact file has no user-approved edit grant')
    }
    return { b, name: e.name }
  }
  async around(execution: unknown, sessionId: string, next: () => Promise<unknown>): Promise<unknown> {
    const { b, name } = this.validateExecution(execution, sessionId)
    // Lease spans the real async body, not merely the synchronous guard. Reads
    // also hold it so an execution cannot change the index/worktree mid-read.
    const release = this.service.acquireWorkspaceEdit(b.root)
    try {
      // Even a cancelled/failed native call may have changed bytes. Revoke
      // old plan approvals before dispatch, conservatively for every attempt.
      if (name === 'edit') await this.service.invalidatePlansAfterEdit(b.taskId)
      // Invalidation is async: recheck revocation, paths and caller identity
      // immediately before invoking the native body, while our lease is held.
      const e = execution as NativeExecution
      if (this.binding(sessionId) !== b) deny('session authorization was disposed')
      const path = validateEditPath(b.root, e.arguments['file_path'] as string, false, b.cwd)
      if (name === 'edit' && (!this.pipelines.has(sessionId) || !b.grants.has(path))) deny('edit authorization was revoked before dispatch')
      return await next()
    } finally { release() }
  }
  disposeSession(sessionId: string): void { const b = this.sessions.get(sessionId); if (b) { b.grants.clear(); b.generation++ }; this.sessions.delete(sessionId) }
  dispose(): void { this.disposed = true; for (const id of this.sessions.keys()) this.disposeSession(id); this.pipelines.clear() }
}
