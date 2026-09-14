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
    const PUBLISH_TOOL = 'commit_agent_publish_plan'
    const APPROVAL_TOOL = 'commit_agent_request_approval'
    const STYLE_ID = 'dsh-git-commit-agent/client.css'

    const CSS = [
      '.dsh-gca-action{display:inline-flex;align-items:center;gap:6px}',
      '.dsh-gca-action button{display:inline-flex;align-items:center;gap:6px;padding:0 8px;height:24px;',
      'border:1px solid var(--dsh-color-border,#3c3c3c);border-radius:4px;background:transparent;',
      'color:inherit;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-gca-action button:hover:not(:disabled){background:var(--dsh-color-hover,rgba(127,127,127,.15))}',
      '.dsh-gca-action button:disabled{opacity:.5;cursor:default}',
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
    function buildPlanningPrompt(worktree, branch) {
      return [
        '请为这个 worktree 规划提交。',
        'worktree: ' + worktree,
        'branch: ' + (branch || '(detached)'),
        '',
        '要求：',
        '1. 先调用 commit_agent_status 读取真实状态与 changeId。changeId 是内容寻址的，文件一变就失效，必须重新读取。',
        '2. 用 commit_agent_diff / commit_agent_read_context 看真实改动，不要从路径或扩展名猜内容。',
        '3. 用 commit_agent_publish_plan 发布计划：每个待提交变更必须恰好出现一次；未纳入的必须放进 excludedChanges 并给出理由。',
        '4. 计划没有 blocker 后调用 commit_agent_request_approval 让我审批。',
        '5. 只有我批准之后才能调用 commit_agent_execute_plan。不要自己声称我已批准。',
      ].join('\n')
    }

    /** Resolve a host service, tolerating an absent one. */
    function service(ctx, name) {
      if (ctx.get !== undefined) {
        const found = ctx.get(name)
        if (found !== undefined && found !== null) return found
      }
      return ctx[name]
    }

    /**
     * Create a session in the target worktree, open it, and seed the planning
     * request. Uses only public client APIs; a missing conversation facade
     * degrades to a seeded draft the user submits themselves.
     */
    async function startPlanning(ctx, target) {
      const worktree = target.worktree || target.repoRoot
      if (!worktree) throw new Error('找不到目标 worktree')
      const sessions = service(ctx, 'sessions')
      if (!sessions || typeof sessions.create !== 'function') {
        throw new Error('当前宿主没有可用的 sessions 服务')
      }
      const sessionId = await sessions.create({ cwd: worktree })
      const workspace = service(ctx, 'uiWorkspace')
      if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
      else if (typeof sessions.open === 'function') sessions.open(sessionId)

      const conversation = service(ctx, 'conversation')
      const actx = typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
      if (conversation && conversation.input && actx !== undefined) {
        const input = conversation.input.for(actx)
        input.setDraft(buildPlanningPrompt(worktree, target.branch))
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
      const staged = Array.isArray(props.staged) ? props.staged : []
      const isRepo = Boolean(props.status && props.status.isRepo)
      const disabled = busy || !isRepo || staged.length === 0
      const onClick = function () {
        setBusy(true)
        setError(null)
        Promise.resolve(props.start()).catch(function (failure) {
          setError(String((failure && failure.message) || failure))
        }).then(function () {
          setBusy(false)
        })
      }
      const label = busy ? '正在打开…' : '规划并提交变更'
      const title = !isRepo
        ? '当前不是 git 仓库'
        : staged.length === 0
          ? '没有已暂存的变更'
          : '在新会话中规划这些变更的提交'
      return h(
        'div',
        { className: 'dsh-gca-action' },
        h('button', { type: 'button', onClick: onClick, disabled: disabled, title: title }, label),
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

    /** A compact card for the approval tool result. */
    function ApprovalCard(props) {
      const block = props.block
      const meta = block && block.meta
      if (!meta || typeof meta !== 'object') {
        return h('div', { className: 'dsh-gca-card' }, '等待审批结果…')
      }
      return h(
        'div',
        { className: 'dsh-gca-card' },
        h('h4', null, meta.approved === true ? '计划已获批准' : '计划未获批准'),
        h(
          'div',
          { className: 'dsh-gca-meta' },
          'plan ' + String(meta.planId) + ' revision ' + String(meta.revision),
        ),
      )
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
          yield ctx.slots.register({ name: 'tool.call.toolview', key: PUBLISH_TOOL }, function (props) {
            return h(PlanCard, {
              block: props.block,
              openDiff: function (entry) {
                openPlanDiff(ctx, entry && entry.planId, entry)
              },
            })
          })
          yield ctx.slots.register({ name: 'tool.call.toolview', key: APPROVAL_TOOL }, function (props) {
            return h(ApprovalCard, { block: props.block })
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
      ApprovalCard: ApprovalCard,
      planMetaOf: planMetaOf,
    }

    return exports
  },
})
