/** Scoped proposed diffs, Inspector/legacy tab lifecycle and mounted-seat observation. */
const { h } = require('./runtime.cjs')
const { service } = require('./context.cjs')
const { DIFF_ID_PREFIX, SESSION_ID_PREFIX } = require('./constants.cjs')
const { planIdentity, planKind, planResource, resourceIdentity } = require('./plan-model.cjs')
const { PlanPage, RecentPlans } = require('./plan-views.cjs')
/**
 * Open one planned commit's diff in the sidebar's DiffPane.
 *
 * The tab identity is scoped to task-independent key + planId + REVISION +
 * commitId so two revisions of the same plan never collide in the bottom
 * workbench's dedupe. The title states the revision, so a re-opened tab is
 * recognisable even when several revisions were reviewed in a row. An
 * explicit scope targets the initiating session's sidebar state instead of
 * whatever session happens to be active.
 */
function openPlanDiff(ctx, planId, revision, block, sessionId) {
  const sidebar = service(ctx, 'betterSidebar')
  if (!sidebar || typeof sidebar.openTab !== 'function') return false
  const id = DIFF_ID_PREFIX + ':' + planId + ':' + revision + ':' + block.commitId
  const subject = String(block.message || '').split('\n')[0]
  const title = '计划 v' + String(revision) + ' · ' + block.commitId + ' · ' + subject
  // Integrity metadata for the sidebar (display-only): `truncated` marks a
  // capped preview, `sourceRef` labels what snapshot this patch is, so a
  // stale tab stays identifiable after later revisions.
  const diff = {
    kind: 'proposed',
    id: id,
    title: title,
    patch: block.patch || '',
    ...(block.patchTruncated === true ? { truncated: true } : {}),
    ...(typeof planId === 'string' ? { sourceRef: 'plan ' + planId + ' rev ' + String(revision) } : {}),
  }
  const seed = { type: 'diff', id: id, title: title, diff: diff }
  const scope = typeof sessionId === 'string' && sessionId !== '' ? { sessionId: sessionId } : undefined
  sidebar.openTab(seed, scope)
  return true
}

function createPlanSidebar(ctx) {
  const sidebar = service(ctx, 'betterSidebar')
  const registered = new Map()
  const inspectors = sidebar && Array.isArray(sidebar.features) && sidebar.features.indexOf('inspectors') >= 0
    && typeof sidebar.registerInspector === 'function' && typeof sidebar.openInspector === 'function'
  const snapshots = new Map()
  function openIdentity(identity, location) {
    return sidebar.openInspector({ type: 'dsh-gca-plan', id: planKind(identity), title: '提交计划 v' + identity[3],
      resource: planResource(identity), location: location || { section: 'overview' } }) !== false
  }
  if (inspectors) {
    registered.set('inspector:plan', sidebar.registerInspector({ id: 'dsh-gca-plan', title: '提交计划',
      component: function (props) {
        const identity = resourceIdentity(props.resource)
        if (!identity) return h('p', { role: 'alert' }, '计划引用无效')
        return h(PlanPage, { key: planKind(identity), identity: identity, initial: snapshots.get(planKind(identity)), ctx: ctx,
          location: props.location, navigate: function (location) { openIdentity(identity, location) } })
      } }))
    registered.set('inspector:list', sidebar.registerInspector({ id: 'dsh-gca-plans', title: '提交计划', entry: true,
      component: function () { return h(RecentPlans, { open: function (resource) {
        const identity = resourceIdentity(resource)
        if (identity) openIdentity(identity)
      } }) } }))
  }
  function register(meta, sessionId) {
    const identity = planIdentity(meta, sessionId)
    if (!identity || !sidebar) return null
    const kind = planKind(identity)
    if (inspectors) {
      snapshots.delete(kind)
      snapshots.set(kind, meta)
      if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value)
      return kind
    }
    if (typeof sidebar.registerTab !== 'function') return null
    if (!registered.has(kind)) {
      const dispose = sidebar.registerTab({ id: kind, hidden: true,
        title: '提交计划 v' + identity[3],
        component: function (props) {
          // Identity lives in this descriptor's stable kind, never native params.
          if (!props.scope || props.scope.sessionId !== identity[0]) return h('p', null, '计划不属于当前会话')
          return h(PlanPage, { identity: identity, initial: meta, ctx: ctx })
        } })
      registered.set(kind, dispose)
    }
    return kind
  }
  return {
    register: register,
    automaticReveal: !inspectors,
    open: function (meta, sessionId, location) {
      const kind = register(meta, sessionId)
      if (!kind) return false
      if (inspectors) return openIdentity(planIdentity(meta, sessionId), location)
      sidebar.openTab({ type: kind, id: kind, title: '提交计划 v' + meta.revision }, { sessionId: sessionId })
      return true
    },
    dispose: function () { registered.forEach(function (dispose) { if (typeof dispose === 'function') dispose() }); registered.clear(); snapshots.clear() },
  }
}

// Poll a plugin-owned durable, authenticated read route. The public mounted
// seat is the only focus authority. Every new seat gets a historical baseline;
// pagination, transcript mounts and replays cannot trigger an automatic open.
function observePlans(ctx, plans, options) {
  options = options || {}
  // Stable Inspector types recover on demand; do not repeatedly download all historical patches.
  if (plans.automaticReveal === false) return function () {}
  const mounted = service(ctx, 'sidebarRight') && service(ctx, 'sidebarRight').mounted
  if (!mounted || typeof mounted.subscribe !== 'function' || typeof mounted.getSnapshot !== 'function') return function () {}
  const request = options.fetch || fetch
  const schedule = options.setTimeout || setTimeout
  const cancel = options.clearTimeout || clearTimeout
  let generation = 0, timer, controller, disposed = false
  function change() {
    const epoch = ++generation
    if (timer !== undefined) cancel(timer)
    if (controller) controller.abort()
    const sessionId = mounted.getSnapshot()
    if (typeof sessionId !== 'string' || !sessionId.startsWith(SESSION_ID_PREFIX)) return
    let baseline = true
    const seen = new Set()
    async function poll() {
      controller = new AbortController()
      try {
        const res = await request('/git-commit-agent/api/plans?sessionId=' + encodeURIComponent(sessionId),
          { credentials: 'same-origin', signal: controller.signal })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const payload = await res.json()
        if (disposed || epoch !== generation || mounted.getSnapshot() !== sessionId) return
        if (payload.sessionId !== sessionId || !Array.isArray(payload.plans)) throw new Error('Invalid plan list')
        const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
        payload.plans.forEach(function (meta) {
          const identity = planIdentity(meta, sessionId)
          if (!identity) return
          const key = planKind(identity)
          plans.register(meta, sessionId)
          if (!seen.has(key) && !baseline && visible && plans.automaticReveal !== false) plans.open(meta, sessionId)
          seen.add(key)
        })
        baseline = false
      } catch (_) { /* Read failure must never become approval or focus. Retry in this seat. */ }
      if (!disposed && epoch === generation) timer = schedule(poll, 2000)
    }
    void poll()
  }
  const unsubscribe = mounted.subscribe(change)
  change()
  return function () { disposed = true; generation++; unsubscribe(); if (timer !== undefined) cancel(timer); if (controller) controller.abort() }
}

module.exports = { openPlanDiff, createPlanSidebar, observePlans }
