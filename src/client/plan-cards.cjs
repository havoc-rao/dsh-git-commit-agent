/** Transcript plan review and approval/execution result cards; no approval authority. */
const { React, h } = require('./runtime.cjs')
const { planMetaOf, STATUS_SYMBOLS, layerLabel, statText } = require('./plan-model.cjs')
/** The transcript card for one published plan. */
function PlanCard(props) {
  const block = props.block
  const meta = planMetaOf(block)
  const openDiff = props.openDiff
  const sessionId = props.sessionId
  if (meta === null) {
    return h('div', { className: 'dsh-gca-card' }, '正在整理提交计划…')
  }
  const blockers = Array.isArray(meta.blockers) ? meta.blockers : []
  const warnings = Array.isArray(meta.warnings) ? meta.warnings : []
  const preview = Array.isArray(meta.preview) ? meta.preview : []
  const excluded = Array.isArray(meta.excludedChanges) ? meta.excludedChanges : []
  const commits = Array.isArray(meta.commits) ? meta.commits : []
  // Subject lookup across the whole plan (used for readable dependsOn).
  const subjectOf = function (commitId) {
    const found = commits.find(function (commit) { return commit.id === commitId })
    if (found) return String(found.message || '').split('\n')[0]
    const entry = preview.find(function (item) { return item.commitId === commitId })
    return entry ? String(entry.message || '').split('\n')[0] : commitId
  }
  const indexOf = function (commitId) {
    const index = preview.findIndex(function (entry) { return entry.commitId === commitId })
    return index < 0 ? '' : String(index + 1) + ' '
  }
  // Expanded sections, keyed per card instance.
  const [expanded, setExpanded] = React.useState({})
  const toggle = function (key) {
    setExpanded(function (current) {
      const next = Object.assign({}, current)
      if (next[key] === true) delete next[key]
      else next[key] = true
      return next
    })
  }
  const isOpen = function (key) { return expanded[key] === true }

  const totalFiles = preview.reduce(function (sum, entry) {
    const stat = entry.stat && typeof entry.stat === 'object' ? entry.stat : null
    return sum + (stat !== null ? Number(stat.files) || 0 : Array.isArray(entry.changes) ? entry.changes.length : 0)
  }, 0)
  const truncated = meta.previewTruncated === true

  const children = [
    props.openPlan ? h('button', { key: 'full-plan', type: 'button', onClick: function () {
      props.openPlan(meta, sessionId)
    } }, '在侧栏查看完整计划') : null,
    h(
      'h4',
      { key: 'title' },
      '提交计划 revision ' + String(meta.revision) + ' — ' + preview.length + ' 个提交'
        + (totalFiles > 0 ? ' · ' + totalFiles + ' 个文件' : ''),
    ),
  ]
  if (blockers.length > 0) {
    children.push(
      h(
        'div',
        { key: 'blockers', className: 'dsh-gca-blocker' },
        blockers.map(function (blocker, index) {
          return h('div', { key: index }, '阻塞：' + String(blocker.code) + ' — ' + String(blocker.message))
        }),
      ),
    )
  }
  children.push(
    h(
      'ol',
      { key: 'commits' },
      preview.map(function (entry, index) {
        const subject = String(entry.message || '').split('\n')[0]
        const stat = entry.stat && typeof entry.stat === 'object' ? entry.stat : null
        const rowChildren = [
          h('span', { key: 'index' }, String(index + 1) + ' ' + subject),
          stat !== null ? h('span', { key: 'stat', className: 'dsh-gca-stat' }, statText(stat)) : null,
          entry.patchTruncated === true ? h('span', { key: 'note', className: 'dsh-gca-note' }, '部分预览') : null,
          h(
            'button',
            {
              key: 'details',
              type: 'button',
              onClick: function () {
                if (!props.openPlan || props.openPlan(meta, sessionId, { section: 'commit', commitId: entry.commitId, view: 'details' }) === false)
                  toggle('details:' + entry.commitId)
              },
            },
            isOpen('details:' + entry.commitId) ? '收起明细' : '明细',
          ),
          h(
            'button',
            {
              key: 'diff',
              type: 'button',
              onClick: function () {
                if (!props.openPlan || props.openPlan(meta, sessionId, { section: 'commit', commitId: entry.commitId, view: 'diff' }) === false)
                  openDiff(Object.assign({}, entry, { planId: meta.planId, revision: meta.revision }), sessionId)
              },
            },
            '查看差异',
          ),
        ]
        const detailRows = []
        if (entry.rationale && String(entry.rationale).trim() !== '') {
          detailRows.push(h('div', { key: 'rationale' }, String(entry.rationale).trim()))
        }
        const depends = Array.isArray(entry.dependsOn) ? entry.dependsOn : []
        if (depends.length > 0) {
          detailRows.push(
            h(
              'div',
              { key: 'depends' },
              '依赖：' + depends.map(function (dep) { return indexOf(dep) + subjectOf(dep) }).join('，'),
            ),
          )
        }
        const files = Array.isArray(entry.changes) ? entry.changes : []
        detailRows.push(
          h(
            'ul',
            { key: 'files', className: 'dsh-gca-files' },
            files.map(function (change) {
              // VSCode-style status symbol + layer, e.g. `M 未暂存`.
              const symbol = STATUS_SYMBOLS[change.status] || '?'
              const rename = change.oldPath ? String(change.oldPath) + ' → ' : ''
              const marker = change.binary === true ? ' [二进制]' : ''
              return h(
                'li',
                { key: change.changeId || change.path },
                symbol + ' ' + layerLabel(change.layer) + ' · ' + rename + change.path + marker,
              )
            }),
          ),
        )
        return h(
          'li',
          { key: entry.commitId || index },
          h('div', { className: 'dsh-gca-row' }, rowChildren),
          // Hidden via CSS while collapsed so the DOM always carries the
          // details.
          h(
            'div',
            { className: isOpen('details:' + entry.commitId) ? 'dsh-gca-details' : 'dsh-gca-details dsh-gca-hidden' },
            detailRows,
          ),
        )
      }),
    ),
  )
  if (warnings.length > 0) {
    children.push(
      h(
        'div',
        { key: 'warnings', className: 'dsh-gca-warning' },
        warnings.map(function (warning, index) {
          return h('div', { key: index }, '注意：' + String(warning))
        }),
      ),
    )
  }
  // What changed since the previous revision of this plan.
  const deltaEntries = meta.delta
    && typeof meta.delta === 'object'
    && Array.isArray(meta.delta.entries)
    ? meta.delta.entries
    : []
  if (deltaEntries.length > 0) {
    const describe = function (entry) {
      const path = typeof entry.path === 'string' ? entry.path : null
      const target = typeof entry.commitId === 'string' ? indexOf(entry.commitId).trim() : ''
      const from = typeof entry.fromCommitId === 'string' ? entry.fromCommitId : null
      switch (entry.kind) {
        case 'commit-added': return '新增提交 ' + target
        case 'file-added': return (path || '文件') + ' 加入提交 ' + target
        case 'file-moved': return (path || '文件') + ' 从提交 ' + (from || '?') + ' 移入提交 ' + target
        case 'file-excluded': return (path || '文件') + ' 变为暂不提交' + (from !== null ? '（原在提交 ' + from + '）' : '')
        case 'message-changed': return '提交 ' + target + ' 的消息已更新'
        default: return String(entry.kind || '')
      }
    }
    children.push(
      h(
        'div',
        { key: 'delta' },
        h(
          'button',
          { type: 'button', onClick: function () { toggle('delta') } },
          '相对上一版（rev ' + String(meta.delta.fromRevision) + '）' + deltaEntries.length + ' 项'
            + (isOpen('delta') ? '（收起）' : ''),
        ),
        h(
          'ul',
          { className: isOpen('delta') ? 'dsh-gca-files' : 'dsh-gca-files dsh-gca-hidden' },
          deltaEntries.map(function (entry, index) {
            return h('li', { key: index }, describe(entry))
          }),
        ),
      ),
    )
  }
  if (excluded.length > 0) {
    children.push(
      h(
        'div',
        { key: 'excluded' },
        h(
          'button',
          { type: 'button', onClick: function () { toggle('excluded') } },
          '暂不提交 ' + excluded.length + ' 项' + (isOpen('excluded') ? '（收起）' : ''),
        ),
        h(
          'ul',
          { className: isOpen('excluded') ? 'dsh-gca-files' : 'dsh-gca-files dsh-gca-hidden' },
          excluded.map(function (entry, index) {
            return h('li', { key: entry.changeId || index }, String(entry.path) + ' — ' + String(entry.reason))
          }),
        ),
      ),
    )
  }
  if (truncated) {
    children.push(
      h(
        'div',
        { key: 'truncated', className: 'dsh-gca-note' },
        '部分提交的差异预览因体积限制被截断；统计与文件清单仍然完整，完整差异可按需读取。',
      ),
    )
  }
  children.push(
    h(
      'div',
      { key: 'meta', className: 'dsh-gca-meta' },
      (meta.indexStrategy === 'reuse-existing-index' ? '复用已暂存内容（首个提交包含全部已暂存变更） · ' : '')
        + (blockers.length === 0 ? '等待你在审批面板中确认' : '请先解决阻塞项'),
    ),
  )
  children.push(
    h(
      'details',
      { key: 'tech', className: 'dsh-gca-meta' },
      h('summary', null, '技术信息'),
      h(
        'div',
        null,
        h('div', null, 'plan ' + String(meta.planId) + ' · digest ' + String(meta.planDigest || '').slice(0, 16) + '…'),
        preview.map(function (entry, index) {
          return h(
            'div',
            { key: entry.commitId || index },
            String(index + 1) + ' ' + entry.commitId + '：tree ' + String(entry.baseTree || '').slice(0, 12)
              + ' → ' + String(entry.expectedTree || '').slice(0, 12),
          )
        }),
      ),
    ),
  )
  return h('div', { className: 'dsh-gca-card' }, children)
}

/** A compact card for the apply_plan result (approval decision + execution). */
function ApplyCard(props) {
  const block = props.block
  const meta = block && block.meta
  if (!meta || typeof meta !== 'object') {
    return h('div', { className: 'dsh-gca-card' }, '等待审批结果…')
  }
  const approved = meta.approved === true
  const children = [
    h('h4', { key: 'title' }, approved ? '计划已获批准' : '计划未获批准'),
    h(
      'div',
      { key: 'meta', className: 'dsh-gca-meta' },
      'plan ' + String(meta.planId) + ' revision ' + String(meta.revision),
    ),
  ]
  if (approved) {
    const commits = Array.isArray(meta.commits) ? meta.commits : []
    const failure = meta.failure && typeof meta.failure === 'object' ? meta.failure : null
    children.push(
      h(
        'div',
        { key: 'outcome', className: 'dsh-gca-meta' },
        'execution ' + String(meta.outcome || '') + ' · ' + commits.length + ' 个提交'
          + (failure !== null ? ' · 失败于 ' + String(failure.stage || '') : ''),
      ),
    )
  }
  return h('div', { className: 'dsh-gca-card' }, children)
}

module.exports = { PlanCard, ApplyCard }
