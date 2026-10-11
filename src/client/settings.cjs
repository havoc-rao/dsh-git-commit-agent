/** Preference resolution, guarded model RPC access and model-route identity. */
const { service } = require('./context.cjs')
const { SETTINGS_NAMESPACE, PROMPT_LANGUAGE_FIELD, DEFAULT_MODEL_FIELD } = require('./constants.cjs')
/**
 * Resolve a stored preference against the active UI locale. Mirrors
 * `src/shared/config.ts` `resolvePromptLanguage`; the host builds its prompts
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

module.exports = { resolvePromptLanguage, promptLanguageFor, readPromptLanguageValue, readDefaultModelValue, remoteSession, modelKey, loadModelCatalog, applyStoredDefaultModel }
