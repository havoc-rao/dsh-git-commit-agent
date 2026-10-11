/** Pin the stable public entry while host implementation modules are reorganized. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as entry from '../src/index.js'
import * as plugin from '../src/host/plugin.js'
import { requestPlanApproval } from '../src/host/approval.js'
import { Config, PROFILE_ENTRY_ID } from '../src/host/settings.js'
import * as preferences from '../src/shared/config.js'

test('public entry preserves exactly the existing runtime exports', () => {
  assert.deepEqual(Object.keys(entry).sort(), [
    'COMMIT_AGENT_DEFAULT_MODEL_FIELD',
    'COMMIT_AGENT_PRESET_ID',
    'COMMIT_AGENT_PROMPT_LANGUAGE_FIELD',
    'Config',
    'PROFILE_ENTRY_ID',
    'PROMPT_LANGUAGE_IDS',
    'PROMPT_LANGUAGE_PATTERN',
    'apply',
    'createCommitAgentPlugin',
    'inject',
    'isDefaultModelPreference',
    'name',
    'requestPlanApproval',
    'resolvePromptLanguage',
  ].sort())
})

test('public entry re-exports the original implementation identities without wrappers', () => {
  assert.equal(entry.apply, plugin.apply)
  assert.equal(entry.createCommitAgentPlugin, plugin.createCommitAgentPlugin)
  assert.equal(entry.inject, plugin.inject)
  assert.equal(entry.name, plugin.name)
  assert.equal(entry.COMMIT_AGENT_PRESET_ID, plugin.COMMIT_AGENT_PRESET_ID)
  assert.equal(entry.Config, Config)
  assert.equal(entry.PROFILE_ENTRY_ID, PROFILE_ENTRY_ID)
  assert.equal(entry.requestPlanApproval, requestPlanApproval)
  for (const key of Object.keys(preferences) as Array<keyof typeof preferences>) {
    assert.equal(entry[key], preferences[key])
  }
})
