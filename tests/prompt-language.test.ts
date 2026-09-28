/**
 * Prompt-language preference tests.
 *
 * The preference is the single control for which language gets frozen into a
 * committed session's first prompt. These tests pin the resolution rules
 * (pinned zh/en beat the UI locale; follow-ui and absence delegate to it) and
 * the bilingual outputs of both prompt builders, so the two session entry
 * paths (GitLens button and the business API) cannot silently disagree.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PROMPT_LANGUAGE_IDS,
  PROMPT_LANGUAGE_PATTERN,
  resolvePromptLanguage,
} from '../src/config.js'
import { buildCommitAgentSystemPrompt, buildInitialPlanRequest, type PlanPromptInput } from '../src/host/session.js'

test('PROMPT_LANGUAGE_IDS lists exactly the editable choices', () => {
  assert.deepEqual([...PROMPT_LANGUAGE_IDS], ['zh', 'en', 'follow-ui'])
})

test('PROMPT_LANGUAGE_PATTERN matches every accepted value and rejects others', () => {
  for (const id of PROMPT_LANGUAGE_IDS) {
    assert.ok(PROMPT_LANGUAGE_PATTERN.test(id), `${id} should validate`)
  }
  for (const bad of ['', 'fr', 'ZH', 'zh-CN', 'followUI', ' zh']) {
    assert.equal(PROMPT_LANGUAGE_PATTERN.test(bad), false, `${bad} should be rejected`)
  }
})

test('a pinned zh/en preference wins over the UI locale', () => {
  assert.equal(resolvePromptLanguage('zh', 'en'), 'zh')
  assert.equal(resolvePromptLanguage('en', 'zh-CN'), 'en')
})

test('follow-ui and absence delegate to the active UI locale', () => {
  assert.equal(resolvePromptLanguage('follow-ui', 'zh-CN'), 'zh')
  assert.equal(resolvePromptLanguage('follow-ui', 'en-US'), 'en')
  assert.equal(resolvePromptLanguage(undefined, 'zh-Hans-CN'), 'zh')
  assert.equal(resolvePromptLanguage(undefined, 'en'), 'en')
  assert.equal(resolvePromptLanguage(null, 'en'), 'en')
})

test('an invalid stored value degrades to the UI locale instead of throwing', () => {
  assert.equal(resolvePromptLanguage('fr', 'zh'), 'zh')
  assert.equal(resolvePromptLanguage({ weird: true }, 'en'), 'en')
})

test('the system prompt builder emits both languages and defaults to English', () => {
  const zh = buildCommitAgentSystemPrompt('zh')
  assert.ok(zh.includes('你是一个只负责一个 worktree 的 Git 提交规划代理'))
  assert.ok(zh.includes('commit_agent_inspect'))
  const en = buildCommitAgentSystemPrompt('en')
  assert.ok(en.includes('You are a Git commit planning agent for exactly one worktree.'))
  assert.equal(buildCommitAgentSystemPrompt(), en, 'the default is English')
})

test('the initial-plan request builder emits both languages and defaults to English', () => {
  const input: PlanPromptInput = {
    taskId: 'task-1',
    worktreePath: '/repo',
    branch: 'main',
    head: 'abc1234',
    snapshot: { status: 'clean', indexEmpty: true, head: { branch: 'main', commit: 'abc1234' } } as never,
    indexEmpty: true,
  }
  const zh = buildInitialPlanRequest(input, 'zh')
  assert.ok(zh.includes('请为 /repo 这个 worktree 规划提交'))
  assert.ok(zh.includes('任务 id：task-1'))
  const en = buildInitialPlanRequest(input, 'en')
  assert.ok(en.includes('Plan commits for the worktree at /repo.'))
  assert.ok(en.includes('Task id: task-1.'))
  assert.equal(buildInitialPlanRequest(input), en, 'the default is English')
})

test('initial-plan constraints are carried in the same language as the prompt', () => {
  const input: PlanPromptInput = {
    taskId: 'task-2',
    worktreePath: '/repo',
    branch: null,
    head: null,
    snapshot: { status: 'clean', indexEmpty: true, head: null } as never,
    indexEmpty: true,
    userConstraints: 'keep changes small',
  }
  assert.ok(buildInitialPlanRequest(input, 'zh').includes('用户额外添加了这些约束：'))
  assert.ok(buildInitialPlanRequest(input, 'en').includes('The user added these constraints:'))
})