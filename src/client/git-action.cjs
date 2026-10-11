/** Native GitLens More-menu action; async state remains with the slot owner. */
const { h, MenuItemButton } = require('./runtime.cjs')
/** Native More-menu contribution. All async UI belongs to the owner,
 * so closing/unmounting this menu item cannot lose errors or reset busy. */
function CommitAction(props) {
  const status = props.status && typeof props.status === 'object' ? props.status : {}
  if (!status.isRepo) return null
  const entries = Array.isArray(status.entries) ? status.entries : null
  const staged = Array.isArray(props.staged) ? props.staged : []
  // An empty index is valid: the approved plan stages changes itself.
  const hasChanges = entries !== null ? entries.length > 0 : staged.length > 0
  const disabled = Boolean(props.busy) || !hasChanges
  const title = props.busy
    ? '正在打开规划会话…'
    : !hasChanges
      ? '没有待提交的变更'
      : staged.length === 0
        ? '规划并提交这些变更（未暂存的变更将纳入计划）'
        : '在新会话中规划并提交这些变更'
  return h(MenuItemButton, {
    disabled: disabled,
    title: title,
    'aria-label': title,
    onSelect: function () {
      if (disabled) return
      props.close()
      // Capture the actual slot owner (scope/worktree), never header state.
      // runAction owns mutual exclusion, errors and refresh after success.
      return props.runAction(props.start)
    },
  }, h('span', { 'data-better-sidebar-git-action-label': '' },
    h('span', { 'data-better-sidebar-git-action-title': '' }, '规划并提交'),
    h('span', { 'data-better-sidebar-git-action-subtitle': '' }, 'agent'),
  ))
}

module.exports = { CommitAction }
