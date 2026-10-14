/** Optional command registration, execution guards, refresh and transactional teardown. */
const { service } = require('../context.cjs')
const { IconRobotOutlineRegular, IconQueueOutlineRegular, IconBranchOutlineRegular } = require('../runtime.cjs')
const { ROBOT_GIT_ICON_ID, MESSAGE_GIT_ICON_ID, WEB_GIT_ICON_ID, RobotGitIcon, MessageGitIcon, WebGitIcon } = require('../icons.cjs')
const { CURRENT_PROMPT_TITLES, COMMIT_PALETTE_TITLES, COMMIT_PALETTE_TAG, paletteCopy } = require('./copy.cjs')
const { currentCommitWorkspace, currentCommitInput, startPlanning } = require('../session.cjs')
const { buildCurrentSessionPrompt } = require('../prompts.cjs')
const { promptLanguageFor } = require('../settings.cjs')
const { registerRepositoryLinkCommand } = require('./repository-link.cjs')
function registerCommitPalette(ctx, palette) {
  const disposers = []
  let disposed = false
  const cleanup = function () {
    if (disposed) return
    disposed = true
    let failure
    disposers.reverse().forEach(function (off) {
      try { off() } catch (error) { failure = error }
    })
    if (failure) throw failure
  }
  const denied = function () {
    if (!currentCommitWorkspace(ctx)) return paletteCopy(ctx).missing
    const sessions = service(ctx, 'sessions')
    if (!sessions || typeof sessions.create !== 'function') return paletteCopy(ctx).unavailable
  }
  try {
    if (typeof palette.registerIcon === 'function') {
      if (typeof IconRobotOutlineRegular === 'function' && typeof IconBranchOutlineRegular === 'function') {
        disposers.push(palette.registerIcon(ROBOT_GIT_ICON_ID, RobotGitIcon))
      }
      if (typeof IconQueueOutlineRegular === 'function' && typeof IconBranchOutlineRegular === 'function') {
        disposers.push(palette.registerIcon(MESSAGE_GIT_ICON_ID, MessageGitIcon))
      }
      disposers.push(palette.registerIcon(WEB_GIT_ICON_ID, WebGitIcon))
    }
    disposers.push(palette.registerCommand({
      id: 'dsh-git-commit-agent.start-current-workspace',
      describe: function () {
        const copy = paletteCopy(ctx)
        return {
          title: copy.title, category: copy.category,
          localizedTitles: COMMIT_PALETTE_TITLES,
          pluginTag: COMMIT_PALETTE_TAG,
          iconId: ROBOT_GIT_ICON_ID,
          aliases: ['commit', 'agent', 'git', '提交', '规划并提交'],
          disabledReason: denied(),
        }
      },
      target: {
        kind: 'action',
        execute: async function (args) {
          if (args.signal.aborted) return { kind: 'cancelled' }
          const reason = denied()
          if (reason) return { kind: 'failed', message: reason }
          const target = currentCommitWorkspace(ctx)
          try {
            await startPlanning(ctx, { worktree: target.path }, {
              signal: args.signal, workspaceId: target.workspaceId,
            })
            // Abort after creation does not undo the created session.
            return args.signal.aborted ? { kind: 'cancelled' }
              : { kind: 'completed', message: paletteCopy(ctx).completed }
          } catch (error) {
            return args.signal.aborted ? { kind: 'cancelled' }
              : { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
          }
        },
      },
    }))
    const inputDenied = function () {
      if (!currentCommitWorkspace(ctx)) return paletteCopy(ctx).missing
      const input = currentCommitInput(ctx)
      if (!input || typeof input.setDraft !== 'function') return paletteCopy(ctx).inputUnavailable
    }
    disposers.push(palette.registerCommand({
      id: 'dsh-git-commit-agent.fill-current-session',
      describe: function () {
        const copy = paletteCopy(ctx)
        return {
          title: copy.inputTitle, category: copy.category,
          localizedTitles: CURRENT_PROMPT_TITLES, pluginTag: COMMIT_PALETTE_TAG,
          iconId: MESSAGE_GIT_ICON_ID, aliases: ['commit', 'prompt', 'git', '提交', '当前会话', 'inputbox'],
          disabledReason: inputDenied(),
        }
      },
      target: {
        kind: 'action',
        execute: async function (args) {
          if (args.signal.aborted) return { kind: 'cancelled' }
          try {
            const reason = inputDenied()
            if (reason) return { kind: 'failed', message: reason }
            const target = currentCommitWorkspace(ctx)
            const input = currentCommitInput(ctx)
            const state = input.state && typeof input.state.getSnapshot === 'function' && input.state.getSnapshot()
            if (state && (state.draft || state.attachmentIds && state.attachmentIds.length
              || state.occurrences && state.occurrences.length || state.phase && state.phase !== 'plain')) {
              return { kind: 'failed', message: paletteCopy(ctx).inputOccupied }
            }
            if (args.signal.aborted) return { kind: 'cancelled' }
            input.setDraft(buildCurrentSessionPrompt(target.path, promptLanguageFor(ctx)))
            if (typeof input.focus === 'function') input.focus()
            return { kind: 'completed', message: paletteCopy(ctx).inputCompleted }
          } catch (error) {
            return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
          }
        },
      },
    }))
    disposers.push(registerRepositoryLinkCommand(ctx, palette))
    const refresh = function () {
      if (palette.getSnapshot().mode === 'commands') palette.refresh()
    }
    const sessions = service(ctx, 'sessions')
    const workspaces = service(ctx, 'workspaces')
    const locale = service(ctx, 'locale')
    ;[sessions && sessions.list, workspaces && workspaces.list, locale].forEach(function (store) {
      if (store && typeof store.subscribe === 'function') disposers.push(store.subscribe(refresh))
    })
  } catch (error) {
    try { cleanup() } catch (_) { /* Preserve registration failure. */ }
    throw error
  }
  return cleanup
}

module.exports = { registerCommitPalette }
