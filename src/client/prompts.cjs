/** Dedicated-agent and ordinary-session prompt contracts in both languages. */

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

/** Tool-agnostic request for an ordinary session; no plugin tool/approval contract. */
function buildCurrentSessionPrompt(worktree, language) {
  return (language === 'en' ? [
    'Use the tools already available in this session to commit the changes in this worktree.',
    'worktree: ' + worktree,
    '',
    'I authorize this commit task once in the current session; stage and commit directly without asking me to approve a plan again. This does not bypass tool approvals or authorize future commit tasks.',
    'Read the real Git status, staged and unstaged diffs, and untracked file contents; never guess. Preserve existing staged content and include it in the first commit; stage unstaged and untracked changes yourself.',
    'Use small, logically coherent commits. If scope is unclear, unrelated work cannot be safely separated, or changes occur after inspection, stop and ask. Never discard work, amend or push unless separately requested; never blindly retry a failed commit.',
    'Verify the resulting commits and remaining Git status. Keep output brief and in English: commit hashes, messages and any remaining changes are enough; no lengthy plan, file table or approval guidance.',
  ] : [
    '请使用当前会话已有的工具，提交这个 worktree 的改动。',
    'worktree: ' + worktree,
    '',
    '我授权本次会话直接执行一次提交任务，无需再展示计划等待确认；这不绕过工具审批，也不授权后续提交任务。',
    '先读取真实 Git 状态、已暂存与未暂存 diff、未跟踪文件内容，不要猜测。保留已有暂存内容并纳入第一个提交，未暂存与未跟踪改动由你自行暂存。',
    '按逻辑组织为小而完整的提交。范围不明确、无关改动无法安全拆分或检查后发生变化时，停下来询问。不要丢弃工作，未经单独要求不要 amend 或 push；提交失败不要盲目重试。',
    '核验提交结果与剩余 Git 状态。使用中文简短汇报提交编号、提交信息和剩余改动即可，不需要长篇计划、文件表格或确认引导。',
  ]).join('\n')
}

module.exports = { buildPlanningPrompt, buildCurrentSessionPrompt }
