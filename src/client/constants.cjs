/** Stable plugin identifiers and host protocol contracts. */

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
 * (`src/host/plugin.ts` `COMMIT_AGENT_PRESET_ID`); if a future preset shares the
 * config surface, widen this to a Set/prefix without touching the slot
 * contract — the slot itself stays preset-agnostic.
 */
const CONFIGURED_PRESET_ID = 'git-commit'

/** Editable prompt-language values, in display order. */
const PROMPT_LANGUAGE_IDS = ['zh', 'en', 'follow-ui']

/** Prompt-language preference field name; mirrors `src/shared/config.ts`. */
const PROMPT_LANGUAGE_FIELD = 'promptLanguage'
/** Default-model preference field name; mirrors `src/shared/config.ts`. */
const DEFAULT_MODEL_FIELD = 'defaultModel'
/**
 * Settings namespace = the plugin's profile entry id (the cordis row `id`
 * in `cordis.patch.yml`, NOT the module name): the host settings service
 * addresses entries by `entry.options.id` and rejects any other key with
 * "No configurable plugin entry". Kept in sync by hand with
 * `cordis.patch.yml` and `src/host/settings.ts` (`PROFILE_ENTRY_ID`).
 */
const SETTINGS_NAMESPACE = 'git-commit-agent'

module.exports = { ACTION_ID, DIFF_ID_PREFIX, PREPARE_TOOL, APPLY_TOOL, STYLE_ID, SESSION_ID_PREFIX, CONFIGURED_PRESET_ID, PROMPT_LANGUAGE_IDS, PROMPT_LANGUAGE_FIELD, DEFAULT_MODEL_FIELD, SETTINGS_NAMESPACE }
