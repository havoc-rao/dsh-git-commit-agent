/** Plugin-owned Git-badge compositions over platform artwork. */
const { React, h, IconRobotOutlineRegular, IconQueueOutlineRegular, IconBranchOutlineRegular } = require('./runtime.cjs')
// Plugin-owned artwork; descriptors retain only serializable, namespaced IDs.
const ROBOT_GIT_ICON_ID = 'dsh-git-commit-agent.robot-git'
const MESSAGE_GIT_ICON_ID = 'dsh-git-commit-agent.message-git'
function GitBadgeIcon(props) {
  const maskId = React.useId()
  const Body = props.body
  if (typeof Body !== 'function' || typeof IconBranchOutlineRegular !== 'function') return null
  return h('svg', { width: props.size || 16, height: props.size || 16,
    className: props.className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    // These colours are mask luminance only, never visible background paint.
    // Explicit luminance matters: an alpha mask would keep the opaque black
    // badge rectangle instead of cutting the body away. Do not paint a
    // white/theme-coloured badge backing: hover/selected surfaces must show through.
    h('defs', null, h('mask', { id: maskId, maskUnits: 'userSpaceOnUse',
      maskContentUnits: 'userSpaceOnUse', style: { maskType: 'luminance' },
      x: 0, y: 0, width: 16, height: 16 },
      h('rect', { width: 16, height: 16, fill: 'white', stroke: 'none' }),
      h('rect', { x: 8, y: 8, width: 8, height: 8, rx: 1, fill: 'black', stroke: 'none' }))),
    h('g', { mask: 'url(#' + maskId + ')' }, h(Body, { size: 16 })),
    h('g', { transform: 'translate(8 8) scale(.5)' }, h(IconBranchOutlineRegular, { size: 16 })))
}
function RobotGitIcon(props) { return h(GitBadgeIcon, { ...props, body: IconRobotOutlineRegular }) }
function MessageGitIcon(props) { return h(GitBadgeIcon, { ...props, body: IconQueueOutlineRegular }) }

const WEB_GIT_ICON_ID = 'dsh-git-commit-agent.web-git'
/** Compact globe with a Git branch badge; currentColor works on every surface. */
function WebGitIcon(props) {
  const maskId = React.useId()
  return h('svg', { width: props.size || 16, height: props.size || 16,
    className: props.className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('defs', null, h('mask', { id: maskId, maskUnits: 'userSpaceOnUse',
      maskContentUnits: 'userSpaceOnUse', style: { maskType: 'luminance' },
      x: 0, y: 0, width: 16, height: 16 },
      h('rect', { width: 16, height: 16, fill: 'white' }),
      h('rect', { x: 8, y: 8, width: 8, height: 8, rx: 1, fill: 'black' }))),
    h('g', { mask: 'url(#' + maskId + ')', stroke: 'currentColor', strokeWidth: 1.1 },
      h('circle', { cx: 7, cy: 7, r: 5.5 }),
      h('ellipse', { cx: 7, cy: 7, rx: 2.4, ry: 5.5 }),
      h('path', { d: 'M1.5 7h11M2.6 3.8h8.8M2.6 10.2h8.8' })),
    h('g', { stroke: 'currentColor', strokeWidth: 1.15, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M10 10.4v3M13.8 10.4v.4c0 1.3-3.8 1.3-3.8 2.6' }),
      h('circle', { cx: 10, cy: 9.3, r: 1.05 }),
      h('circle', { cx: 13.8, cy: 9.3, r: 1.05 }),
      h('circle', { cx: 10, cy: 14.45, r: 1.05 })))
}

module.exports = { ROBOT_GIT_ICON_ID, MESSAGE_GIT_ICON_ID, WEB_GIT_ICON_ID, RobotGitIcon, MessageGitIcon, WebGitIcon }
