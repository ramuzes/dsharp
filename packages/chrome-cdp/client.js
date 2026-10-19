/**
 * dsh-chrome-cdp — browser half.
 *
 * One self-contained script in the client module system's factory format,
 * mirroring packages/feishu-gateway/client.js: window.__ModuleLoader__.load()
 * with the package name and a factory that lazily requires its modules (React
 * and the staged-form primitives are module-table identities, so nothing is
 * bundled) and returns a cordis plugin object.
 *
 * The plugin contributes exactly one thing: the bundle's own configuration
 * card on the Plugins page (the `plugins.bundle.config` slot, keyed by the
 * package name). The card edits mode / endpoint / channel / approvalPolicy /
 * readOnlyTools / toolCallTimeoutMs through a SettingsFormModel over the
 * shared ConfigForm of the `chrome-cdp` row (all volatile except
 * toolCallTimeoutMs), plus a live status section fed by the host half's
 * `chromeCdp` Remote namespace (lib/status.js ChromeCdpStatus). This plugin
 * stores no credentials, so the card has no secret control.
 *
 * Primitive surface (verified in the dsh checkout,
 * packages/client/ui-primitives/src/index.ts): the settings-form module
 * exports SettingsForm, SettingsValueField, SettingsSecretField,
 * SettingsFormModel, settingsTextField, settingsNumberField — there is no
 * select and no multiline/textarea primitive. The two enum fields (mode,
 * approvalPolicy) therefore render as text fields whose hints list the legal
 * values, and readOnlyTools edits one tool name per line in a single-line
 * input (space/comma/newline separated). Field specs follow the
 * SettingsFieldSpec contract (form-model.ts:64-74) and mirror the host
 * Config schema (index.js) so an illegal draft marks the field invalid and
 * blocks the save instead of staging a write the host would reject blindly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chrome-cdp',
  factory(require) {
    const React = require('react')
    const {
      SettingsForm, SettingsValueField, SettingsFormModel, settingsTextField, settingsNumberField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Registration identity: the package name, the slot key the card files under. */
    const ID = 'dsh-chrome-cdp'
    /** The Loader row id whose ConfigForm backs the card (cordis.patch.yml). */
    const ROW = 'chrome-cdp'
    /** This plugin's copy namespace. */
    const NS = 'chromeCdp'

    const zh = {
      'config.summary': '通过 chrome-devtools-mcp 操作本机真实 Chrome：连接模式、调试端点、审批策略与只读工具清单。',
      'config.mode': '连接模式',
      'config.modeHint': 'auto / url / ws 三选一：auto（Chrome ≥144 授权模式）、url（http(s) 调试地址）、ws（ws(s) 端点）',
      'config.endpoint': '调试端点',
      'config.endpointHint': 'mode=url 填 http://…，mode=ws 填 ws://…；mode=auto 必须留空。结构字段，保存后重载插件生效',
      'config.channel': 'Chrome 渠道',
      'config.channelHint': '如 stable / beta / dev / canary，小写字母开头，仅小写字母、数字与连字符；留空恢复 stable',
      'config.approvalPolicy': '审批策略',
      'config.approvalPolicyHint': 'sensitive / all / none 三选一：敏感操作需确认 / 全部需确认 / 全部放行；留空恢复 sensitive',
      'config.readOnlyTools': '只读工具清单',
      'config.readOnlyToolsHint': '工具名以空格、逗号或换行分隔；留空恢复默认清单。sensitive 策略下清单内工具免确认',
      'config.toolCallTimeoutMs': '工具调用超时（毫秒）',
      'config.toolCallTimeoutMsHint': '不小于 1 的毫秒数；留空使用上游默认。结构字段，保存后重载插件生效',
      'config.overridden': '已被上层覆盖',
      'config.reset': '重置',
      'config.invalid': '无效值',
      'config.unavailable': '配置不可用',
      'config.readOnly': '只读',
      'config.saveFailed': '保存失败',
      'config.save': '保存',
      'config.saving': '保存中…',
      'status.title': '连接状态',
      'status.mode': '连接模式',
      'status.endpoint': '调试端点',
      'status.channel': 'Chrome 渠道',
      'status.approvalPolicy': '审批策略',
      'status.readOnlyToolCount': '只读工具数',
      'status.serverEntry': 'MCP 服务入口',
      'status.exclusive': '独占挂载',
      'status.exclusiveYes': '是',
      'status.exclusiveNo': '否',
      'status.refresh': '刷新',
      'status.unavailable': '状态不可用（宿主插件未加载或版本过旧）',
    }

    const en = {
      'config.summary': 'Drive the user\u2019s real Chrome over CDP via chrome-devtools-mcp: connection mode, debug endpoint, approval policy, and the read-only tool list.',
      'config.mode': 'Connection mode',
      'config.modeHint': 'One of auto / url / ws — auto (Chrome ≥144 approval mode), url (an http(s) debug address), ws (a ws(s) endpoint)',
      'config.endpoint': 'Debug endpoint',
      'config.endpointHint': 'http://… for mode url, ws://… for mode ws; must stay empty in auto mode. Structural: takes effect after plugin reload',
      'config.channel': 'Chrome channel',
      'config.channelHint': "e.g. stable / beta / dev / canary — lowercase letters, digits, hyphens; empty re-inherits 'stable'",
      'config.approvalPolicy': 'Approval policy',
      'config.approvalPolicyHint': "One of sensitive / all / none — ask for sensitive calls / ask for every call / allow all; empty re-inherits 'sensitive'",
      'config.readOnlyTools': 'Read-only tool list',
      'config.readOnlyToolsHint': 'Tool names separated by spaces, commas, or new lines; empty restores the default list. Under the sensitive policy these tools skip approval',
      'config.toolCallTimeoutMs': 'Tool call timeout (ms)',
      'config.toolCallTimeoutMsHint': 'Milliseconds, at least 1; empty uses the upstream default. Structural: takes effect after plugin reload',
      'config.overridden': 'Overridden by a higher layer',
      'config.reset': 'Reset',
      'config.invalid': 'Invalid value',
      'config.unavailable': 'Configuration unavailable',
      'config.readOnly': 'Read-only',
      'config.saveFailed': 'Save failed',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'status.title': 'Connection status',
      'status.mode': 'Mode',
      'status.endpoint': 'Endpoint',
      'status.channel': 'Channel',
      'status.approvalPolicy': 'Approval policy',
      'status.readOnlyToolCount': 'Read-only tools',
      'status.serverEntry': 'MCP server entry',
      'status.exclusive': 'Exclusive mount',
      'status.exclusiveYes': 'yes',
      'status.exclusiveNo': 'no',
      'status.refresh': 'Refresh',
      'status.unavailable': 'Status unavailable (host plugin not loaded or too old)',
    }

    /** Labels the shared SettingsForm chrome asks for. */
    function formLabels(t) {
      return {
        unavailable: t('config.unavailable'),
        readOnly: t('config.readOnly'),
        saveFailed: t('config.saveFailed'),
        save: t('config.save'),
        saving: t('config.saving'),
      }
    }

    /**
     * One plain value field over the staged model. `t` arrives via props —
     * the Plugins page supplies the bound translator, never module scope.
     * @param {string} key - the Config field name.
     * @param {string} id - the DOM id for the control.
     * @param {object} [extra] - extra SettingsValueField props (numeric keypad hint).
     */
    function textField(key, id, extra = {}) {
      return function StagedField({ t, state, edit, resetField }) {
        return h(SettingsValueField, {
          id,
          label: t(`config.${key}`),
          hint: t(`config.${key}Hint`),
          overriddenLabel: t('config.overridden'),
          resetLabel: t('config.reset'),
          invalidLabel: t('config.invalid'),
          disabled: !state.writable,
          ...state[key],
          ...extra,
          onEdit: (text) => { edit(key, text) },
          onReset: () => { resetField(key) },
        })
      }
    }

    const ModeField = textField('mode', 'chrome-cdp-config-mode')
    const EndpointField = textField('endpoint', 'chrome-cdp-config-endpoint')
    const ChannelField = textField('channel', 'chrome-cdp-config-channel')
    const ApprovalPolicyField = textField('approvalPolicy', 'chrome-cdp-config-approval-policy')
    const ReadOnlyToolsField = textField('readOnlyTools', 'chrome-cdp-config-read-only-tools')
    const ToolCallTimeoutMsField = textField('toolCallTimeoutMs', 'chrome-cdp-config-tool-call-timeout-ms', { numeric: true })

    /**
     * Field specs mirroring the host Config schema (index.js): an illegal
     * draft parses to undefined, which marks the field invalid and blocks
     * the save; an empty draft on a defaulted field clears it so the field
     * re-inherits the schema default. mode is required with no default, so
     * an empty mode draft is invalid rather than a doomed clear.
     */
    const MODES = ['auto', 'url', 'ws'] // index.js Schema.union([...]).required()
    const APPROVAL_POLICIES = ['sensitive', 'all', 'none'] // lib/gate.js (host truth)
    const CHANNEL_PATTERN = /^[a-z][a-z0-9-]*$/ // index.js Schema.string().pattern(...)
    const enumField = (field, legal, emptyIsClear) => ({
      field,
      format: (value) => typeof value === 'string' ? value : '',
      parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return emptyIsClear ? { kind: 'clear' } : undefined
        return legal.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
      },
    })
    const modeField = enumField('mode', MODES, false)
    const approvalPolicyField = enumField('approvalPolicy', APPROVAL_POLICIES, true)
    const channelField = {
      field: 'channel',
      format: (value) => typeof value === 'string' ? value : '',
      parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' } // re-inherits default 'stable'
        return CHANNEL_PATTERN.test(trimmed) ? { kind: 'set', value: trimmed } : undefined
      },
    }
    const readOnlyToolsField = {
      field: 'readOnlyTools',
      format: (value) => Array.isArray(value) ? value.join('\n') : '',
      parse: (text) => {
        // Tool names are [a-z0-9_]+, so splitting on any run of spaces,
        // commas, or new lines cannot corrupt a legal name.
        const names = text.split(/[\s,]+/).filter((name) => name !== '')
        return names.length === 0 ? { kind: 'clear' } : { kind: 'set', value: names } // clear re-inherits DEFAULT_READ_ONLY_TOOLS
      },
    }
    const timeoutBase = settingsNumberField('toolCallTimeoutMs')
    const toolCallTimeoutMsField = {
      field: 'toolCallTimeoutMs',
      format: timeoutBase.format,
      parse: (text) => {
        const write = timeoutBase.parse(text)
        // Mirror the schema's .min(1): a non-positive number blocks the save here.
        return write?.kind === 'set' && write.value < 1 ? undefined : write
      },
    }

    /** The plugin ctx of the most recent apply. The mounted `chromeCdp`
     * namespace is a cordis service named `remote.chromeCdp`: property
     * access on a non-injected service THROWS in cordis ("cannot get
     * property ... without inject"), so every read goes through the
     * sanctioned optional lookup `ctx.get(name)` — undefined until mounted. */
    let pluginCtx = null

    /** Optional status namespace lookup; undefined until $mount lands. */
    const statusNs = () => {
      try { return pluginCtx?.get?.('remote.chromeCdp') } catch { return undefined }
    }

    /** Unwrap a RemoteResult ({ok, value}) or pass a raw object through. */
    function unwrap(result) {
      if (result !== null && typeof result === 'object' && 'ok' in result) return result.ok ? result.value : undefined
      return result
    }

    const statusRow = (label, value, extra) =>
      h('div', { style: { display: 'flex', gap: 8, margin: '2px 0', fontSize: 13 } },
        h('span', { style: { opacity: 0.7, minWidth: 96 } }, label),
        h('span', { style: { wordBreak: 'break-all', ...extra } }, value))

    /**
     * Live connection status from the host half's `chromeCdp` Remote
     * (lib/status.js): the structural truth of what is mounted (mode/
     * endpoint/channel/serverEntry/exclusive, bound at wiring time), the
     * live approval policy, and the read-only tool count. Everything
     * degrades to a single "unavailable" line when the namespace is missing
     * or the host reports { available: false }.
     */
    function StatusSection({ t }) {
      const [state, setState] = React.useState(undefined)
      const refresh = React.useCallback(() => {
        const ns = statusNs()
        if (ns?.status === undefined) { setState(null); return }
        Promise.resolve().then(() => ns.status())
          .then(r => setState(unwrap(r) ?? {}), () => setState(null))
      }, [])
      React.useEffect(() => { refresh() }, [refresh])
      const buttonStyle = { fontSize: 13, padding: '2px 10px', cursor: 'pointer' }
      return h('div', { style: { marginBottom: 16, padding: '10px 12px', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('strong', { style: { fontSize: 13 } }, t('status.title')),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: buttonStyle, onClick: refresh }, t('status.refresh'))),
        state === undefined
          ? h('div', { style: { fontSize: 13, opacity: 0.7 } }, '…')
          : state === null || state.available === false
            ? h('div', { style: { fontSize: 13, opacity: 0.7 } }, t('status.unavailable'))
            : h('div', null,
              statusRow(t('status.mode'), String(state.mode ?? '—')),
              state.endpoint === undefined ? null : statusRow(t('status.endpoint'), String(state.endpoint)),
              statusRow(t('status.channel'), String(state.channel ?? '—')),
              statusRow(t('status.approvalPolicy'), String(state.approvalPolicy ?? '—')),
              typeof state.readOnlyToolCount === 'number' ? statusRow(t('status.readOnlyToolCount'), String(state.readOnlyToolCount)) : null,
              state.serverEntry ? statusRow(t('status.serverEntry'), String(state.serverEntry)) : null,
              statusRow(t('status.exclusive'), state.exclusive ? t('status.exclusiveYes') : t('status.exclusiveNo'))))
    }

    /**
     * The config card: a live status section, then the shared form chrome
     * over the six staged fields. The Plugins page supplies `view`
     * ('page' | 'summary'), `t`, the face's `useConfig` hook, and the
     * staged-form actions.
     */
    function ChromeCdpConfigCard(props) {
      const { view, t, useConfig, edit, resetField, save, discard } = props
      const state = useConfig(snapshot => snapshot)
      if (view === 'summary') return t('config.summary')
      const fieldProps = { t, state, edit, resetField }
      return h(React.Fragment, null,
        h(StatusSection, { t }),
        h(SettingsForm, { labels: formLabels(t), state, onSave: save, onDiscard: discard },
          h(ModeField, { t, ...fieldProps }),
          h(EndpointField, { t, ...fieldProps }),
          h(ChannelField, { t, ...fieldProps }),
          h(ApprovalPolicyField, { t, ...fieldProps }),
          h(ReadOnlyToolsField, { t, ...fieldProps }),
          h(ToolCallTimeoutMsField, { t, ...fieldProps })))
    }

    /**
     * Build the staged model over the row's shared ConfigForm. The config
     * snapshot is MEMOIZED: getSnapshot must return the same object between
     * notifications or React's useSyncExternalStore loops (Minified React
     * error #185). Every notification invalidates the cache; the next read
     * recomputes. (Same pattern as the feishu-gateway card, minus its
     * credential-presence store — this plugin has no secret state.)
     * @param {any} ctx - client context carrying configForms.
     * @returns {{face: () => object, dispose: () => void}} the slot registration inputs.
     */
    function buildConfigCard(ctx) {
      const configForm = ctx.configForms.get(ROW)

      const model = new SettingsFormModel(configForm, [
        modeField,
        settingsTextField('endpoint'),
        channelField,
        approvalPolicyField,
        readOnlyToolsField,
        toolCallTimeoutMsField,
      ])
      const formStore = model.bind(() => ({}))
      const computeSnapshot = () => ({
        ...model.shell(),
        mode: model.field('mode'),
        endpoint: model.field('endpoint'),
        channel: model.field('channel'),
        approvalPolicy: model.field('approvalPolicy'),
        readOnlyTools: model.field('readOnlyTools'),
        toolCallTimeoutMs: model.field('toolCallTimeoutMs'),
      })

      let snapshotCache = null
      const face = () => ({
        hooks: {
          config: {
            getSnapshot: () => {
              if (snapshotCache === null) snapshotCache = computeSnapshot()
              return snapshotCache
            },
            subscribe: (listener) => {
              const wake = () => {
                snapshotCache = null
                listener()
              }
              const offForm = formStore.subscribe(wake)
              return () => offForm()
            },
          },
        },
        ...model.actions(),
      })
      return { face, dispose: () => { model.dispose(); snapshotCache = null } }
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'remote'],
      apply(ctx) {
        pluginCtx = ctx
        const card = buildConfigCard(ctx)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chrome-cdp: dictionaries')
        ctx.effect(() => () => { card.dispose() }, 'dsh-chrome-cdp: config model')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: ID, locale: NS, inject: card.face },
          ChromeCdpConfigCard,
        )), 'dsh-chrome-cdp: bundle config card')
        // Mount the plugin's own `chromeCdp` Remote namespace (host half in
        // lib/status.js: ChromeCdpStatus, zero wire parameters, src-json
        // result — the feishu-gateway diagnostics pattern).
        ctx.effect(() => {
          // Contained: a failed namespace mount must never surface as an
          // unhandled rejection in the page — the status section simply
          // reports "unavailable" when remote.chromeCdp is missing.
          const owned = ctx.remote.$mount({
            package: ID,
            descriptors: [
              {
                id: `${ID}#chromeCdp/status`, service: 'chromeCdp', namespace: 'chromeCdp',
                method: 'status', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
              },
            ],
          }).then(dispose => dispose, () => {})
          return () => { void owned.then(dispose => { dispose().catch(() => {}) }, () => {}) }
        }, 'dsh-chrome-cdp: status remote namespace')
      },
    }
  },
})
