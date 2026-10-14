/** Command-palette repository links: registration, safe reads and browser opening. */
const { service } = require('../context.cjs')
const { currentCommitSession } = require('../session.cjs')
const { COMMIT_PALETTE_TAG } = require('./copy.cjs')
const { WEB_GIT_ICON_ID } = require('../icons.cjs')
const REPOSITORY_PALETTE_TAG = Object.freeze({ ...COMMIT_PALETTE_TAG,
  id: 'dsh-git-commit-agent.repository', title: 'Git Web',
  localizedTitles: Object.freeze({ zh: 'Git 远程仓库', en: 'Git Web' }), iconId: WEB_GIT_ICON_ID,
})

async function loadRepositoryLinks(target, signal) {
  const sessionId = target.scope && target.scope.sessionId
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('无法确定仓库所属会话')
  const query = new URLSearchParams({ scope: sessionId })
  for (const key of ['repoRoot', 'worktree']) {
    if (typeof target[key] === 'string' && target[key]) query.set(key, target[key])
  }
  const response = await fetch('/git-commit-agent/api/repository-links?' + query, { credentials: 'same-origin', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error('无法读取远程仓库链接（' + response.status + '）')
  const data = await response.json()
  if (!data || !Array.isArray(data.links)) throw new Error('远程仓库链接响应无效')
  const links = data.links.map(function (link) {
    if (!link || typeof link.name !== 'string' || typeof link.url !== 'string') throw new Error('远程仓库链接响应无效')
    const url = new URL(link.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('远程仓库链接不安全')
    return { name: link.name, url: url.href }
  })
  if (!links.length) throw new Error('没有可转换为 HTTPS 页面地址的 Git remote')
  return links
}

async function openRepositoryLinks(target, tab, signal, choose) {
  try {
    const links = await loadRepositoryLinks(target, signal)
    if (signal && signal.aborted) { if (!tab.closed) tab.close(); return }
    if (tab.closed) return
    const preferred = links.length === 1 ? links[0] : null
    if (preferred) { tab.location.replace(preferred.url); return }
    if (choose) { tab.close(); return choose(links) }
    const document = tab.document
    document.title = '选择远程仓库'
    const heading = document.createElement('h1')
    heading.textContent = '选择远程仓库'
    document.body.replaceChildren(heading)
    for (const link of links) {
      const row = document.createElement('p')
      const anchor = document.createElement('a')
      anchor.href = link.url
      anchor.rel = 'noopener noreferrer'
      anchor.textContent = link.name + ' — ' + link.url
      row.appendChild(anchor)
      document.body.appendChild(row)
    }
  } catch (error) {
    if (!tab.closed) tab.close()
    throw error
  }
}

function english(ctx) {
  const locale = service(ctx, 'locale')
  const snapshot = locale && typeof locale.getSnapshot === 'function' && locale.getSnapshot()
  return Boolean(snapshot && /^en(?:[-_]|$)/i.test(snapshot.active || ''))
}

function currentRepositoryTarget(ctx) {
  const current = currentCommitSession(ctx)
  if (!current) return undefined
  const scope = { sessionId: current.id }
  const sidebar = service(ctx, 'betterSidebar')
  const selected = sidebar && typeof sidebar.getGitCommitTarget === 'function' && sidebar.getGitCommitTarget(scope)
  // Only borrow selectors owned by the active session, never another lens.
  return selected && selected.scope && selected.scope.sessionId === current.id
    ? { scope, repoRoot: selected.repoRoot, worktree: selected.worktree }
    : { scope }
}

// Desktop denies renderer popups and forwards only final HTTP(S) URLs to
// shell.openExternal. A null WindowProxy is expected there, not an error.
function desktopExternalOpening() {
  return typeof window !== 'undefined' && ('dshDesktop' in window || 'dshDesktopShell' in window)
}

function registerRepositoryLinkCommand(ctx, palette) {
  const pickerId = 'dsh-git-commit-agent.repository-remotes'
  let selection
  const canChoose = typeof palette.registerPicker === 'function' && typeof palette.openPicker === 'function'
  const offPicker = canChoose ? palette.registerPicker({
    id: pickerId,
    describe: function () {
      const en = english(ctx)
      return { title: en ? 'Choose Remote Repository' : '选择远程仓库', placeholder: en ? 'Search remotes' : '搜索远程仓库', emptyText: en ? 'No matching remotes' : '没有匹配的远程仓库' }
    },
    queryMode: 'local',
    query: function (args) {
      const query = args.query.toLowerCase()
      return { items: (selection ? selection.links : []).filter(function (link) {
        return (link.name + ' ' + link.url).toLowerCase().includes(query)
      }).map(function (link) { return { id: JSON.stringify([link.name, link.url]), label: link.name, detail: link.url } }), hasMore: false }
    },
    accept: function (id, args) {
      if (args.signal.aborted) return { kind: 'cancelled' }
      const link = selection && selection.links.find(function (candidate) { return JSON.stringify([candidate.name, candidate.url]) === id })
      if (!link || JSON.stringify(currentRepositoryTarget(ctx)) !== selection.targetKey) {
        return { kind: 'failed', message: english(ctx) ? 'Repository selection expired; run the command again' : '仓库选择已失效，请重新执行命令' }
      }
      if (desktopExternalOpening()) {
        window.open(link.url, '_blank', 'noopener,noreferrer')
      } else {
        const tab = window.open('about:blank', '_blank')
        if (!tab) return { kind: 'failed', message: english(ctx) ? 'Allow browser popups and try again' : '浏览器阻止了新标签页，请允许弹出窗口后重试' }
        tab.opener = null
        tab.location.replace(link.url)
      }
      selection = undefined
      return { kind: 'completed', message: desktopExternalOpening()
        ? english(ctx) ? 'Requested opening in the default browser' : '已请求默认浏览器打开远程仓库'
        : english(ctx) ? 'Remote repository opened' : '已打开远程仓库' }
    },
  }) : undefined
  let offCommand
  try {
    offCommand = palette.registerCommand({
      id: 'dsh-git-commit-agent.open-repository',
      describe: function () {
        const en = english(ctx)
        return {
          title: en ? 'Open Remote Repository' : '打开远程仓库',
          localizedTitles: { zh: '打开远程仓库', en: 'Open Remote Repository' },
          category: 'Git', pluginTag: REPOSITORY_PALETTE_TAG, iconId: WEB_GIT_ICON_ID,
          aliases: ['git', 'remote', 'repository', 'repo', 'https', '仓库', '远程仓库', '打开项目'],
          disabledReason: currentRepositoryTarget(ctx) ? undefined : en ? 'No active session' : '没有当前会话',
        }
      },
      target: {
        kind: 'action',
        execute: async function (args) {
          if (args.signal.aborted) return { kind: 'cancelled' }
          const target = currentRepositoryTarget(ctx)
          if (!target) return { kind: 'failed', message: english(ctx) ? 'No active session' : '没有当前会话' }
          let tab
          const choose = function (links) {
            if (!canChoose) return { kind: 'failed', message: english(ctx) ? 'Remote selection is unavailable in this command palette' : '当前命令面板不支持选择远程仓库' }
            selection = { links, targetKey: JSON.stringify(target) }
            if (!palette.openPicker(pickerId)) { selection = undefined; return { kind: 'failed', message: english(ctx) ? 'Cannot open remote selection' : '无法打开远程仓库选择' } }
            return { kind: 'stay' }
          }
          try {
            if (desktopExternalOpening()) {
              const links = await loadRepositoryLinks(target, args.signal)
              if (args.signal.aborted) return { kind: 'cancelled' }
              if (JSON.stringify(currentRepositoryTarget(ctx)) !== JSON.stringify(target)) return { kind: 'cancelled' }
              const preferred = links.length === 1 ? links[0] : null
              if (preferred) {
                window.open(preferred.url, '_blank', 'noopener,noreferrer')
                return { kind: 'completed', message: english(ctx) ? 'Requested opening in the default browser' : '已请求默认浏览器打开远程仓库' }
              }
              return choose(links)
            }
            tab = window.open('about:blank', '_blank')
            if (!tab) throw new Error(english(ctx) ? 'Allow browser popups and try again' : '浏览器阻止了新标签页，请允许弹出窗口后重试')
            tab.opener = null
            const result = await openRepositoryLinks(target, tab, args.signal, canChoose ? choose : undefined)
            if (result) return result
            return args.signal.aborted ? { kind: 'cancelled' } : { kind: 'completed', message: english(ctx) ? 'Remote repository opened' : '已打开远程仓库' }
          } catch (error) {
            if (tab && !tab.closed) tab.close()
            return args.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
          }
        },
      },
    })
  } catch (error) {
    if (offPicker) offPicker()
    throw error
  }
  return function () {
    selection = undefined
    try { offCommand() } finally { if (offPicker) offPicker() }
  }
}

module.exports = { registerRepositoryLinkCommand, loadRepositoryLinks, openRepositoryLinks }
