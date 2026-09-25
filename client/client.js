/**
 * dsh-git-commit-agent — client half.
 *
 * Hand-written lazy-CJS bundle in the exact shape the DSH client module table
 * expects (`window.__ModuleLoader__.load({ id, factory })`, entry reached
 * through the package's `./client` export). No bundler, no JSX and no CSS
 * module: React comes from the platform baseline seed, styles are injected from
 * inside the factory, and every host service is reached through the public
 * client surface.
 *
 * There is deliberately **no typert Remote** here. Creating a dedicated agent
 * session needs `AgentRegistry.create`, which lives in the host process, and
 * reaching it from the browser would require a Remote plus a plugin-local copy
 * of `@deepseek-ai/cordis` whose symbol interop with the host gateway is
 * unverified. Instead the button uses only public client APIs: create a session
 * in the target worktree, open it, seed the planning prompt and submit it. The
 * session id is preallocated with a reserved prefix (`SESSION_ID_PREFIX`) so the
 * host half can install the commit tools into exactly that session's scope,
 * instead of registering them globally where every session would see them. The
 * plugin's tools then drive planning, and approval goes through the host's own
 * plan-review panel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-git-commit-agent',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const exports = {}

    /** Client services this plugin waits for (Cordis service names, not packages). */
    exports.inject = ['slots', 'sessions', 'betterSidebar']

    const ACTION_ID = 'dsh-git-commit-agent:plan-and-commit'
    const DIFF_ID_PREFIX = 'git-commit-agent:plan'
    /** The transcript card keys: prepare_plan renders the plan, apply_plan the decision + execution. */
    const PREPARE_TOOL = 'commit_agent_prepare_plan'
    const APPLY_TOOL = 'commit_agent_apply_plan'
    const STYLE_ID = 'dsh-git-commit-agent/client.css'
    /**
     * Reserved session-id prefix the host half matches on.
     *
     * DSH resolves a tool surface per agent scope, so a globally registered
     * tool would appear in every session. Instead the host installs the five
     * commit tools into exactly the agents whose id starts with this prefix,
     * and this button preallocates such an id through
     * `sessions.create({ sessionId })`.
     * Kept in sync by hand with `src/host/tools.ts` (`COMMIT_AGENT_SESSION_PREFIX`);
     * `tests/client.test.ts` locks the two together.
     */
    const SESSION_ID_PREFIX = 'session-git-commit-'

    const CSS = [
      '.dsh-gca-action{display:inline-flex;align-items:center;gap:6px}',
      '.dsh-gca-action button{display:inline-flex;align-items:center;gap:6px;padding:0 8px;height:24px;',
      'border:1px solid var(--dsh-color-border,#3c3c3c);border-radius:4px;background:transparent;',
      'color:inherit;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-gca-action button:hover:not(:disabled){background:var(--dsh-color-hover,rgba(127,127,127,.15))}',
      '.dsh-gca-action button:disabled{opacity:.5;cursor:default}',
      '.dsh-gca-action button.dsh-gca-icon-button{padding:0;width:24px;justify-content:center}',
      '.dsh-gca-action button.dsh-gca-icon-button svg{display:block}',
      '.dsh-gca-error{font-size:11px;color:var(--dsh-color-error,#f14c4c);max-width:220px}',
      '.dsh-gca-card{border:1px solid var(--dsh-color-border,#3c3c3c);border-radius:6px;padding:8px 10px;',
      'font-size:12px;line-height:1.5}',
      '.dsh-gca-card h4{margin:0 0 6px;font-size:12px;font-weight:600}',
      '.dsh-gca-card ol{margin:0;padding-left:18px}',
      '.dsh-gca-card li{margin:2px 0}',
      '.dsh-gca-card .dsh-gca-meta{opacity:.7;font-size:11px;margin-top:6px}',
      '.dsh-gca-card .dsh-gca-blocker{color:var(--dsh-color-error,#f14c4c)}',
      '.dsh-gca-card button{padding:0 6px;height:20px;border:1px solid var(--dsh-color-border,#3c3c3c);',
      'border-radius:3px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}',
      '.dsh-gca-card button:hover{background:var(--dsh-color-hover,rgba(127,127,127,.15))}',
      '.dsh-gca-row{display:flex;align-items:baseline;gap:6px}',
    ].join('')

    /** Inject the plugin stylesheet once, from inside the factory. */
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin', 'dsh-git-commit-agent')
      style.setAttribute('data-plugin-css', STYLE_ID)
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** The prompt the button seeds into the new session. */
    function buildPlanningPrompt(worktree, branch, stagedCount) {
      const lines = [
        '请为这个 worktree 规划提交。',
        'worktree: ' + worktree,
        'branch: ' + (branch || '(detached)'),
        '',
        '要求：',
        '1. 先调用 commit_agent_inspect（默认 mode=status）读取真实状态与 changeId。changeId 是内容寻址的，文件一变就失效，必须重新读取；若状态显示已有暂存内容，所有 staged 变更必须进入第一个提交。',
        '2. 用 commit_agent_diff / commit_agent_read_files 看真实改动，不要从路径或扩展名猜内容。',
        '3. 用 commit_agent_prepare_plan 准备计划：每个待提交变更必须恰好出现一次；未纳入的必须放进 excludedChanges 并给出理由。',
        '4. 计划没有 blocker 后调用 commit_agent_apply_plan：宿主会弹出审批面板让我批准；我批准之后才会真正执行提交。',
        '5. 不要自己声称我已批准。若我拒绝，先问我怎么改，再准备新版本重新提交。',
      ]
      if (stagedCount === 0) {
        lines.push(
          '',
          '当前没有已暂存内容：工作区改动与未跟踪文件都要纳入提交计划，执行时由计划自行暂存后再提交，不要要求我先手动 git add。',
        )
      }
      return lines.join('\n')
    }

    /** Resolve a host service, tolerating an absent one. */
    function service(ctx, name) {
      if (ctx.get !== undefined) {
        const found = ctx.get(name)
        if (found !== undefined && found !== null) return found
      }
      return ctx[name]
    }

    /** Compare two directory strings, ignoring a trailing separator. */
    function normalizePath(value) {
      if (typeof value !== 'string' || value === '') return ''
      return value.length > 1 ? value.replace(/\/+$/, '') : value
    }

    /**
     * Mint the session id the host recognizes as a commit session.
     *
     * `ISessions.create` accepts a preallocated `sessionId`, which is how a
     * client-created session opts into the plugin's per-session tool surface.
     * `crypto.randomUUID` exists in every secure context the web client runs
     * in; the fallback keeps an older/embedded shell working.
     */
    function newSessionId() {
      const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
            const random = (Math.random() * 16) | 0
            const value = char === 'x' ? random : (random & 0x3) | 0x8
            return value.toString(16)
          })
      return SESSION_ID_PREFIX + uuid
    }

    /**
     * Resolve the registered Workspace that owns one directory.
     *
     * DSH's sidebar groups sessions strictly by **Workspace membership**
     * (`workspace.sessionIds`), not by cwd: `session.create({ cwd })` records a
     * session whose header points at that directory, but the session is only
     * attached to a Workspace when `session.create({ workspaceId })` is used
     * (the host's `SessionCommandController.create` calls
     * `workspace.attachSession` only for that branch). A session with a cwd but
     * no membership therefore falls into the "未分组" bucket even when its cwd
     * *is* a registered Workspace. Passing the matching `workspaceId` is what
     * puts the planning session back under the original workspace.
     */
    function workspaceIdForPath(ctx, path) {
      const wanted = normalizePath(path)
      if (wanted === '') return undefined
      const workspaces = service(ctx, 'workspaces')
      const list = workspaces && workspaces.list
      const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
      const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (item && typeof item.path === 'string' && normalizePath(item.path) === wanted) {
          return item.workspaceId
        }
      }
      return undefined
    }

    /**
     * Create a session in the target worktree, open it, and seed the planning
     * request. Uses only public client APIs; a missing conversation facade
     * degrades to a seeded draft the user submits themselves.
     *
     * When the target directory is a registered Workspace the session is
     * created **through that Workspace** so the host attaches it and the
     * sidebar groups it there; otherwise it is created with a plain `cwd` and
     * stays under 未分组, which is unavoidable because the host only accepts a
     * membership whose cwd equals the Workspace path exactly.
     */
    async function startPlanning(ctx, target) {
      const worktree = target.worktree || target.repoRoot
      if (!worktree) throw new Error('找不到目标 worktree')
      const sessions = service(ctx, 'sessions')
      if (!sessions || typeof sessions.create !== 'function') {
        throw new Error('当前宿主没有可用的 sessions 服务')
      }
      const workspaceId = workspaceIdForPath(ctx, worktree)
      // Preallocate the id so the host knows this is a commit session and
      // installs the five tools into exactly this agent's scope.
      const requestedId = newSessionId()
      let sessionId
      if (workspaceId === undefined) {
        sessionId = await sessions.create({ sessionId: requestedId, cwd: worktree })
      } else {
        try {
          sessionId = await sessions.create({ sessionId: requestedId, workspaceId: workspaceId })
        } catch (failure) {
          // The Workspace may have been removed between the snapshot read and
          // the call. A session in the right directory is still useful; it
          // simply remains ungrouped.
          sessionId = await sessions.create({ sessionId: requestedId, cwd: worktree })
        }
      }
      if (typeof sessionId !== 'string' || sessionId === '') sessionId = requestedId
      const workspace = service(ctx, 'uiWorkspace')
      if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
      else if (typeof sessions.open === 'function') sessions.open(sessionId)

      const conversation = service(ctx, 'conversation')
      const actx = typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
      if (conversation && conversation.input && actx !== undefined) {
        const input = conversation.input.for(actx)
        const stagedCount = Array.isArray(target.staged) ? target.staged.length : 0
        input.setDraft(buildPlanningPrompt(worktree, target.branch, stagedCount))
        if (typeof input.submit === 'function') input.submit()
      }
      return sessionId
    }

    /** Open one planned commit's diff in the sidebar's DiffPane. */
    function openPlanDiff(ctx, planId, block) {
      const sidebar = service(ctx, 'betterSidebar')
      if (!sidebar || typeof sidebar.openTab !== 'function') return false
      const id = DIFF_ID_PREFIX + ':' + planId + ':' + block.commitId
      const title = '计划 ' + block.commitId + '：' + String(block.message || '').split('\n')[0]
      sidebar.openTab({
        type: 'diff',
        id: id,
        title: title,
        diff: { kind: 'proposed', id: id, title: title, patch: block.patch || '' },
      })
      return true
    }

    /** The GitLens commit-row button. */
    function CommitAction(props) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const status = props.status && typeof props.status === 'object' ? props.status : {}
      const entries = Array.isArray(status.entries) ? status.entries : null
      const staged = Array.isArray(props.staged) ? props.staged : []
      const isRepo = Boolean(status.isRepo)
      // Any working-tree change enables the flow — with an empty index the
      // plan itself stages the files before committing (the executor
      // materializes each commit group from the plan's change records), so the
      // entry must not require pre-staged content. `entries` is the host's
      // full status snapshot (staged + unstaged + untracked); hosts without it
      // fall back to the explicit staged list.
      const hasChanges = entries !== null ? entries.length > 0 : staged.length > 0
      const disabled = busy || !isRepo || !hasChanges
      const onClick = function () {
        setBusy(true)
        setError(null)
        Promise.resolve(props.start()).catch(function (failure) {
          setError(String((failure && failure.message) || failure))
        }).then(function () {
          setBusy(false)
        })
      }
      // The button is icon-only, so the tooltip and the accessible name carry
      // the whole message, including why it is disabled.
      const title = busy
        ? '正在打开规划会话…'
        : !isRepo
          ? '当前不是 git 仓库'
          : !hasChanges
            ? '没有待提交的变更'
            : staged.length === 0
              ? '规划并提交这些变更（未暂存的变更将纳入计划）'
              : '在新会话中规划并提交这些变更'
      return h(
        'div',
        { className: 'dsh-gca-action' },
        h(
          'button',
          {
            type: 'button',
            onClick: onClick,
            disabled: disabled,
            className: 'dsh-gca-icon-button',
            title: title,
            'aria-label': title,
            'aria-busy': busy ? 'true' : undefined,
          },
          // The Git commit glyph: a commit node on the commit line. This button
          // plans a sequence of commits, so it borrows that shape.
          h(
            'svg',
            {
              width: 14,
              height: 14,
              viewBox: '0 0 16 16',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinecap: 'round',
              'aria-hidden': 'true',
              focusable: 'false',
            },
            h('line', { x1: 1, y1: 8, x2: 4.7, y2: 8 }),
            h('circle', { cx: 8, cy: 8, r: 3.3 }),
            h('line', { x1: 11.3, y1: 8, x2: 15, y2: 8 }),
          ),
        ),
        error !== null ? h('span', { className: 'dsh-gca-error' }, error) : null,
      )
    }

    /** Read the plan summary the host attached to a tool result. */
    function planMetaOf(block) {
      if (!block || typeof block !== 'object') return null
      const meta = block.meta
      if (!meta || typeof meta !== 'object') return null
      if (!Array.isArray(meta.preview)) return null
      return meta
    }

    /** The transcript card for one published plan. */
    function PlanCard(props) {
      const block = props.block
      const meta = planMetaOf(block)
      const openDiff = props.openDiff
      if (meta === null) {
        return h('div', { className: 'dsh-gca-card' }, '正在整理提交计划…')
      }
      const blockers = Array.isArray(meta.blockers) ? meta.blockers : []
      const preview = Array.isArray(meta.preview) ? meta.preview : []
      const children = [
        h(
          'h4',
          { key: 'title' },
          '提交计划 revision ' + String(meta.revision) + ' — ' + preview.length + ' 个提交',
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
            return h(
              'li',
              { key: entry.commitId || index },
              h(
                'div',
                { className: 'dsh-gca-row' },
                h('span', null, entry.commitId + '：' + subject),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: function () {
                      openDiff(Object.assign({}, entry, { planId: meta.planId }))
                    },
                  },
                  '查看差异',
                ),
              ),
            )
          }),
        ),
      )
      children.push(
        h(
          'div',
          { key: 'meta', className: 'dsh-gca-meta' },
          'digest ' + String(meta.planDigest || '').slice(0, 16) + '…'
            + (blockers.length === 0 ? ' · 等待你在审批面板中确认' : ' · 请先解决阻塞项'),
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

    /**
     * Register the client contributions.
     * @param ctx - the client plugin context.
     */
    exports.apply = async function apply(ctx) {
      injectStyles()

      const sidebar = service(ctx, 'betterSidebar')
      const features = sidebar && Array.isArray(sidebar.features) ? sidebar.features : []
      if (sidebar && typeof sidebar.registerGitCommitAction === 'function' && features.indexOf('gitCommitActions') >= 0) {
        sidebar.registerGitCommitAction({
          id: ACTION_ID,
          order: 50,
          available: function (target) {
            return Boolean(target && target.status && target.status.isRepo)
          },
          component: function (props) {
            return h(CommitAction, {
              status: props.status,
              staged: props.staged,
              start: function () {
                return startPlanning(ctx, props)
              },
            })
          },
        })
      } else if (sidebar === undefined || sidebar === null) {
        // The sidebar is optional; the plugin degrades to tools-only.
        if (ctx.logger && typeof ctx.logger.info === 'function') {
          ctx.logger.info('dsh-git-commit-agent: betterSidebar is unavailable, the GitLens entry is not registered')
        }
      }

      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('tool.call.toolview', function* () {
          yield ctx.slots.register({ name: 'tool.call.toolview', key: PREPARE_TOOL }, function (props) {
            return h(PlanCard, {
              block: props.block,
              openDiff: function (entry) {
                openPlanDiff(ctx, entry && entry.planId, entry)
              },
            })
          })
          yield ctx.slots.register({ name: 'tool.call.toolview', key: APPLY_TOOL }, function (props) {
            return h(ApplyCard, { block: props.block })
          })
        })
      }
    }

    // Internal hooks for the unit tests; the module table ignores them.
    exports.__test = {
      buildPlanningPrompt: buildPlanningPrompt,
      startPlanning: startPlanning,
      openPlanDiff: openPlanDiff,
      CommitAction: CommitAction,
      PlanCard: PlanCard,
      ApplyCard: ApplyCard,
      planMetaOf: planMetaOf,
    }

    return exports
  },
})
