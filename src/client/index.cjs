/** Client composition root: host slots and compatibility test hooks. */
const { h } = require('./runtime.cjs')
const { service } = require('./context.cjs')
const { ACTION_ID, PREPARE_TOOL, APPLY_TOOL, CONFIGURED_PRESET_ID, PROMPT_LANGUAGE_IDS, DEFAULT_MODEL_FIELD, SETTINGS_NAMESPACE } = require('./constants.cjs')
const { injectStyles } = require('./styles.cjs')
const { buildPlanningPrompt } = require('./prompts.cjs')
const { resolvePromptLanguage, promptLanguageFor, readPromptLanguageValue, readDefaultModelValue, loadModelCatalog, applyStoredDefaultModel, modelKey } = require('./settings.cjs')
const { CARD_ACTION_LOCALE, CARD_ACTION_COPY, CardConfigureAction, ConfigureDialog, LanguageOptionsBox, ModelOptionsBox } = require('./settings-ui.cjs')
const { startPlanning } = require('./session.cjs')
const { applyCommandPalette } = require('./command-palette/index.cjs')
const { loadRepositoryLinks, openRepositoryLinks } = require('./command-palette/repository-link.cjs')
const { CommitAction } = require('./git-action.cjs')
const { planMetaOf, planIdentity, planKind, planUrl } = require('./plan-model.cjs')
const { FullPlan, PlanPage } = require('./plan-views.cjs')
const { openPlanDiff, createPlanSidebar, observePlans } = require('./plan-sidebar.cjs')
const { PlanCard, ApplyCard } = require('./plan-cards.cjs')

/** Client services this plugin waits for (Cordis service names, not packages). */
exports.inject = ['slots', 'sessions', 'betterSidebar', 'sidebarRight']

/**
 * Register the client contributions.
 * @param ctx - the client plugin context.
 */
exports.apply = async function apply(ctx) {
  injectStyles()

  applyCommandPalette(ctx)

  const sidebar = service(ctx, 'betterSidebar')
  const planSidebar = createPlanSidebar(ctx)
  if (typeof ctx.effect === 'function') {
    ctx.effect(function () {
      const stop = observePlans(ctx, planSidebar)
      return function () { stop(); planSidebar.dispose() }
    })
  }
  // No legacy registry registration: the root slot handles late arrival,
  // teardown and remount, and contributes exactly one item in More.
  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    ctx.slots.inject('betterSidebar.git.actions', function () {
      return ctx.slots.register({
        name: 'betterSidebar.git.actions',
        id: ACTION_ID,
        order: 50,
      }, function (props) {
        return h(CommitAction, {
          ...props,
          start: function () { return startPlanning(ctx, props) },
        })
      })
    })
  }
  if (sidebar === undefined || sidebar === null) {
    if (ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info('dsh-git-commit-agent: betterSidebar is unavailable, the Git action slot waits for its owner')
    }
  }

  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: PREPARE_TOOL }, function (props) {
        return h(PlanCard, {
          block: props.block,
          sessionId: props.sessionId,
          openPlan: function (meta, sessionId, location) { return planSidebar.open(meta, sessionId, location) },
          openDiff: function (entry, sessionId) {
            openPlanDiff(ctx, entry && entry.planId, entry && entry.revision, entry, sessionId)
          },
        })
      })
      yield ctx.slots.register({ name: 'tool.call.toolview', key: APPLY_TOOL }, function (props) {
        return h(ApplyCard, { block: props.block })
      })
    })
  }

  // Preset-card configuration action (host slot `settings.agentPreset.card.action`):
  // owns its dictionary, idle when the host page has no such slot.
  const localeSvc = service(ctx, 'locale')
  if (localeSvc && typeof localeSvc.register === 'function') {
    localeSvc.register(CARD_ACTION_LOCALE, { zh: CARD_ACTION_COPY.zh, en: CARD_ACTION_COPY.en })
  }
  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    ctx.slots.inject('settings.agentPreset.card.action', function* () {
      yield ctx.slots.register({
        name: 'settings.agentPreset.card.action',
        id: 'dsh-git-commit-agent/card-configure',
        order: 0,
        locale: CARD_ACTION_LOCALE,
      }, function (props) {
        return h(CardConfigureAction, {
          presetId: props.presetId,
          t: props.t,
          ctx: ctx,
        })
      })
    })
  }
}

// Internal hooks for the unit tests; the module table ignores them.
exports.__test = {
  loadRepositoryLinks,
  openRepositoryLinks,
  buildPlanningPrompt: buildPlanningPrompt,
  resolvePromptLanguage: resolvePromptLanguage,
  promptLanguageFor: promptLanguageFor,
  readPromptLanguageValue: readPromptLanguageValue,
  readDefaultModelValue: readDefaultModelValue,
  loadModelCatalog: loadModelCatalog,
  applyStoredDefaultModel: applyStoredDefaultModel,
  modelKey: modelKey,
  CardConfigureAction: CardConfigureAction,
  ConfigureDialog: ConfigureDialog,
  LanguageOptionsBox: LanguageOptionsBox,
  ModelOptionsBox: ModelOptionsBox,
  CARD_ACTION_LOCALE: CARD_ACTION_LOCALE,
  CARD_ACTION_COPY: CARD_ACTION_COPY,
  CONFIGURED_PRESET_ID: CONFIGURED_PRESET_ID,
  PROMPT_LANGUAGE_IDS: PROMPT_LANGUAGE_IDS,
  DEFAULT_MODEL_FIELD: DEFAULT_MODEL_FIELD,
  SETTINGS_NAMESPACE: SETTINGS_NAMESPACE,
  startPlanning: startPlanning,
  openPlanDiff: openPlanDiff,
  CommitAction: CommitAction,
  planIdentity: planIdentity,
  planKind: planKind,
  planUrl: planUrl,
  FullPlan: FullPlan,
  PlanPage: PlanPage,
  createPlanSidebar: createPlanSidebar,
  observePlans: observePlans,
  PlanCard: PlanCard,
  ApplyCard: ApplyCard,
  planMetaOf: planMetaOf,
}
