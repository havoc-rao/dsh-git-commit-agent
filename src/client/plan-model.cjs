/** Plan metadata guards, immutable resource addresses and shared presentation helpers. */

/** Read the plan summary the host attached to a tool result. */
function planMetaOf(block) {
  if (!block || typeof block !== 'object') return null
  const meta = block.meta
  if (!meta || typeof meta !== 'object') return null
  if (!Array.isArray(meta.preview)) return null
  return meta
}

/** Git/VSCode status symbols (the characters the source-control pane
 *  shows; `status -s` porcelain uses the same letters). */
const STATUS_SYMBOLS = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  unmerged: 'U',
  untracked: '?',
  unknown: '!',
}

/** Readable layer label. */
function layerLabel(layer) {
  if (layer === 'index') return '已暂存'
  if (layer === 'worktree') return '未暂存'
  return '未跟踪'
}

/** `3 文件 · +82/-16` from a preview stat, or an empty string. */
function statText(stat) {
  if (!stat || typeof stat !== 'object') return ''
  const files = Number(stat.files) || 0
  const additions = Number(stat.additions) || 0
  const deletions = Number(stat.deletions) || 0
  return files + ' 文件 · +' + additions + '/-' + deletions
}

// Stable kind is the native page address identity; seed.id/path/meta are not
// cold-restored by better-sidebar. No createTab: repeated opens dedupe.
function planIdentity(meta, sessionId) {
  if (!meta || typeof sessionId !== 'string' || !sessionId
    || typeof meta.taskId !== 'string' || !meta.taskId || typeof meta.planId !== 'string' || !meta.planId
    || !Number.isSafeInteger(meta.revision) || meta.revision < 1
    || typeof meta.planDigest !== 'string' || !meta.planDigest) return null
  return [sessionId, meta.taskId, meta.planId, meta.revision, meta.planDigest]
}

function planKind(identity) {
  return 'dsh-gca-plan-' + encodeURIComponent(JSON.stringify(identity))
}

function planUrl(identity) {
  const query = new URLSearchParams({ sessionId: identity[0], taskId: identity[1],
    planId: identity[2], revision: String(identity[3]), digest: identity[4] })
  return '/git-commit-agent/api/plan?' + query.toString()
}

function planResource(identity) {
  return { sourceSessionId: identity[0], taskId: identity[1], planId: identity[2], revision: identity[3], digest: identity[4] }
}

function resourceIdentity(resource) {
  return resource && planIdentity({ taskId: resource.taskId, planId: resource.planId,
    revision: resource.revision, planDigest: resource.digest }, resource.sourceSessionId)
}

module.exports = { planMetaOf, STATUS_SYMBOLS, layerLabel, statText, planIdentity, planKind, planUrl, planResource, resourceIdentity }
