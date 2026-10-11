/** Preset configuration dictionary, picker artwork and preference editor components. */
const { React, h } = require('./runtime.cjs')
const { service } = require('./context.cjs')
const { CONFIGURED_PRESET_ID, PROMPT_LANGUAGE_IDS, SETTINGS_NAMESPACE, PROMPT_LANGUAGE_FIELD, DEFAULT_MODEL_FIELD } = require('./constants.cjs')
const { readPromptLanguageValue, readDefaultModelValue, loadModelCatalog, modelKey } = require('./settings.cjs')
/** Locale namespace and copy for the preset-card configuration action. */
const CARD_ACTION_LOCALE = 'commitAgent.cardAction'
const CARD_ACTION_COPY = {
  zh: {
    label: '配置',
    close: '关闭',
    title: 'Git Commit Agent 配置',
    promptLanguage: '提示词语言',
    hint: '用于新创建的会话；已开始的会话保持创建时的语言。不改变界面语言。',
    zh: '中文',
    en: 'English',
    followUi: '跟随界面语言',
    defaultModel: '默认模型',
    defaultModelNone: '跟随宿主默认（不指定）',
    modelHint: '新创建的提交会话使用所选模型；不指定时使用部署配置或宿主默认模型。',
    modelLoading: '正在读取模型列表…',
    modelUnavailable: '模型列表不可用：请在模型设置中确认至少一个提供商已配置。',
    save: '保存',
    saved: '已保存',
    failed: '保存失败，请重试',
  },
  en: {
    label: 'Configure',
    close: 'Close',
    title: 'Git Commit Agent configuration',
    promptLanguage: 'Prompt language',
    hint: 'Applies to newly created sessions; running sessions keep their starting language. Does not change the UI language.',
    zh: '中文',
    en: 'English',
    followUi: 'Follow UI language',
    defaultModel: 'Default model',
    defaultModelNone: 'Follow the host default (not specified)',
    modelHint: 'Newly created commit sessions use the selected model; when unset, the deployment config or the host default model applies.',
    modelLoading: 'Loading the model list…',
    modelUnavailable: 'The model list is unavailable: make sure at least one provider is configured in the model settings.',
    save: 'Save',
    saved: 'Saved',
    failed: 'Save failed, please retry',
  },
}

/**
 * Gear artwork for the configuration trigger, matching the DSH settings
 * outline icon (16×16 viewBox, 1px stroke; path data from
 * ui-primitives `IconSettingsOutlineArtwork`). The label rides `data-tip`
 * on the button; the svg itself is decorative.
 */
function GearIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 },
    h('path', { d: 'M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z', stroke: 'currentColor' }),
    h('path', { d: 'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z', stroke: 'currentColor', strokeMiterlimit: 10 }),
  )
}

/** Chevron artwork for the option control, matching the settings switcher
 *  (ui-primitives `IconChevronDownOutline`, 16×16 viewBox, 1px stroke). */
function ChevronDownIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1, className: 'dsh-gca-chevron' },
    h('path', { d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', stroke: 'currentColor' }),
  )
}

/** Check artwork marking the selected option (ui-primitives `IconCheckOutline`). */
function CheckIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 },
    h('path', { d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4', stroke: 'currentColor' }),
  )
}

/**
 * Popup option card for one language choice, following the shared compact
 * Menu surface (PopupSelectView `.card` + MenuSurface `.material`): rows
 * hover, the current draft carries a trailing check, Escape dismisses.
 */
function LanguageOptionsBox(props) {
  const t = props.t
  const onKeyDown = function (event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      props.onDismiss()
    }
  }
  const rows = PROMPT_LANGUAGE_IDS.map(function (id) {
    const selected = id === props.draft
    return h('button', {
      type: 'button',
      key: id,
      role: 'option',
      'aria-selected': selected ? 'true' : 'false',
      className: 'dsh-gca-dialog-option',
      onClick: function () { props.onSelect(id) },
    },
      h('span', null, t(id)),
      selected
        ? h('span', { className: 'dsh-gca-dialog-optionCheck' }, h(CheckIcon))
        : null,
    )
  })
  return h('div', {
    className: 'dsh-gca-dialog-options',
    role: 'listbox',
    'aria-label': t('promptLanguage'),
    onKeyDown: onKeyDown,
  }, rows)
}

/**
 * Popup option card for the default-model choice: the no-default row
 * first, then one row per catalog model grouped by provider. Rows carry
 * the display name plus the exact route; Escape dismisses like the
 * language card.
 */
function ModelOptionsBox(props) {
  const t = props.t
  const onKeyDown = function (event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      props.onDismiss()
    }
  }
  const isSelected = function (route) {
    const draft = props.draft
    return draft !== null && draft !== undefined
      && draft.provider === route.provider && draft.model === route.model
  }
  const rows = []
  const noneSelected = props.draft === null || props.draft === undefined
  rows.push(h('button', {
    type: 'button',
    key: 'none',
    role: 'option',
    'aria-selected': noneSelected ? 'true' : 'false',
    className: 'dsh-gca-dialog-option',
    onClick: function () { props.onSelect(null) },
  },
    h('span', null, t('defaultModelNone')),
    noneSelected ? h('span', { className: 'dsh-gca-dialog-optionCheck' }, h(CheckIcon)) : null,
  ))
  const groups = Array.isArray(props.catalog) ? props.catalog : []
  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue
    const models = Array.isArray(group.models) ? group.models : []
    if (models.length === 0) continue
    const provider = String(group.id || '')
    const providerName = String(group.name || provider)
    if (provider === '') continue
    rows.push(h('div', {
      key: 'group:' + provider,
      className: 'dsh-gca-dialog-group',
      role: 'presentation',
    }, providerName))
    for (const model of models) {
      if (model === null || typeof model !== 'object') continue
      const modelId = String(model.id || '')
      if (modelId === '') continue
      const route = { provider: provider, model: modelId }
      const selected = isSelected(route)
      rows.push(h('button', {
        type: 'button',
        key: modelKey(route),
        role: 'option',
        'aria-selected': selected ? 'true' : 'false',
        className: 'dsh-gca-dialog-option',
        onClick: function () { props.onSelect(route) },
      },
        h('span', { className: 'dsh-gca-dialog-modelText' },
          h('span', null, String(model.name || modelId)),
          h('span', { className: 'dsh-gca-dialog-modelRoute' }, providerName + ' · ' + provider + '/' + modelId),
        ),
        selected ? h('span', { className: 'dsh-gca-dialog-optionCheck' }, h(CheckIcon)) : null,
      ))
    }
  }
  return h('div', {
    className: 'dsh-gca-dialog-options',
    role: 'listbox',
    'aria-label': t('defaultModel'),
    onKeyDown: onKeyDown,
  }, rows)
}

/** Trigger label for the current model draft: a friendly name once the
 *  catalog is loaded, the exact route otherwise (a stored model that
 *  vanished from the catalog stays recognizable). */
function modelOptionLabel(t, catalog, draft) {
  if (draft === null || draft === undefined) return t('defaultModelNone')
  if (catalog !== null && catalog !== undefined && typeof catalog === 'object') {
    for (const group of Array.isArray(catalog.groups) ? catalog.groups : []) {
      if (group === null || typeof group !== 'object' || String(group.id) !== draft.provider) continue
      for (const model of Array.isArray(group.models) ? group.models : []) {
        if (model === null || typeof model !== 'object' || String(model.id) !== draft.model) continue
        return h('span', { className: 'dsh-gca-dialog-modelText' },
          h('span', null, String(model.name || model.id)),
          h('span', { className: 'dsh-gca-dialog-modelRoute' }, ' · ' + String(group.name || group.id)),
        )
      }
    }
  }
  return h('span', { className: 'dsh-gca-dialog-modelText' },
    h('span', null, draft.provider + '/' + draft.model),
  )
}

/** Modal editing the prompt-language and default-model preferences through configForms. */
function ConfigureDialog(props) {
  const t = props.t
  const [draft, setDraft] = React.useState(props.initialValue)
  const [modelDraft, setModelDraft] = React.useState(props.initialModel) // {provider, model} | null
  const [status, setStatus] = React.useState('idle') // idle | saving | saved | failed
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  const [modelOptionsOpen, setModelOptionsOpen] = React.useState(false)
  const wrapRef = React.useRef(null)
  const modelWrapRef = React.useRef(null)
  const onKeyDown = function (event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
    }
  }
  /** Dismiss both popup cards and detach their outside-pointer listener. */
  const dismissOptions = function () {
    setOptionsOpen(false)
    setModelOptionsOpen(false)
    if (typeof document !== 'undefined' && typeof Node !== 'undefined') {
      document.removeEventListener('pointerdown', onDocPointerDown, true)
    }
  }
  /** Any pointer outside both option controls closes the popups (PopupSelectView capture). */
  const onDocPointerDown = function (event) {
    const outside = function (ref) {
      return ref.current === null || !(event.target instanceof Node) || !ref.current.contains(event.target)
    }
    if (outside(wrapRef) && outside(modelWrapRef)) dismissOptions()
  }
  const toggleOptions = function () {
    if (optionsOpen) {
      dismissOptions()
      return
    }
    setOptionsOpen(true)
    setModelOptionsOpen(false)
    if (typeof document !== 'undefined' && typeof Node !== 'undefined') {
      document.addEventListener('pointerdown', onDocPointerDown, true)
    }
  }
  const toggleModelOptions = function () {
    if (modelOptionsOpen) {
      dismissOptions()
      return
    }
    setModelOptionsOpen(true)
    setOptionsOpen(false)
    if (typeof document !== 'undefined' && typeof Node !== 'undefined') {
      document.addEventListener('pointerdown', onDocPointerDown, true)
    }
  }
  const onSave = async function () {
    setStatus('saving')
    const forms = service(props.ctx, 'configForms')
    let accepted = false
    try {
      const form = forms && typeof forms.get === 'function' ? forms.get(SETTINGS_NAMESPACE) : undefined
      if (form) {
        const languageOp = { op: 'set', path: ['promptLanguage'], value: draft }
        const modelOp = modelDraft === null || modelDraft === undefined
          ? { op: 'unset', path: ['defaultModel'] }
          : { op: 'set', path: ['defaultModel'], value: { provider: modelDraft.provider, model: modelDraft.model } }
        if (typeof form.mutate === 'function') {
          // One atomic mutation: both preferences land or neither does.
          accepted = await form.mutate([languageOp, modelOp])
        } else if (typeof form.set === 'function') {
          accepted = await form.set(PROMPT_LANGUAGE_FIELD, draft)
          if (accepted) {
            accepted = modelDraft === null || modelDraft === undefined
              ? (typeof form.unset === 'function' ? Boolean(await form.unset(DEFAULT_MODEL_FIELD)) : true)
              : Boolean(await form.set(DEFAULT_MODEL_FIELD, { provider: modelDraft.provider, model: modelDraft.model }))
          }
        }
      }
    } catch (error) {
      void error
    }
    setStatus(accepted ? 'saved' : 'failed')
  }
  const catalogAvailable = props.catalog !== null && props.catalog !== undefined
  // Container/backdrop aligned with the DSH settings shell: fixed overlay,
  // masked blur backdrop, elevated panel; close via Escape / mask / button.
  return h('div', { className: 'dsh-gca-dialog-overlay', role: 'presentation' },
    h('div', { className: 'dsh-gca-dialog-mask', 'aria-hidden': 'true', onClick: props.onClose }),
    h('div', {
      className: 'dsh-gca-dialog-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('title'),
      onKeyDown: onKeyDown,
    },
      h('div', { className: 'dsh-gca-dialog-header' },
        h('h4', null, t('title')),
        h('button', {
          type: 'button',
          className: 'dsh-gca-dialog-close',
          'aria-label': t('close'),
          // Receive focus when the dialog opens, matching the settings panel.
          autoFocus: true,
          onClick: props.onClose,
        }, '✕'),
      ),
      h('div', { className: 'dsh-gca-dialog-body' },
        h('label', { className: 'dsh-gca-dialog-label' }, t('promptLanguage')),
        h('div', { className: 'dsh-gca-dialog-select-wrap', ref: wrapRef },
          h('button', {
            type: 'button',
            className: 'dsh-gca-dialog-select',
            'aria-label': t('promptLanguage'),
            'aria-haspopup': 'listbox',
            'aria-expanded': optionsOpen ? 'true' : 'false',
            onClick: toggleOptions,
          }, h('span', null, t(draft))),
          h(ChevronDownIcon),
          optionsOpen
            ? h(LanguageOptionsBox, {
                t: t,
                draft: draft,
                onSelect: function (id) {
                  setDraft(id)
                  setStatus('idle')
                  dismissOptions()
                },
                onDismiss: dismissOptions,
              })
            : null,
        ),
        h('p', { className: 'dsh-gca-dialog-hint' }, t('hint')),
        h('label', { className: 'dsh-gca-dialog-label' }, t('defaultModel')),
        h('div', { className: 'dsh-gca-dialog-select-wrap', ref: modelWrapRef },
          h('button', {
            type: 'button',
            className: 'dsh-gca-dialog-select',
            'aria-label': t('defaultModel'),
            'aria-haspopup': 'listbox',
            'aria-expanded': modelOptionsOpen ? 'true' : 'false',
            onClick: toggleModelOptions,
          }, modelOptionLabel(t, props.catalog, modelDraft)),
          h(ChevronDownIcon),
          modelOptionsOpen
            ? h(ModelOptionsBox, {
                t: t,
                catalog: catalogAvailable ? props.catalog.groups : [],
                draft: modelDraft,
                onSelect: function (route) {
                  setModelDraft(route)
                  setStatus('idle')
                  dismissOptions()
                },
                onDismiss: dismissOptions,
              })
            : null,
        ),
        // The list may still be loading while the dialog is open; a
        // missing list must not hide the valid "follow host default"
        // choice.
        !catalogAvailable
          ? h('p', { className: 'dsh-gca-dialog-hint' }, t('modelLoading'))
          : props.catalog.failed && props.catalog.groups.length === 0
            ? h('p', { className: 'dsh-gca-dialog-hint' }, t('modelUnavailable'))
            : h('p', { className: 'dsh-gca-dialog-hint' }, t('modelHint')),
        status === 'saved'
          ? h('p', { className: 'dsh-gca-dialog-ok' }, t('saved'))
          : null,
        status === 'failed'
          ? h('p', { className: 'dsh-gca-dialog-error' }, t('failed'))
          : null,
        h('div', { className: 'dsh-gca-dialog-actions' },
          h('button', { type: 'button', className: 'dsh-gca-secondary', onClick: props.onClose }, t('close')),
          h('button', {
            type: 'button',
            className: 'dsh-gca-primary',
            disabled: status === 'saving',
            onClick: onSave,
          }, t('save')),
        ),
      ),
    ),
  )
}

/** The preset-card configuration action contributed to the card-action slot. */
function CardConfigureAction(props) {
  const t = props.t
  const [open, setOpen] = React.useState(false)
  const [initialValue, setInitialValue] = React.useState('follow-ui')
  const [initialModel, setInitialModel] = React.useState(null)
  const [catalog, setCatalog] = React.useState(null) // null | { groups, failed }
  const triggerRef = React.useRef(null)
  const closeDialog = function () {
    setOpen(false)
    // Return focus to the trigger once the dialog closes (settings
    // panel behavior); a test renderer without DOM refs skips this.
    if (triggerRef.current !== null && typeof triggerRef.current.focus === 'function') {
      triggerRef.current.focus()
    }
  }
  // Only presets that own protocol-registered config show the action. The
  // slot contract renders a null contribution with zero placeholder, so
  // every other card stays untouched (the host's read-only "查看配置"
  // button is separate and unaffected).
  if (props.presetId !== CONFIGURED_PRESET_ID) return null
  // A `display: contents` div keeps the trigger and the dialog edge-free in
  // the card footer while staying compatible with every React version.
  return h('div', { className: 'dsh-gca-card-actions' },
    h('button', {
      type: 'button',
      className: 'dsh-gca-configure',
      'aria-label': t('label') + ': ' + String(props.presetId),
      'data-tip': t('label'),
      ref: triggerRef,
      onClick: function () {
        setInitialValue(readPromptLanguageValue(props.ctx))
        setInitialModel(readDefaultModelValue(props.ctx))
        setOpen(true)
        // Refresh the host model list in the background; the dialog shows
        // a loading note until it settles.
        Promise.resolve(loadModelCatalog(props.ctx)).then(function (loaded) {
          setCatalog(loaded)
        }).catch(function () {})
      },
    }, h(GearIcon)),
    open
      ? h(ConfigureDialog, {
          ctx: props.ctx,
          t: t,
          initialValue: initialValue,
          initialModel: initialModel,
          catalog: catalog,
          onClose: closeDialog,
        })
      : null,
  )
}

module.exports = { CARD_ACTION_LOCALE, CARD_ACTION_COPY, CardConfigureAction, ConfigureDialog, LanguageOptionsBox, ModelOptionsBox }
