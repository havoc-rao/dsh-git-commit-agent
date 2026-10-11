/** Stable bilingual command metadata and active-locale feedback. */
const { service } = require('./context.cjs')
const { ROBOT_GIT_ICON_ID } = require('./icons.cjs')
const CURRENT_PROMPT_TITLES = Object.freeze({
  zh: '将提交规划 prompt 填入当前会话',
  en: 'Fill Commit Planning Prompt in Current Session',
})

const COMMIT_PALETTE_TITLES = Object.freeze({
  zh: '在当前工作区启动 Commit Agent',
  en: 'Start Commit Agent in Current Workspace',
})
const COMMIT_PALETTE_TAG = Object.freeze({
  id: 'dsh-git-commit-agent',
  title: 'Git Commit Agent',
  localizedTitles: Object.freeze({ zh: 'Git 提交助手', en: 'Git Commit Agent' }),
  iconId: ROBOT_GIT_ICON_ID,
})

function paletteCopy(ctx) {
  const locale = service(ctx, 'locale')
  const snapshot = locale && typeof locale.getSnapshot === 'function' && locale.getSnapshot()
  const english = snapshot && typeof snapshot.active === 'string' && /^en(?:[-_]|$)/i.test(snapshot.active)
  return english ? {
    title: COMMIT_PALETTE_TITLES.en, category: 'Git',
    missing: 'The current session has no registered workspace',
    unavailable: 'Session creation is unavailable',
    completed: 'Commit planning session created',
    inputTitle: CURRENT_PROMPT_TITLES.en,
    inputUnavailable: 'The current session input is unavailable',
    inputOccupied: 'The input already has a draft or attachments; send or clear them first',
    inputCompleted: 'Commit planning prompt filled in; review and send when ready',
  } : {
    title: COMMIT_PALETTE_TITLES.zh, category: 'Git',
    missing: '当前会话没有所属的已注册工作区',
    unavailable: '当前宿主无法创建会话',
    completed: '已创建提交规划会话',
    inputTitle: CURRENT_PROMPT_TITLES.zh,
    inputUnavailable: '当前会话输入框不可用',
    inputOccupied: '输入框已有草稿或附件，请先发送或清空',
    inputCompleted: '已填入提交规划 prompt，请检查后手动发送',
  }
}

module.exports = { CURRENT_PROMPT_TITLES, COMMIT_PALETTE_TITLES, COMMIT_PALETTE_TAG, paletteCopy }
