/**
 * Durable preferences for the git-commit agent.
 *
 * Preferences live on the plugin's own settings namespace (profile entry id
 * `git-commit-agent`), are declared as volatile Config fields, and are read
 * at session-admission time so a mid-flight session never sees its prompt
 * language (or default model) change underneath it.
 *
 * The prompt-language preference is deliberately independent from the UI
 * locale: the client button labels, the host approval copy and the
 * model-visible prompt are three separate text planes, and only the prompt
 * plane is controlled here.
 */

/** Settings field name carrying the preference. */
export const COMMIT_AGENT_PROMPT_LANGUAGE_FIELD = 'promptLanguage'

/** Accepted preference values; `follow-ui` delegates to the active UI locale. */
export const PROMPT_LANGUAGE_IDS = ['zh', 'en', 'follow-ui'] as const

/** One accepted preference value. */
export type PromptLanguagePreference = (typeof PROMPT_LANGUAGE_IDS)[number]

/** Languages the prompt builders can actually emit. */
export type ResolvedPromptLanguage = 'zh' | 'en'

/** Wire/validation pattern for the preference field. */
export const PROMPT_LANGUAGE_PATTERN = /^(zh|en|follow-ui)$/u

/** Locale prefix that maps to a Chinese prompt when following the UI. */
const ZH_LOCALE_PREFIX = 'zh'

/**
 * Resolve a stored preference against the active UI locale.
 *
 * `follow-ui` and an absent/invalid stored value delegate to the locale;
 * anything else is pinned to the stored language. The result is what gets
 * frozen into a session's first prompt.
 * @param preference Stored field value (`undefined` when unset or unreadable).
 * @param activeLocale Active UI locale tag (`zh-CN`, `en`, ...).
 * @returns The prompt language to use.
 */
export function resolvePromptLanguage(preference: unknown, activeLocale: string): ResolvedPromptLanguage {
  if (preference === 'zh') return 'zh'
  if (preference === 'en') return 'en'
  return activeLocale.toLowerCase().startsWith(ZH_LOCALE_PREFIX) ? 'zh' : 'en'
}

/** Settings field name carrying the default LLM model preference. */
export const COMMIT_AGENT_DEFAULT_MODEL_FIELD = 'defaultModel'

/**
 * One exact provider/model route pinned as the agent's default LLM model.
 *
 * The route is the same shape the host's `ModelSelection` and the plugin's
 * row-config `agentOptions` use: a provider id plus the provider-owned model
 * id, both as advertised by the model catalog. No reasoning effort is stored —
 * an absent effort follows the adapter default, exactly like the host's own
 * `agentDefaultModel` selection.
 */
export interface DefaultModelPreference {
  readonly provider: string
  readonly model: string
}

/**
 * Tolerant validator for a stored default-model preference.
 *
 * The field is optional by design: **no default model is a valid preference**
 * (the deployment `agentOptions` row or the host default then applies). A
 * malformed stored value (partial object, empty ids, wrong types) must degrade
 * to "no default" instead of throwing at session admission.
 * @param value Stored field value.
 * @returns Whether the value is a usable provider/model route.
 */
export function isDefaultModelPreference(value: unknown): value is DefaultModelPreference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const { provider, model } = value as Record<string, unknown>
  return (
    typeof provider === 'string'
    && provider !== ''
    && typeof model === 'string'
    && model !== ''
  )
}
