/** Stable public host-plugin entry; implementation lives in the host plane. */
export { name, inject, COMMIT_AGENT_PRESET_ID, createCommitAgentPlugin, apply } from './host/plugin.js'
export { Config, PROFILE_ENTRY_ID } from './host/settings.js'
export { requestPlanApproval } from './host/approval.js'
export type { CommitAgentConfig, GitCommitAgentApi, CommitAgentPlugin } from './host/api.js'
export {
  COMMIT_AGENT_DEFAULT_MODEL_FIELD,
  COMMIT_AGENT_PROMPT_LANGUAGE_FIELD,
  PROMPT_LANGUAGE_IDS,
  PROMPT_LANGUAGE_PATTERN,
  resolvePromptLanguage,
  isDefaultModelPreference,
  type PromptLanguagePreference,
  type ResolvedPromptLanguage,
  type DefaultModelPreference,
} from './shared/config.js'
