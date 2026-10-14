/** Workspace ownership, active composer resolution and dedicated session startup. */
const { service } = require('./context.cjs')
const { SESSION_ID_PREFIX } = require('./constants.cjs')
const { buildPlanningPrompt } = require('./prompts.cjs')
const { promptLanguageFor, applyStoredDefaultModel } = require('./settings.cjs')
const { paletteCopy } = require('./command-palette/copy.cjs')
/** Compare two directory strings, ignoring a trailing separator. */
function normalizePath(value) {
  if (typeof value !== 'string' || value === '') return ''
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

/**
 * Mint the session id the host recognizes as a commit session.
 *
 * `ISessions.create` accepts a preallocated `sessionId`, which is how a
 * client-created session opts into the plugin's per-session tool surface.
 * `crypto.randomUUID` exists in every secure context the web client runs
 * in; the fallback keeps an older/embedded shell working.
 */
function newSessionId() {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
        const random = (Math.random() * 16) | 0
        const value = char === 'x' ? random : (random & 0x3) | 0x8
        return value.toString(16)
      })
  return SESSION_ID_PREFIX + uuid
}

/**
 * Resolve the registered Workspace that owns one directory.
 *
 * DSH's sidebar groups sessions strictly by **Workspace membership**
 * (`workspace.sessionIds`), not by cwd: `session.create({ cwd })` records a
 * session whose header points at that directory, but the session is only
 * attached to a Workspace when `session.create({ workspaceId })` is used
 * (the host's `SessionCommandController.create` calls
 * `workspace.attachSession` only for that branch). A session with a cwd but
 * no membership therefore falls into the "未分组" bucket even when its cwd
 * *is* a registered Workspace. Passing the matching `workspaceId` is what
 * puts the planning session back under the original workspace.
 */
function workspaceIdForPath(ctx, path) {
  const wanted = normalizePath(path)
  if (wanted === '') return undefined
  const workspaces = service(ctx, 'workspaces')
  const list = workspaces && workspaces.list
  const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item && typeof item.path === 'string' && normalizePath(item.path) === wanted) {
      return item.workspaceId
    }
  }
  return undefined
}

/**
 * Create a session in the target worktree, open it, and seed the planning
 * request. Uses only public client APIs; a missing conversation facade
 * degrades to a seeded draft the user submits themselves.
 *
 * When the target directory is a registered Workspace the session is
 * created **through that Workspace** so the host attaches it and the
 * sidebar groups it there; otherwise it is created with a plain `cwd` and
 * stays under 未分组, which is unavoidable because the host only accepts a
 * membership whose cwd equals the Workspace path exactly.
 */
async function startPlanning(ctx, target, options) {
  options = options || {}
  const cancelled = function () { return options.signal && options.signal.aborted }
  if (cancelled()) return undefined
  const worktree = target.worktree || target.repoRoot
  if (!worktree) throw new Error('找不到目标 worktree')
  const sessions = service(ctx, 'sessions')
  if (!sessions || typeof sessions.create !== 'function') {
    throw new Error('当前宿主没有可用的 sessions 服务')
  }
  const workspaceId = options.workspaceId || workspaceIdForPath(ctx, worktree)
  // Palette targets must remain registered; GitLens retains its cwd fallback.
  const checkTarget = function () {
    if (!options.workspaceId) return
    const latest = currentCommitWorkspace(ctx)
    if (!latest || latest.workspaceId !== options.workspaceId || normalizePath(latest.path) !== normalizePath(worktree)) {
      throw new Error(paletteCopy(ctx).missing)
    }
  }
  checkTarget()
  if (cancelled()) return undefined
  // Preallocate the id so the host knows this is a commit session and
  // installs the five tools into exactly this agent's scope.
  const requestedId = newSessionId()
  let sessionId
  if (workspaceId === undefined) {
    sessionId = await sessions.create({ sessionId: requestedId, cwd: worktree })
  } else {
    try {
      sessionId = await sessions.create({ sessionId: requestedId, workspaceId: workspaceId })
    } catch (failure) {
      if (options.workspaceId) throw failure
      if (cancelled()) return undefined
      // The Workspace may have been removed between the snapshot read and
      // the call. A session in the right directory is still useful; it
      // simply remains ungrouped.
      sessionId = await sessions.create({ sessionId: requestedId, cwd: worktree })
    }
  }
  if (typeof sessionId !== 'string' || sessionId === '') sessionId = requestedId
  // Pin the stored default model before the first prompt is submitted, so
  // the request header is built with it (the composer model seat's exact
  // selection path). Best-effort: a missing remote or a stale route keeps
  // the host default.
  if (cancelled()) return sessionId
  await applyStoredDefaultModel(ctx, sessionId)
  if (cancelled()) return sessionId
  checkTarget()
  const workspace = service(ctx, 'uiWorkspace')
  if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
  else if (typeof sessions.open === 'function') sessions.open(sessionId)

  const conversation = service(ctx, 'conversation')
  const actx = typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
  if (conversation && conversation.input && actx !== undefined) {
    const input = conversation.input.for(actx)
    const stagedCount = Array.isArray(target.staged) ? target.staged.length : 0
    input.setDraft(buildPlanningPrompt(worktree, target.branch, stagedCount, promptLanguageFor(ctx)))
    if (typeof input.submit === 'function') input.submit()
  }
  return sessionId
}

/** Current target comes from public stores, never palette context or DOM focus. */
function currentCommitWorkspace(ctx) {
  const workspaces = service(ctx, 'workspaces')
  const workspaceSnapshot = workspaces && workspaces.list && workspaces.list.getSnapshot()
  const current = currentCommitSession(ctx)
  if (!current) return undefined
  return (workspaceSnapshot && workspaceSnapshot.items || []).find(function (row) {
    return row && typeof row.path === 'string' && row.path !== ''
      && Array.isArray(row.sessionIds) && row.sessionIds.includes(current.id)
  })
}

function currentCommitSession(ctx) {
  const sessions = service(ctx, 'sessions')
  const snapshot = sessions && sessions.list && sessions.list.getSnapshot()
  return Object.values(snapshot && snapshot.byId || {}).find(function (row) {
    return row && row.retainedBy && row.retainedBy.mainView > 0
  })
}

function currentCommitInput(ctx) {
  const current = currentCommitSession(ctx)
  const sessions = service(ctx, 'sessions')
  const conversation = service(ctx, 'conversation')
  if (!current || !sessions || typeof sessions.scope !== 'function'
    || !conversation || !conversation.input || typeof conversation.input.for !== 'function') return undefined
  const scope = sessions.scope(current.id)
  return scope === undefined ? undefined : conversation.input.for(scope)
}

module.exports = { normalizePath, newSessionId, workspaceIdForPath, startPlanning, currentCommitWorkspace, currentCommitSession, currentCommitInput }
