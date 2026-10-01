/**
 * Default-model preference tests.
 *
 * The preference is the optional provider/model route pinned for newly created
 * dedicated sessions: a stored value overrides the deployment `agentOptions`
 * row, and **no value is a valid preference** — the deployment row or the host
 * default model then applies. These tests pin the validator's tolerance (a
 * malformed stored value must degrade to "no default", never throw) and the
 * exported field identity the client half and the host settings service share.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMMIT_AGENT_DEFAULT_MODEL_FIELD,
  isDefaultModelPreference,
  type DefaultModelPreference,
} from '../src/config.js'

test('COMMIT_AGENT_DEFAULT_MODEL_FIELD addresses the volatile settings field', () => {
  assert.equal(COMMIT_AGENT_DEFAULT_MODEL_FIELD, 'defaultModel')
})

test('a complete provider/model route validates', () => {
  const value: DefaultModelPreference = { provider: 'deepseek', model: 'deepseek-chat' }
  assert.equal(isDefaultModelPreference(value), true)
  assert.equal(isDefaultModelPreference({ provider: 'anthropic', model: 'claude-sonnet-4-5' }), true)
})

test('no stored value is the valid "no default" state', () => {
  assert.equal(isDefaultModelPreference(undefined), false)
  assert.equal(isDefaultModelPreference(null), false)
})

test('malformed stored values degrade to no default instead of throwing', () => {
  // Partial or mistyped routes.
  assert.equal(isDefaultModelPreference({ provider: 'deepseek' }), false)
  assert.equal(isDefaultModelPreference({ model: 'deepseek-chat' }), false)
  assert.equal(isDefaultModelPreference({ provider: '', model: 'deepseek-chat' }), false)
  assert.equal(isDefaultModelPreference({ provider: 'deepseek', model: '' }), false)
  assert.equal(isDefaultModelPreference({ provider: 1, model: 'deepseek-chat' }), false)
  // Wrong containers.
  assert.equal(isDefaultModelPreference('deepseek/deepseek-chat'), false)
  assert.equal(isDefaultModelPreference(['deepseek', 'deepseek-chat']), false)
  assert.equal(isDefaultModelPreference({}), false)
  assert.equal(isDefaultModelPreference({ provider: 'deepseek', model: 'deepseek-chat', extra: true }), true)
})