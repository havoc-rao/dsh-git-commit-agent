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

    /**
     * The preset whose cards get this plugin's configuration action.
     *
     * The card-action slot renders every contribution on every preset card;
     * the contributor decides whether a preset owns protocol-registered
     * config. This plugin registers exactly one preset (`git-commit`), so only
     * that card renders the button; every other card gets a null contribution
     * (zero placeholder). Kept in sync by hand with the host half
     * (`src/index.ts` `COMMIT_AGENT_PRESET_ID`); if a future preset shares the
     * config surface, widen this to a Set/prefix without touching the slot
     * contract — the slot itself stays preset-agnostic.
     */
    const CONFIGURED_PRESET_ID = 'git-commit'

    /** Editable prompt-language values, in display order. */
    const PROMPT_LANGUAGE_IDS = ['zh', 'en', 'follow-ui']

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
      '.dsh-gca-hidden{display:none}',
      '.dsh-gca-stat{opacity:.75;font-size:11px;white-space:nowrap}',
      '.dsh-gca-note{opacity:.7;font-size:11px}',
      '.dsh-gca-warning{opacity:.85;font-size:11px;margin-top:6px}',
      '.dsh-gca-details{margin-top:4px;padding:6px 8px;border:1px solid var(--dsh-color-border,#3c3c3c);',
      'border-radius:4px;font-size:11px;line-height:1.6}',
      '.dsh-gca-files{margin:4px 0 2px;padding-left:16px;font-size:11px;line-height:1.6}',
      '.dsh-gca-card .dsh-gca-meta details>summary{cursor:pointer;font-size:11px}',
      '.dsh-gca-card .dsh-gca-meta details>div{margin-top:4px;font-size:10px;line-height:1.7;word-break:break-all}',
      '.dsh-gca-configure{position:relative;appearance:none;border:0;border-radius:var(--dsw-radius-sm,4px);padding:6px;',
      'background:none;color:var(--dsw-alias-label-tertiary,currentColor);cursor:pointer;display:inline-flex;',
      'align-items:center}',
      '.dsh-gca-configure:hover{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-primary,currentColor)}',
      '.dsh-gca-configure:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,',
      'var(--dsw-alias-state-business-primary,#0e639c));outline-offset:-1px}',
      '.dsh-gca-configure::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;',
      'transform:translateX(-50%);padding:3px 8px;border-radius:var(--dsw-radius-sm,4px);',
      'background:var(--dsw-alias-label-primary,currentColor);color:var(--dsw-alias-bg-layer-3,#1e1e1e);',
      'font-size:11px;line-height:17px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s}',
      '.dsh-gca-configure:hover::after,.dsh-gca-configure:focus-visible::after{opacity:1}',
      '.dsh-gca-configure svg{display:block}',
      '.dsh-gca-dialog-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;',
      'justify-content:center}',
      '.dsh-gca-dialog-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));',
      'backdrop-filter:var(--dsw-mask-blur,blur(4px))}',
      '.dsh-gca-dialog-panel{position:relative;z-index:1;width:420px;max-width:calc(100vw - 48px);',
      'border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-2,#252526);',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.5));font-size:12px;line-height:1.6}',
      '.dsh-gca-dialog-panel:focus{outline:none}',
      '.dsh-gca-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:12px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.25))}',
      '.dsh-gca-dialog-header h4{margin:0;font-size:13px;font-weight:600}',
      '.dsh-gca-dialog-close{appearance:none;border:0;background:none;color:var(--dsw-alias-label-tertiary,currentColor);',
      'cursor:pointer;padding:4px;border-radius:var(--dsw-radius-sm,4px);display:inline-flex;',
      'align-items:center;font-size:14px;line-height:1}',
      '.dsh-gca-dialog-close:hover{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-primary,currentColor)}',
      '.dsh-gca-dialog-close:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,',
      'var(--dsw-alias-state-business-primary,#0e639c));outline-offset:-1px}',
      '.dsh-gca-dialog-body{padding:14px 16px 16px}',
      '.dsh-gca-dialog-label{display:block;margin:0 0 4px;opacity:.85}',
      // Option control aligned with the settings switcher (PluginInventorySettingsTab
      // `.switcher`): filled module surface, chevron edge, 36px row.
      '.dsh-gca-dialog-select-wrap{position:relative;display:block}',
      '.dsh-gca-dialog-select{display:flex;align-items:center;justify-content:space-between;width:100%;height:36px;',
      'padding:0 14px;border:none;border-radius:var(--dsw-radius-md,6px);background:',
      'var(--dsw-alias-bg-module-platform,#2d2d2d);color:var(--dsw-alias-label-primary,inherit);font:inherit;',
      'font-size:14px;line-height:22px;cursor:pointer;appearance:none;-webkit-appearance:none;text-align:left}',
      '.dsh-gca-dialog-select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dsh-gca-dialog-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,',
      'var(--dsw-alias-state-business-primary,#0e639c));outline-offset:2px}',
      '.dsh-gca-dialog-select-wrap .dsh-gca-chevron{position:absolute;right:14px;top:50%;transform:translateY(-50%);',
      'pointer-events:none;color:var(--dsw-alias-label-primary,currentColor)}',
      // Popup option card following the shared compact Menu surface
      // (PopupSelectView `.card` + MenuSurface `.material`): translucent fill,
      // prominent elevation, hover rows, trailing check on the selection.
      '.dsh-gca-dialog-options{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:100;padding:3px;',
      'display:flex;flex-direction:column;border-radius:var(--dsw-radius-md,6px);background:',
      'var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-2,#2d2d2d));',
      'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(8px));box-shadow:var(--dsw-elevation-prominent,',
      '0 8px 32px rgba(0,0,0,.5));outline:none;max-height:320px;overflow:auto}',
      '.dsh-gca-dialog-option{display:flex;align-items:center;gap:6px;padding:5px 7px;border:none;background:transparent;',
      'border-radius:var(--dsw-radius-md,6px);cursor:pointer;font-family:inherit;font-size:12px;text-align:left;',
      'color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-gca-dialog-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dsh-gca-dialog-group{flex:none;padding:6px 7px 2px;font-size:11px;font-weight:600;opacity:.75}',
      '.dsh-gca-dialog-modelText{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.dsh-gca-dialog-modelRoute{opacity:.65;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-gca-dialog-optionCheck{display:inline-flex;flex:none;margin-left:auto;',
      'color:var(--dsw-alias-label-primary,currentColor)}',
      '.dsh-gca-dialog-optionCheck svg{width:14px;height:14px}',
      '.dsh-gca-dialog-hint{opacity:.7;font-size:11px;margin:6px 0 0}',
      '.dsh-gca-dialog-ok{color:var(--dsw-alias-state-success,#4ec9b0);font-size:11px;margin:8px 0 0}',
      '.dsh-gca-dialog-error{color:var(--dsw-alias-state-error,#f14c4c);font-size:11px;margin:8px 0 0}',
      // Action row aligned with the settings editor footer (EditorFooter:
      // secondary on the left, primary on the right, 36px rows).
      '.dsh-gca-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
      '.dsh-gca-dialog-actions button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
      'gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,6px);font:inherit;',
      'font-size:14px;line-height:22px;cursor:pointer}',
      '.dsh-gca-dialog-actions button.dsh-gca-secondary{border:0.5px solid var(--dsw-alias-border-l3,',
      'rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-gca-dialog-actions button.dsh-gca-secondary:hover:not(:disabled){',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dsh-gca-dialog-actions button.dsh-gca-primary{background:var(--dsw-alias-button-primary-fill,#0e639c);',
      'color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.dsh-gca-dialog-actions button.dsh-gca-primary:hover:not(:disabled){',
      'background:var(--dsw-alias-button-primary-hover,#1177bb)}',
      '.dsh-gca-dialog-actions button:disabled{opacity:.4;cursor:default}',
      '.dsh-gca-dialog-actions button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,',
      'var(--dsw-alias-state-business-primary,#0e639c))}',
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
    function buildPlanningPrompt(worktree, branch, stagedCount, language) {
      const lines = language === 'en'
        ? [
            'Plan commits for this worktree.',
            'worktree: ' + worktree,
            'branch: ' + (branch || '(detached)'),
            '',
            'Requirements:',
            '1. Start by calling commit_agent_inspect (mode=status is the default) to read the real state and changeIds.',
            '   changeIds are content-addressed: they go stale the moment a file changes, so re-read before planning.',
            '   If the status shows staged content, every staged change must be part of the first commit.',
            '2. Read the real changes with commit_agent_diff / commit_agent_read_files; never guess contents from paths',
            '   or extensions.',
            '3. Prepare a plan with commit_agent_prepare_plan: every pending change appears exactly once; anything you',
            '   leave out goes into excludedChanges with a reason.',
            '4. Once the plan has no blockers, call commit_agent_apply_plan: the host shows an approval panel and asks',
            '   me to approve; only after my approval will the commits actually run.',
            '5. Never claim I approved anything by yourself. If I decline, ask me what to change, then prepare a new',
            '   revision and submit again.',
            '6. Use the tools for every step — never sketch state or a plan from memory. Present everything you show',
            '   me — analysis, plan explanation, suggested commit messages, progress reports — in English.',
          ]
        : [
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
            '6. 每一步都必须使用工具，不要凭记忆描述状态或计划。所有展示给我的内容——分析、计划说明、建议的提交信息、进度汇报——都必须使用中文。',
          ]
      if (stagedCount === 0) {
        lines.push(
          '',
          language === 'en'
            ? 'There is nothing staged yet: include working-tree changes and untracked files in the plan; the '
              + 'executor stages them as part of the plan itself, so do not ask me to run git add first.'
            : '当前没有已暂存内容：工作区改动与未跟踪文件都要纳入提交计划，执行时由计划自行暂存后再提交，不要要求我先手动 git add。',
        )
      }
      return lines.join('\n')
    }

    /** Prompt-language preference field name; mirrors `src/config.ts`. */
    const PROMPT_LANGUAGE_FIELD = 'promptLanguage'
    /** Default-model preference field name; mirrors `src/config.ts`. */
    const DEFAULT_MODEL_FIELD = 'defaultModel'
    /**
     * Settings namespace = the plugin's profile entry id (the cordis row `id`
     * in `cordis.patch.yml`, NOT the module name): the host settings service
     * addresses entries by `entry.options.id` and rejects any other key with
     * "No configurable plugin entry". Kept in sync by hand with
     * `cordis.patch.yml` and `src/index.ts` (`PROFILE_ENTRY_ID`).
     */
    const SETTINGS_NAMESPACE = 'git-commit-agent'

    /**
     * Resolve a stored preference against the active UI locale. Mirrors
     * `src/config.ts` `resolvePromptLanguage`; the host builds its prompts
     * through the same rule. When neither a preference nor a UI locale is
     * available, the client keeps its historical default (Chinese).
     */
    function resolvePromptLanguage(preference, activeLocale) {
      if (preference === 'zh') return 'zh'
      if (preference === 'en') return 'en'
      const locale = typeof activeLocale === 'string' ? activeLocale.toLowerCase() : ''
      return locale.startsWith('zh') ? 'zh' : 'en'
    }

    /** The effective prompt language for a new session started from the client. */
    function promptLanguageFor(ctx) {
      const forms = service(ctx, 'configForms')
      let preference
      if (forms && typeof forms.get === 'function') {
        try {
          const form = forms.get(SETTINGS_NAMESPACE)
          const snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : undefined
          const value = snapshot && snapshot.status === 'ready' && snapshot.value && typeof snapshot.value === 'object'
            ? snapshot.value
            : undefined
          if (value !== undefined) preference = value[PROMPT_LANGUAGE_FIELD]
        } catch (error) {
          // A broken forms surface must not block starting a session.
          void error
        }
      }
      const locale = service(ctx, 'locale')
      let active = 'zh'
      if (locale && typeof locale.getSnapshot === 'function') {
        const snapshot = locale.getSnapshot()
        if (snapshot && typeof snapshot.active === 'string' && snapshot.active !== '') active = snapshot.active
      }
      return resolvePromptLanguage(preference, active)
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
      // Pin the stored default model before the first prompt is submitted, so
      // the request header is built with it (the composer model seat's exact
      // selection path). Best-effort: a missing remote or a stale route keeps
      // the host default.
      await applyStoredDefaultModel(ctx, sessionId)
      const workspace = service(ctx, 'uiWorkspace')
      if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
      else if (typeof sessions.open === 'function') sessions.open(sessionId)

      const conversation = service(ctx, 'conversation')
      const actx = typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
      if (conversation && conversation.input && actx !== undefined) {
        const input = conversation.input.for(actx)
        const stagedCount = Array.isArray(target.staged) ? target.staged.length : 0
        input.setDraft(buildPlanningPrompt(worktree, target.branch, stagedCount, promptLanguageFor(ctx)))
        if (typeof input.submit === 'function') input.submit()
      }
      return sessionId
    }

    /**
     * Open one planned commit's diff in the sidebar's DiffPane.
     *
     * The tab identity is scoped to task-independent key + planId + REVISION +
     * commitId so two revisions of the same plan never collide in the bottom
     * workbench's dedupe. The title states the revision, so a re-opened tab is
     * recognisable even when several revisions were reviewed in a row. An
     * explicit scope targets the initiating session's sidebar state instead of
     * whatever session happens to be active.
     */
    function openPlanDiff(ctx, planId, revision, block, sessionId) {
      const sidebar = service(ctx, 'betterSidebar')
      if (!sidebar || typeof sidebar.openTab !== 'function') return false
      const id = DIFF_ID_PREFIX + ':' + planId + ':' + revision + ':' + block.commitId
      const subject = String(block.message || '').split('\n')[0]
      const title = '计划 v' + String(revision) + ' · ' + block.commitId + ' · ' + subject
      // Integrity metadata for the sidebar (display-only): `truncated` marks a
      // capped preview, `sourceRef` labels what snapshot this patch is, so a
      // stale tab stays identifiable after later revisions.
      const diff = {
        kind: 'proposed',
        id: id,
        title: title,
        patch: block.patch || '',
        ...(block.patchTruncated === true ? { truncated: true } : {}),
        ...(typeof planId === 'string' ? { sourceRef: 'plan ' + planId + ' rev ' + String(revision) } : {}),
      }
      const seed = { type: 'diff', id: id, title: title, diff: diff }
      const scope = typeof sessionId === 'string' && sessionId !== '' ? { sessionId: sessionId } : undefined
      sidebar.openTab(seed, scope)
      return true
    }

    /** Locale namespace and copy for the preset-card configuration action. */
    const CARD_ACTION_LOCALE = 'commitAgent.cardAction'
    const CARD_ACTION_COPY = {
      zh: {
        label: '配置',
        close: '关闭',
        title: 'Git Commit Agent 配置',
        promptLanguage: '提示词语言',
        hint: '用于新创建的会话；已开始的会话保持创建时的语言。不改变界面语言。',
        zh: '中文',
        en: 'English',
        followUi: '跟随界面语言',
        defaultModel: '默认模型',
        defaultModelNone: '跟随宿主默认（不指定）',
        modelHint: '新创建的提交会话使用所选模型；不指定时使用部署配置或宿主默认模型。',
        modelLoading: '正在读取模型列表…',
        modelUnavailable: '模型列表不可用：请在模型设置中确认至少一个提供商已配置。',
        save: '保存',
        saved: '已保存',
        failed: '保存失败，请重试',
      },
      en: {
        label: 'Configure',
        close: 'Close',
        title: 'Git Commit Agent configuration',
        promptLanguage: 'Prompt language',
        hint: 'Applies to newly created sessions; running sessions keep their starting language. Does not change the UI language.',
        zh: '中文',
        en: 'English',
        followUi: 'Follow UI language',
        defaultModel: 'Default model',
        defaultModelNone: 'Follow the host default (not specified)',
        modelHint: 'Newly created commit sessions use the selected model; when unset, the deployment config or the host default model applies.',
        modelLoading: 'Loading the model list…',
        modelUnavailable: 'The model list is unavailable: make sure at least one provider is configured in the model settings.',
        save: 'Save',
        saved: 'Saved',
        failed: 'Save failed, please retry',
      },
    }

    /** Read the stored prompt-language value through the forms surface (see promptLanguageFor). */
    function readPromptLanguageValue(ctx) {
      const initial = promptLanguageFor(ctx)
      const forms = service(ctx, 'configForms')
      if (!forms || typeof forms.get !== 'function') return initial
      try {
        const form = forms.get(SETTINGS_NAMESPACE)
        const snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : undefined
        const value = snapshot && snapshot.status === 'ready' && snapshot.value && typeof snapshot.value === 'object'
          ? snapshot.value
          : undefined
        if (value !== undefined && typeof value[PROMPT_LANGUAGE_FIELD] === 'string') {
          return value[PROMPT_LANGUAGE_FIELD]
        }
      } catch (error) {
        void error
      }
      return initial
    }

    /** The stored default-model route, or null when none is stored. */
    function readDefaultModelValue(ctx) {
      const forms = service(ctx, 'configForms')
      if (!forms || typeof forms.get !== 'function') return null
      try {
        const form = forms.get(SETTINGS_NAMESPACE)
        const snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : undefined
        const value = snapshot && snapshot.status === 'ready' && snapshot.value && typeof snapshot.value === 'object'
          ? snapshot.value
          : undefined
        if (value !== undefined) {
          const field = value[DEFAULT_MODEL_FIELD]
          if (field !== null && typeof field === 'object' && !Array.isArray(field)
            && typeof field.provider === 'string' && field.provider !== ''
            && typeof field.model === 'string' && field.model !== '') {
            return { provider: field.provider, model: field.model }
          }
        }
      } catch (error) {
        void error
      }
      return null
    }

    /**
     * The host `remote.session` namespace, when the deployment has one.
     *
     * Reading order matters on a live host: namespaced services are registered
     * as `remote.session`, and the one access that needs NO inject declaration
     * is the global service-store read `ctx.get('remote.session')` — the
     * traceable `ctx.remote.session` property path throws
     * `cannot get property "remote.session" without inject` for a consumer
     * that did not declare it. All access is guarded so a missing or
     * unfinished remote degrades to `undefined` instead of rejecting callers.
     */
    function remoteSession(ctx) {
      try {
        const direct = service(ctx, 'remote.session')
        if (direct !== null && typeof direct === 'object') return direct
      } catch (error) {
        void error
      }
      let remote
      try {
        remote = service(ctx, 'remote')
      } catch (error) {
        void error
        remote = undefined
      }
      if (remote !== null && typeof remote === 'object') {
        try {
          if (remote.session !== undefined && remote.session !== null) return remote.session
        } catch (error) {
          void error
        }
      }
      return undefined
    }

    /** Stable identity for one provider/model route; treated as opaque, never parsed. */
    function modelKey(route) {
      return route.provider + '\u0000' + route.model
    }

    /**
     * Load the host model catalog (`remote.session.modelCatalog`) — the same
     * provider-grouped list the settings models page renders. The RPC answers
     * the typert `RemoteResult` envelope (`{ ok, value }`) on the client, so
     * both the raw catalog and the unwrapped value are accepted.
     *
     * The result is NEVER null: the dialog must not sit on its "loading" note
     * forever. A host without the remote surface, a throwing service access or
     * a rejected/failed catalog all resolve to an empty `{ groups: [], failed:
     * true }` so the picker explains itself and keeps the valid "follow the
     * host default" choice.
     */
    async function loadModelCatalog(ctx) {
      let response
      try {
        const sessions = remoteSession(ctx)
        if (sessions !== undefined && typeof sessions.modelCatalog === 'function') {
          response = await sessions.modelCatalog()
        }
      } catch (error) {
        void error
      }
      const raw = response !== null && typeof response === 'object' ? response : {}
      const body = raw.ok !== undefined && raw.value !== undefined ? raw.value : raw
      const groups = body !== null && typeof body === 'object' && Array.isArray(body.groups)
        ? body.groups
        : []
      return { groups: groups, failed: groups.length === 0 }
    }

    /**
     * Pin the stored default model onto a just-created session, best-effort.
     *
     * The session controller's `selectModel` is the same durable per-session
     * selection the composer model seat installs, so the request header of the
     * first prompt is built with this model. A missing remote surface or a
     * route that vanished from the catalog must never block planning: the
     * session then keeps the host default.
     */
    async function applyStoredDefaultModel(ctx, sessionId) {
      const stored = readDefaultModelValue(ctx)
      if (stored === null) return
      const sessions = remoteSession(ctx)
      if (!sessions || typeof sessions.selectModel !== 'function') return
      try {
        await sessions.selectModel({ sessionId: sessionId, provider: stored.provider, model: stored.model })
      } catch (error) {
        void error
      }
    }

    /**
     * Gear artwork for the configuration trigger, matching the DSH settings
     * outline icon (16×16 viewBox, 1px stroke; path data from
     * ui-primitives `IconSettingsOutlineArtwork`). The label rides `data-tip`
     * on the button; the svg itself is decorative.
     */
    function GearIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 },
        h('path', { d: 'M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z', stroke: 'currentColor' }),
        h('path', { d: 'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z', stroke: 'currentColor', strokeMiterlimit: 10 }),
      )
    }

    /** Chevron artwork for the option control, matching the settings switcher
     *  (ui-primitives `IconChevronDownOutline`, 16×16 viewBox, 1px stroke). */
    function ChevronDownIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1, className: 'dsh-gca-chevron' },
        h('path', { d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', stroke: 'currentColor' }),
      )
    }

    /** Check artwork marking the selected option (ui-primitives `IconCheckOutline`). */
    function CheckIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 },
        h('path', { d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4', stroke: 'currentColor' }),
      )
    }

    /**
     * Popup option card for one language choice, following the shared compact
     * Menu surface (PopupSelectView `.card` + MenuSurface `.material`): rows
     * hover, the current draft carries a trailing check, Escape dismisses.
     */
    function LanguageOptionsBox(props) {
      const t = props.t
      const onKeyDown = function (event) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          props.onDismiss()
        }
      }
      const rows = PROMPT_LANGUAGE_IDS.map(function (id) {
        const selected = id === props.draft
        return h('button', {
          type: 'button',
          key: id,
          role: 'option',
          'aria-selected': selected ? 'true' : 'false',
          className: 'dsh-gca-dialog-option',
          onClick: function () { props.onSelect(id) },
        },
          h('span', null, t(id)),
          selected
            ? h('span', { className: 'dsh-gca-dialog-optionCheck' }, h(CheckIcon))
            : null,
        )
      })
      return h('div', {
        className: 'dsh-gca-dialog-options',
        role: 'listbox',
        'aria-label': t('promptLanguage'),
        onKeyDown: onKeyDown,
      }, rows)
    }

    /**
     * Popup option card for the default-model choice: the no-default row
     * first, then one row per catalog model grouped by provider. Rows carry
     * the display name plus the exact route; Escape dismisses like the
     * language card.
     */
    function ModelOptionsBox(props) {
      const t = props.t
      const onKeyDown = function (event) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          props.onDismiss()
        }
      }
      const isSelected = function (route) {
        const draft = props.draft
        return draft !== null && draft !== undefined
          && draft.provider === route.provider && draft.model === route.model
      }
      const rows = []
      const noneSelected = props.draft === null || props.draft === undefined
      rows.push(h('button', {
        type: 'button',
        key: 'none',
        role: 'option',
        'aria-selected': noneSelected ? 'true' : 'false',
        className: 'dsh-gca-dialog-option',
        onClick: function () { props.onSelect(null) },
      },
        h('span', null, t('defaultModelNone')),
        noneSelected ? h('span', { className: 'dsh-gca-dialog-optionCheck' }, h(CheckIcon)) : null,
      ))
      const groups = Array.isArray(props.catalog) ? props.catalog : []
      for (const group of groups) {
        if (group === null || typeof group !== 'object') continue
        const models = Array.isArray(group.models) ? group.models : []
        if (models.length === 0) continue
        const provider = String(group.id || '')
        const providerName = String(group.name || provider)
        if (provider === '') continue
        rows.push(h('div', {
          key: 'group:' + provider,
          className: 'dsh-gca-dialog-group',
          role: 'presentation',
        }, providerName))
        for (const model of models) {
          if (model === null || typeof model !== 'object') continue
          const modelId = String(model.id || '')
          if (modelId === '') continue
          const route = { provider: provider, model: modelId }
          const selected = isSelected(route)
          rows.push(h('button', {
            type: 'button',
            key: modelKey(route),
            role: 'option',
            'aria-selected': selected ? 'true' : 'false',
            className: 'dsh-gca-dialog-option',
            onClick: function () { props.onSelect(route) },
          },
            h('span', { className: 'dsh-gca-dialog-modelText' },
              h('span', null, String(model.name || modelId)),
              h('span', { className: 'dsh-gca-dialog-modelRoute' }, providerName + ' · ' + provider + '/' + modelId),
            ),
            selected ? h('span', { className: 'dsh-gca-dialog-optionCheck' }, h(CheckIcon)) : null,
          ))
        }
      }
      return h('div', {
        className: 'dsh-gca-dialog-options',
        role: 'listbox',
        'aria-label': t('defaultModel'),
        onKeyDown: onKeyDown,
      }, rows)
    }

    /** Trigger label for the current model draft: a friendly name once the
     *  catalog is loaded, the exact route otherwise (a stored model that
     *  vanished from the catalog stays recognizable). */
    function modelOptionLabel(t, catalog, draft) {
      if (draft === null || draft === undefined) return t('defaultModelNone')
      if (catalog !== null && catalog !== undefined && typeof catalog === 'object') {
        for (const group of Array.isArray(catalog.groups) ? catalog.groups : []) {
          if (group === null || typeof group !== 'object' || String(group.id) !== draft.provider) continue
          for (const model of Array.isArray(group.models) ? group.models : []) {
            if (model === null || typeof model !== 'object' || String(model.id) !== draft.model) continue
            return h('span', { className: 'dsh-gca-dialog-modelText' },
              h('span', null, String(model.name || model.id)),
              h('span', { className: 'dsh-gca-dialog-modelRoute' }, ' · ' + String(group.name || group.id)),
            )
          }
        }
      }
      return h('span', { className: 'dsh-gca-dialog-modelText' },
        h('span', null, draft.provider + '/' + draft.model),
      )
    }

    /** Modal editing the prompt-language and default-model preferences through configForms. */
    function ConfigureDialog(props) {
      const t = props.t
      const [draft, setDraft] = React.useState(props.initialValue)
      const [modelDraft, setModelDraft] = React.useState(props.initialModel) // {provider, model} | null
      const [status, setStatus] = React.useState('idle') // idle | saving | saved | failed
      const [optionsOpen, setOptionsOpen] = React.useState(false)
      const [modelOptionsOpen, setModelOptionsOpen] = React.useState(false)
      const wrapRef = React.useRef(null)
      const modelWrapRef = React.useRef(null)
      const onKeyDown = function (event) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          props.onClose()
        }
      }
      /** Dismiss both popup cards and detach their outside-pointer listener. */
      const dismissOptions = function () {
        setOptionsOpen(false)
        setModelOptionsOpen(false)
        if (typeof document !== 'undefined' && typeof Node !== 'undefined') {
          document.removeEventListener('pointerdown', onDocPointerDown, true)
        }
      }
      /** Any pointer outside both option controls closes the popups (PopupSelectView capture). */
      const onDocPointerDown = function (event) {
        const outside = function (ref) {
          return ref.current === null || !(event.target instanceof Node) || !ref.current.contains(event.target)
        }
        if (outside(wrapRef) && outside(modelWrapRef)) dismissOptions()
      }
      const toggleOptions = function () {
        if (optionsOpen) {
          dismissOptions()
          return
        }
        setOptionsOpen(true)
        setModelOptionsOpen(false)
        if (typeof document !== 'undefined' && typeof Node !== 'undefined') {
          document.addEventListener('pointerdown', onDocPointerDown, true)
        }
      }
      const toggleModelOptions = function () {
        if (modelOptionsOpen) {
          dismissOptions()
          return
        }
        setModelOptionsOpen(true)
        setOptionsOpen(false)
        if (typeof document !== 'undefined' && typeof Node !== 'undefined') {
          document.addEventListener('pointerdown', onDocPointerDown, true)
        }
      }
      const onSave = async function () {
        setStatus('saving')
        const forms = service(props.ctx, 'configForms')
        let accepted = false
        try {
          const form = forms && typeof forms.get === 'function' ? forms.get(SETTINGS_NAMESPACE) : undefined
          if (form) {
            const languageOp = { op: 'set', path: ['promptLanguage'], value: draft }
            const modelOp = modelDraft === null || modelDraft === undefined
              ? { op: 'unset', path: ['defaultModel'] }
              : { op: 'set', path: ['defaultModel'], value: { provider: modelDraft.provider, model: modelDraft.model } }
            if (typeof form.mutate === 'function') {
              // One atomic mutation: both preferences land or neither does.
              accepted = await form.mutate([languageOp, modelOp])
            } else if (typeof form.set === 'function') {
              accepted = await form.set(PROMPT_LANGUAGE_FIELD, draft)
              if (accepted) {
                accepted = modelDraft === null || modelDraft === undefined
                  ? (typeof form.unset === 'function' ? Boolean(await form.unset(DEFAULT_MODEL_FIELD)) : true)
                  : Boolean(await form.set(DEFAULT_MODEL_FIELD, { provider: modelDraft.provider, model: modelDraft.model }))
              }
            }
          }
        } catch (error) {
          void error
        }
        setStatus(accepted ? 'saved' : 'failed')
      }
      const catalogAvailable = props.catalog !== null && props.catalog !== undefined
      // Container/backdrop aligned with the DSH settings shell: fixed overlay,
      // masked blur backdrop, elevated panel; close via Escape / mask / button.
      return h('div', { className: 'dsh-gca-dialog-overlay', role: 'presentation' },
        h('div', { className: 'dsh-gca-dialog-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          className: 'dsh-gca-dialog-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('title'),
          onKeyDown: onKeyDown,
        },
          h('div', { className: 'dsh-gca-dialog-header' },
            h('h4', null, t('title')),
            h('button', {
              type: 'button',
              className: 'dsh-gca-dialog-close',
              'aria-label': t('close'),
              // Receive focus when the dialog opens, matching the settings panel.
              autoFocus: true,
              onClick: props.onClose,
            }, '✕'),
          ),
          h('div', { className: 'dsh-gca-dialog-body' },
            h('label', { className: 'dsh-gca-dialog-label' }, t('promptLanguage')),
            h('div', { className: 'dsh-gca-dialog-select-wrap', ref: wrapRef },
              h('button', {
                type: 'button',
                className: 'dsh-gca-dialog-select',
                'aria-label': t('promptLanguage'),
                'aria-haspopup': 'listbox',
                'aria-expanded': optionsOpen ? 'true' : 'false',
                onClick: toggleOptions,
              }, h('span', null, t(draft))),
              h(ChevronDownIcon),
              optionsOpen
                ? h(LanguageOptionsBox, {
                    t: t,
                    draft: draft,
                    onSelect: function (id) {
                      setDraft(id)
                      setStatus('idle')
                      dismissOptions()
                    },
                    onDismiss: dismissOptions,
                  })
                : null,
            ),
            h('p', { className: 'dsh-gca-dialog-hint' }, t('hint')),
            h('label', { className: 'dsh-gca-dialog-label' }, t('defaultModel')),
            h('div', { className: 'dsh-gca-dialog-select-wrap', ref: modelWrapRef },
              h('button', {
                type: 'button',
                className: 'dsh-gca-dialog-select',
                'aria-label': t('defaultModel'),
                'aria-haspopup': 'listbox',
                'aria-expanded': modelOptionsOpen ? 'true' : 'false',
                onClick: toggleModelOptions,
              }, modelOptionLabel(t, props.catalog, modelDraft)),
              h(ChevronDownIcon),
              modelOptionsOpen
                ? h(ModelOptionsBox, {
                    t: t,
                    catalog: catalogAvailable ? props.catalog.groups : [],
                    draft: modelDraft,
                    onSelect: function (route) {
                      setModelDraft(route)
                      setStatus('idle')
                      dismissOptions()
                    },
                    onDismiss: dismissOptions,
                  })
                : null,
            ),
            // The list may still be loading while the dialog is open; a
            // missing list must not hide the valid "follow host default"
            // choice.
            !catalogAvailable
              ? h('p', { className: 'dsh-gca-dialog-hint' }, t('modelLoading'))
              : props.catalog.failed && props.catalog.groups.length === 0
                ? h('p', { className: 'dsh-gca-dialog-hint' }, t('modelUnavailable'))
                : h('p', { className: 'dsh-gca-dialog-hint' }, t('modelHint')),
            status === 'saved'
              ? h('p', { className: 'dsh-gca-dialog-ok' }, t('saved'))
              : null,
            status === 'failed'
              ? h('p', { className: 'dsh-gca-dialog-error' }, t('failed'))
              : null,
            h('div', { className: 'dsh-gca-dialog-actions' },
              h('button', { type: 'button', className: 'dsh-gca-secondary', onClick: props.onClose }, t('close')),
              h('button', {
                type: 'button',
                className: 'dsh-gca-primary',
                disabled: status === 'saving',
                onClick: onSave,
              }, t('save')),
            ),
          ),
        ),
      )
    }

    /** The preset-card configuration action contributed to the card-action slot. */
    function CardConfigureAction(props) {
      const t = props.t
      const [open, setOpen] = React.useState(false)
      const [initialValue, setInitialValue] = React.useState('follow-ui')
      const [initialModel, setInitialModel] = React.useState(null)
      const [catalog, setCatalog] = React.useState(null) // null | { groups, failed }
      const triggerRef = React.useRef(null)
      const closeDialog = function () {
        setOpen(false)
        // Return focus to the trigger once the dialog closes (settings
        // panel behavior); a test renderer without DOM refs skips this.
        if (triggerRef.current !== null && typeof triggerRef.current.focus === 'function') {
          triggerRef.current.focus()
        }
      }
      // Only presets that own protocol-registered config show the action. The
      // slot contract renders a null contribution with zero placeholder, so
      // every other card stays untouched (the host's read-only "查看配置"
      // button is separate and unaffected).
      if (props.presetId !== CONFIGURED_PRESET_ID) return null
      // A `display: contents` div keeps the trigger and the dialog edge-free in
      // the card footer while staying compatible with every React version.
      return h('div', { className: 'dsh-gca-card-actions' },
        h('button', {
          type: 'button',
          className: 'dsh-gca-configure',
          'aria-label': t('label') + ': ' + String(props.presetId),
          'data-tip': t('label'),
          ref: triggerRef,
          onClick: function () {
            setInitialValue(readPromptLanguageValue(props.ctx))
            setInitialModel(readDefaultModelValue(props.ctx))
            setOpen(true)
            // Refresh the host model list in the background; the dialog shows
            // a loading note until it settles.
            Promise.resolve(loadModelCatalog(props.ctx)).then(function (loaded) {
              setCatalog(loaded)
            }).catch(function () {})
          },
        }, h(GearIcon)),
        open
          ? h(ConfigureDialog, {
              ctx: props.ctx,
              t: t,
              initialValue: initialValue,
              initialModel: initialModel,
              catalog: catalog,
              onClose: closeDialog,
            })
          : null,
      )
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
                  onClick: function () { toggle('details:' + entry.commitId) },
                },
                isOpen('details:' + entry.commitId) ? '收起明细' : '明细',
              ),
              h(
                'button',
                {
                  key: 'diff',
                  type: 'button',
                  onClick: function () {
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
              sessionId: props.sessionId,
              openDiff: function (entry, sessionId) {
                openPlanDiff(ctx, entry && entry.planId, entry && entry.revision, entry, sessionId)
              },
            })
          })
          yield ctx.slots.register({ name: 'tool.call.toolview', key: APPLY_TOOL }, function (props) {
            return h(ApplyCard, { block: props.block })
          })
        })
      }

      // Preset-card configuration action (host slot `settings.agentPreset.card.action`):
      // owns its dictionary, idle when the host page has no such slot.
      const localeSvc = service(ctx, 'locale')
      if (localeSvc && typeof localeSvc.register === 'function') {
        localeSvc.register(CARD_ACTION_LOCALE, { zh: CARD_ACTION_COPY.zh, en: CARD_ACTION_COPY.en })
      }
      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('settings.agentPreset.card.action', function* () {
          yield ctx.slots.register({
            name: 'settings.agentPreset.card.action',
            id: 'dsh-git-commit-agent/card-configure',
            order: 0,
            locale: CARD_ACTION_LOCALE,
          }, function (props) {
            return h(CardConfigureAction, {
              presetId: props.presetId,
              t: props.t,
              ctx: ctx,
            })
          })
        })
      }
    }

    // Internal hooks for the unit tests; the module table ignores them.
    exports.__test = {
      buildPlanningPrompt: buildPlanningPrompt,
      resolvePromptLanguage: resolvePromptLanguage,
      promptLanguageFor: promptLanguageFor,
      readPromptLanguageValue: readPromptLanguageValue,
      readDefaultModelValue: readDefaultModelValue,
      loadModelCatalog: loadModelCatalog,
      applyStoredDefaultModel: applyStoredDefaultModel,
      modelKey: modelKey,
      CardConfigureAction: CardConfigureAction,
      ConfigureDialog: ConfigureDialog,
      LanguageOptionsBox: LanguageOptionsBox,
      ModelOptionsBox: ModelOptionsBox,
      CARD_ACTION_LOCALE: CARD_ACTION_LOCALE,
      CARD_ACTION_COPY: CARD_ACTION_COPY,
      CONFIGURED_PRESET_ID: CONFIGURED_PRESET_ID,
      PROMPT_LANGUAGE_IDS: PROMPT_LANGUAGE_IDS,
      DEFAULT_MODEL_FIELD: DEFAULT_MODEL_FIELD,
      SETTINGS_NAMESPACE: SETTINGS_NAMESPACE,
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
