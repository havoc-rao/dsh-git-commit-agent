/** Read-only full-plan and paginated recent-plan views with durable snapshot recovery. */
const { React, h } = require('./runtime.cjs')
const { service } = require('./context.cjs')
const { STATUS_SYMBOLS, layerLabel, statText, planIdentity, planKind, planUrl } = require('./plan-model.cjs')
function FullPlan(props) {
  const meta = props.meta
  const commits = Array.isArray(meta.commits) ? meta.commits : []
  const preview = Array.isArray(meta.preview) ? meta.preview : []
  const details = meta.reviewDetail && Array.isArray(meta.reviewDetail.commits) ? meta.reviewDetail.commits : []
  const sections = commits.length ? commits : preview.map(function (p) { return { id: p.commitId, message: p.message } })
  const location = props.location || { section: 'overview' }
  const root = React.useRef(null)
  const navigate = props.navigate || function () {}
  const [copyError, setCopyError] = React.useState('')
  function copyMessage(message) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) { setCopyError('当前环境无法复制，请选择提交消息手动复制'); return }
    navigator.clipboard.writeText(String(message || '')).then(function () { setCopyError('') }, function () { setCopyError('复制失败，请选择提交消息手动复制') })
  }
  if (React.useEffect) React.useEffect(function () {
    if (!root.current) return
    const targets = root.current.querySelectorAll('[data-plan-section]')
    const key = location.section === 'commit' ? 'commit:' + location.commitId : location.section
    Array.prototype.forEach.call(targets, function (node) {
      if (node.getAttribute('data-plan-section') === key) node.scrollIntoView({ block: 'start' })
    })
  }, [location.section, location.commitId, location.view])
  return h('article', { ref: root, className: 'dsh-gca-card dsh-gca-plan-page' },
    h('nav', { 'aria-label': '计划导航' }, ['overview', 'excluded', 'delta'].map(function (section, i) {
      return h('button', { key: section, type: 'button', onClick: function () { navigate({ section: section }) } }, ['概览', '未纳入', '修订变化'][i])
    })),
    h('div', { 'data-plan-section': 'overview' }),
    h('nav', { 'aria-label': '提交索引' }, sections.map(function (c, i) {
      return h('button', { key: c.id, type: 'button', onClick: function () { navigate({ section: 'commit', commitId: c.id, view: 'details' }) } }, (i + 1) + '. ' + String(c.message || '').split('\n')[0])
    })),
    h('h4', null, '完整提交计划 · revision ' + meta.revision),
    copyError ? h('p', { role: 'alert' }, copyError) : null,
    h('button', { type: 'button', onClick: function () {
      const sessions = service(props.ctx, 'sessions')
      const workspace = service(props.ctx, 'uiWorkspace')
      if (workspace && typeof workspace.openSession === 'function') workspace.openSession(props.sessionId)
      else if (sessions && typeof sessions.open === 'function') sessions.open(props.sessionId)
    } }, '打开来源会话'),
    h('p', null, '只读历史计划；此页面不会发起审批或执行提交。发布时状态：' + String(meta.status || 'prepared')),
    h('details', null, h('summary', null, '计划标识与技术信息'),
      h('div', { className: 'dsh-gca-identity' }, '来源会话 ' + props.sessionId + '\ntask ' + meta.taskId + '\nplan ' + meta.planId
        + '\nrevision ' + meta.revision + '\ndigest ' + meta.planDigest)),
    h('p', null, '索引策略：' + String(meta.indexStrategy || '')),
    (meta.blockers || []).map(function (b, i) { return h('p', { key: 'b' + i, className: 'dsh-gca-blocker' },
      '阻塞：' + b.code + ' — ' + b.message + (b.subject ? ' · ' + b.subject : '')) }),
    (meta.warnings || []).map(function (w, i) { return h('p', { key: 'w' + i }, '注意：' + String(w)) }),
    sections.map(function (c, i) {
      const p = preview.find(function (p) { return p.commitId === c.id }) || {}
      const d = details.find(function (d) { return d.id === c.id }) || {}
      const files = p.changes || d.changes || c.files || []
      return h('section', { key: c.id || i, 'data-plan-section': 'commit:' + c.id,
        'data-plan-selected': location.section === 'commit' && location.commitId === c.id ? '' : undefined },
        h('h4', null, (i + 1) + '. ' + String(c.id || p.commitId)),
        h('pre', null, String(c.message || p.message || d.message || '')),
        h('button', { type: 'button', onClick: function () { copyMessage(c.message || p.message || d.message) } }, '复制提交消息'),
        h('p', null, '分组理由：' + String(c.rationale || p.rationale || d.rationale || '未提供')),
        h('div', null, '依赖：', (c.dependsOn || p.dependsOn || []).length ? (c.dependsOn || p.dependsOn).map(function (id) {
          const dependency = sections.find(function (item) { return item.id === id })
          return h('button', { key: id, type: 'button', onClick: function () { navigate({ section: 'commit', commitId: id, view: 'details' }) } }, dependency ? String(dependency.message || id).split('\n')[0] : id)
        }) : '无'),
        h('p', null, statText(p.stat || d.stat || c.stat)),
        h('ul', { className: 'dsh-gca-files' }, files.map(function (f, j) {
          return h('li', { key: f.changeId || j }, (STATUS_SYMBOLS[f.status] || '?') + ' ' + layerLabel(f.layer)
            + ' · ' + (f.oldPath ? f.oldPath + ' → ' : '') + String(f.path || f.changeId || f)
            + (f.binary ? ' [二进制]' : ''))
        })),
        h('button', { type: 'button', disabled: typeof p.patch !== 'string', onClick: function () {
          navigate({ section: 'commit', commitId: c.id, view: location.view === 'diff' && location.commitId === c.id ? 'details' : 'diff' })
        } }, location.view === 'diff' && location.commitId === c.id ? '返回明细' : '查看差异'),
        location.view === 'diff' && location.commitId === c.id && typeof p.patch === 'string'
          ? h('pre', { className: 'dsh-gca-identity', 'aria-label': '发布时差异快照' }, p.patch) : null,
        p.patchTruncated ? h('p', null, '差异预览已截断；文件清单与统计完整。') : null,
        typeof p.patch !== 'string' ? h('p', null, '此历史版本未保存差异预览；不会重新计算已提交工作区。') : null)
    }),
    h('h4', { 'data-plan-section': 'excluded' }, '暂不提交'),
    h('ul', null, (meta.excludedChanges || []).map(function (e, i) {
      return h('li', { key: e.changeId || i }, String(e.path) + ' — ' + String(e.reason))
    })),
    meta.delta ? h('details', { 'data-plan-section': 'delta', open: location.section === 'delta' ? true : undefined }, h('summary', null, '相对上一修订的变更'),
      h('pre', null, JSON.stringify(meta.delta, null, 2))) : null)
}

function PlanPage(props) {
  const identity = props.identity
  const [state, setState] = React.useState({ meta: props.initial || null, error: '' })
  const [attempt, retry] = React.useState(0)
  const [localLocation, setLocalLocation] = React.useState({ section: 'overview' })
  React.useEffect(function () {
    const controller = new AbortController()
    fetch(planUrl(identity), { credentials: 'same-origin', signal: controller.signal }).then(function (res) {
      if (!res.ok) throw new Error('读取历史计划失败（HTTP ' + res.status + '）')
      return res.json()
    }).then(function (meta) {
      const restored = planIdentity(meta, identity[0])
      if (!restored || planKind(restored) !== planKind(identity)) throw new Error('计划身份校验失败')
      if (!controller.signal.aborted) setState({ meta: meta, error: '' })
    }).catch(function (err) {
      if (!controller.signal.aborted) setState(function (s) { return { meta: s.meta, error: String(err.message || err) } })
    })
    return function () { controller.abort() }
  }, [planKind(identity), attempt])
  return h('div', { className: 'dsh-gca-plan-scroll' },
    state.error ? h('div', { role: 'alert' }, state.error,
      state.meta ? h('p', null, '当前显示内存中的发布快照；持久化恢复尚未确认。') : null,
      h('button', { type: 'button', onClick: function () { retry(function (n) { return n + 1 }) } }, '重试')) : null,
    state.meta ? h(FullPlan, { meta: state.meta, ctx: props.ctx, sessionId: identity[0], location: props.location || localLocation, navigate: props.navigate || setLocalLocation })
      : state.error ? h('p', null, '历史计划暂不可用；不会从当前工作树重新生成。') : h('p', null, '正在恢复历史计划…'))
}

function RecentPlans(props) {
  const [state, setState] = React.useState({ plans: [], error: '', hasMore: false, loading: true })
  const [attempt, retry] = React.useState(0)
  const [offset, setOffset] = React.useState(0)
  const [workspace, setWorkspace] = React.useState('')
  React.useEffect(function () {
    const controller = new AbortController()
    setState(function (previous) { return Object.assign({}, previous, { loading: true }) })
    const query = new URLSearchParams({ limit: '50', offset: String(offset) })
    if (workspace) query.set('workspaceRoot', workspace)
    fetch('/git-commit-agent/api/plan-index?' + query, { credentials: 'same-origin', signal: controller.signal })
      .then(function (res) { if (!res.ok) throw new Error('读取计划列表失败（HTTP ' + res.status + '）'); return res.json() })
      .then(function (payload) {
        if (payload.schemaVersion !== 1 || !Array.isArray(payload.plans)) throw new Error('计划索引格式无效')
        if (!controller.signal.aborted) setState({ plans: payload.plans, error: '', hasMore: payload.hasMore === true })
      }).catch(function (err) { if (!controller.signal.aborted) setState({ plans: [], error: String(err.message || err), hasMore: false }) })
    return function () { controller.abort() }
  }, [attempt, offset, workspace])
  return h('div', { className: 'dsh-gca-plan-scroll' },
    h('h4', null, '最近提交计划'),
    h('p', null, '只读浏览；打开计划不会激活会话或执行提交。'),
    h('label', null, '工作树路径筛选 ', h('input', { value: workspace, placeholder: '全部工作区', onChange: function (e) { setWorkspace(e.target.value); setOffset(0) } })),
    h('button', { type: 'button', onClick: function () { retry(function (n) { return n + 1 }) } }, '刷新'),
    state.error ? h('p', { role: 'alert' }, state.error) : null,
    state.loading ? h('p', { role: 'status' }, '正在读取最近计划…') : null,
    !state.loading && !state.error && !state.plans.length ? h('p', null, '暂无可恢复的计划') : null,
    h('ol', null, state.plans.map(function (row) {
      return h('li', { key: JSON.stringify([row.sourceSessionId, row.taskId, row.planId, row.revision, row.digest]) },
        h('button', { type: 'button', onClick: function () { props.open(row) } }, 'v' + row.revision + ' · ' + row.commitCount + ' 个提交'),
        h('p', null, row.worktreePath + ' · ' + String(row.branch || '') + ' · ' + row.createdAt),
        h('small', null, 'task ' + row.taskId + ' · 来源 ' + row.sourceSessionId))
    })),
    offset > 0 ? h('button', { type: 'button', onClick: function () { setOffset(Math.max(0, offset - 50)) } }, '上一页') : null,
    state.hasMore ? h('button', { type: 'button', onClick: function () { setOffset(offset + 50) } }, '下一页') : null)
}

module.exports = { FullPlan, PlanPage, RecentPlans }
