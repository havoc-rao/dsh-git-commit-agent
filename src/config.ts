/**
 * Durable prompt-language preference for the git-commit agent.
 *
 * The preference lives on the plugin's own settings namespace (profile entry
 * id `git-commit-agent`), is declared as a volatile Config field, and is read
 * at session-admission time so a mid-flight session never sees its prompt
 * language change underneath it.
 *
 * The preference is deliberately independent from the UI locale: the client
 * button labels, the host approval copy and the model-visible prompt are three
 * separate text planes, and only the prompt plane is controlled here.
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