/** Host settings schema and live preference lookup at session admission. */
import z from '@deepseek-ai/schemastery'
import {
  COMMIT_AGENT_DEFAULT_MODEL_FIELD,
  COMMIT_AGENT_PROMPT_LANGUAGE_FIELD,
  PROMPT_LANGUAGE_PATTERN,
  isDefaultModelPreference,
  type DefaultModelPreference,
  type PromptLanguagePreference,
} from '../shared/config.js'
import type { HostSettingsForms } from './types.js'

/**
 * Volatile settings schema for this plugin's profile entry (`git-commit-agent`).
 *
 * Following the locale preference template (`packages/client/locale`): only
 * the volatile fields are editable live; everything else stays in the cordis
 * row. The schema instance comes from this plugin's own schemastery
 * dependency (same version as the host), and the host settings service reads
 * it structurally (`meta`, `dict`, `toJSON`), so no host package import is
 * needed on the plugin side.
 */
export const Config = z.object({
  /** Prompt language applied to newly admitted sessions; `follow-ui` delegates to the UI locale. */
  [COMMIT_AGENT_PROMPT_LANGUAGE_FIELD]: z.string().pattern(PROMPT_LANGUAGE_PATTERN).volatile(),
  /**
   * Default LLM route (provider/model from the model catalog) applied to newly
   * created dedicated sessions. Optional on purpose: when the field is absent
   * the deployment `agentOptions` row applies, and when that is absent too the
   * host default model is used.
   */
  [COMMIT_AGENT_DEFAULT_MODEL_FIELD]: z.object({
    provider: z.string(),
    model: z.string(),
  }).volatile(),
})

/**
 * The settings namespace = the profile entry id (the cordis row `id` in
 * `cordis.patch.yml`, NOT the module name). The host settings service finds an
 * entry by `entry.options.id` and rejects every other key with
 * "No configurable plugin entry", so this must match the patch row exactly.
 * Kept in sync by hand with `cordis.patch.yml` and the `src/client` settings modules
 * (`SETTINGS_NAMESPACE`).
 */
export const PROFILE_ENTRY_ID = 'git-commit-agent'


/**
 * Read the stored prompt-language preference from the plugin's own settings
 * namespace. Hosts without the settings service report `undefined`, which
 * resolves to the default language (`en` on the host plane, which has no UI
 * locale to follow).
 */
export function readStoredPromptLanguage(settings: HostSettingsForms | undefined): PromptLanguagePreference | undefined {
  if (settings === undefined || typeof settings.describe !== 'function') return undefined
  const row = settings.describe().find((entry) => entry.ns === PROFILE_ENTRY_ID)
  const value = row?.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[COMMIT_AGENT_PROMPT_LANGUAGE_FIELD]
  return typeof field === 'string' ? field as PromptLanguagePreference : undefined
}

/**
 * Read the stored default-model preference from the plugin's own settings
 * namespace, with the same entry-id addressing as
 * {@link readStoredPromptLanguage}. Hosts without the settings service (or
 * with a malformed stored value) report no default.
 */
export function readStoredDefaultModel(settings: HostSettingsForms | undefined): DefaultModelPreference | undefined {
  if (settings === undefined || typeof settings.describe !== 'function') return undefined
  const row = settings.describe().find((entry) => entry.ns === PROFILE_ENTRY_ID)
  const value = row?.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[COMMIT_AGENT_DEFAULT_MODEL_FIELD]
  return isDefaultModelPreference(field) ? field : undefined
}
