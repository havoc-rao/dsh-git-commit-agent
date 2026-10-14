/** Command-palette repository links: registration, safe reads and browser opening. */
const { service } = require('../context.cjs')
const { currentCommitSession } = require('../session.cjs')
const { COMMIT_PALETTE_TAG } = require('./copy.cjs')

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

async function openRepositoryLinks(target, tab, signal) {
  try {
    const links = await loadRepositoryLinks(target, signal)
    if (signal && signal.aborted) { if (!tab.closed) tab.close(); return }
    if (tab.closed) return
    const preferred = links.find(function (link) { return link.name === 'origin' }) || (links.length === 1 ? links[0] : null)
    if (preferred) { tab.location.replace(preferred.url); return }
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

function registerRepositoryLinkCommand(ctx, palette) {
  return palette.registerCommand({
    id: 'dsh-git-commit-agent.open-repository',
    describe: function () {
      const en = english(ctx)
      return {
        title: en ? 'Open Remote Repository' : '打开远程仓库',
        localizedTitles: { zh: '打开远程仓库', en: 'Open Remote Repository' },
        category: 'Git', pluginTag: COMMIT_PALETTE_TAG,
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
        try {
          tab = window.open('about:blank', '_blank')
          if (!tab) throw new Error(english(ctx) ? 'Allow browser popups and try again' : '浏览器阻止了新标签页，请允许弹出窗口后重试')
          tab.opener = null
          await openRepositoryLinks(target, tab, args.signal)
          return args.signal.aborted ? { kind: 'cancelled' } : { kind: 'completed', message: english(ctx) ? 'Remote repository opened' : '已打开远程仓库' }
        } catch (error) {
          if (tab && !tab.closed) tab.close()
          return args.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
        }
      },
    },
  })
}

module.exports = { registerRepositoryLinkCommand, loadRepositoryLinks, openRepositoryLinks }
