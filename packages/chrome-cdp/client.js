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
 * select and no multiline/textarea primitive. The three enum fields (server,
 * mode, approvalPolicy) therefore render through a LOCAL select control
 * (SettingsSelectField below) that mirrors SettingsValueField's DOM and
 * tokens; readOnlyTools edits one tool name per line in a single-line input
 * (space/comma/newline separated). Field specs follow the SettingsFieldSpec
 * contract (form-model.ts:64-74) and mirror the host Config schema (index.js)
 * so an illegal draft marks the field invalid and blocks the save instead of
 * staging a write the host would reject blindly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chrome-cdp',
  factory(require) {
    const React = require('react')
    const {
      SettingsForm, SettingsValueField, SettingsFormModel, settingsTextField, settingsNumberField, Tag,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Registration identity: the package name, the slot key the card files under. */
    const ID = 'dsh-chrome-cdp'
    /** The Loader row id whose ConfigForm backs the card (cordis.patch.yml). */
    const ROW = 'chrome-cdp'
    /** This plugin's copy namespace. */
    const NS = 'chromeCdp'

    const zh = {
      'config.summary': '操作真实 Chrome：可选 MCP 引擎（playwright / chrome-devtools），连接模式、调试端点、审批策略与只读工具清单。',
      'config.server': 'MCP 引擎',
      'config.serverHint': 'playwright（默认，launch/url/ws/extension）或 chrome-devtools（auto/url/ws；auto 为 Chrome ≥144 授权模式）',
      'config.mode': '连接模式',
      'config.modeHint': 'playwright：launch / url / ws / extension（extension 需装 Playwright Extension 扩展）；chrome-devtools：auto / url / ws',
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
      'config.defaultOption': '默认（{value}）',
      'config.server.playwright': 'playwright',
      'config.server.chrome-devtools': 'chrome-devtools（Chrome DevTools MCP）',
      'config.mode.launch': 'launch — Playwright 自管浏览器',
      'config.mode.url': 'url — 连接 http(s) 调试地址',
      'config.mode.ws': 'ws — 连接 ws(s) 调试地址',
      'config.mode.extension': 'extension — 经 Playwright Extension 接管运行中的 Chrome',
      'config.mode.auto': 'auto — Chrome ≥144 授权模式',
      'config.approvalPolicy.sensitive': 'sensitive — 敏感操作需确认',
      'config.approvalPolicy.all': 'all — 全部操作需确认',
      'config.approvalPolicy.none': 'none — 全部放行',
      'config.modeConflict': '「{mode}」不是 {server} 的合法连接模式（可选：{legal}）；请改选连接模式或引擎，否则插件重载会失败',
      'config.overridden': '已覆盖',
      'config.reset': '重置',
      'config.invalid': '无效值',
      'config.unavailable': '配置不可用',
      'config.readOnly': '只读',
      'config.saveFailed': '保存失败',
      'config.save': '保存',
      'config.saving': '保存中…',
      'status.title': '已挂载状态（插件重载前有效）',
      'status.pendingReload': '有改动，待插件重载生效',
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
      'config.summary': 'Drive a real Chrome over CDP: selectable MCP engine (playwright / chrome-devtools), connection mode, debug endpoint, approval policy, and the read-only tool list.',
      'config.server': 'MCP engine',
      'config.serverHint': 'playwright (default; launch/url/ws/extension) or chrome-devtools (auto/url/ws; auto is the Chrome ≥144 approval mode)',
      'config.mode': 'Connection mode',
      'config.modeHint': 'playwright: launch / url / ws / extension (extension needs the Playwright Extension); chrome-devtools: auto / url / ws',
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
      'config.defaultOption': 'Default ({value})',
      'config.server.playwright': 'playwright',
      'config.server.chrome-devtools': 'chrome-devtools (Chrome DevTools MCP)',
      'config.mode.launch': 'launch — Playwright-managed browser',
      'config.mode.url': 'url — connect to an http(s) debug address',
      'config.mode.ws': 'ws — connect to a ws(s) debug address',
      'config.mode.extension': 'extension — attach to the running Chrome via the Playwright Extension',
      'config.mode.auto': 'auto — Chrome ≥144 approval mode',
      'config.approvalPolicy.sensitive': 'sensitive — ask for sensitive calls',
      'config.approvalPolicy.all': 'all — ask for every call',
      'config.approvalPolicy.none': 'none — allow all',
      'config.modeConflict': '"{mode}" is not a {server} mode (choose one of: {legal}); pick another mode or engine, or the plugin fails at reload',
      'config.overridden': 'Overridden',
      'config.reset': 'Reset',
      'config.invalid': 'Invalid value',
      'config.unavailable': 'Configuration unavailable',
      'config.readOnly': 'Read-only',
      'config.saveFailed': 'Save failed',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'status.title': 'Mounted state (effective until plugin reload)',
      'status.pendingReload': 'Changes pending plugin reload',
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

    const EndpointField = textField('endpoint', 'chrome-cdp-config-endpoint')
    const ChannelField = textField('channel', 'chrome-cdp-config-channel')
    const ReadOnlyToolsField = textField('readOnlyTools', 'chrome-cdp-config-read-only-tools')
    const ToolCallTimeoutMsField = textField('toolCallTimeoutMs', 'chrome-cdp-config-tool-call-timeout-ms', { numeric: true })

    /**
     * Field specs mirroring the host Config schema (index.js): an illegal
     * draft parses to undefined, which marks the field invalid and blocks
     * the save; an empty draft on a defaulted field clears it so the field
     * re-inherits the schema default. mode defaults to 'extension'
     * (lib/servers.js DEFAULT_MODE), so an empty mode draft is a clear that
     * re-inherits it - not a doomed clear into an unconfigured mount.
     */
    const SERVERS = ['playwright', 'chrome-devtools'] // index.js Schema.union(...).default('playwright')
    const MODES = ['auto', 'url', 'ws', 'launch', 'extension'] // union of both servers' modes; legality enforced host-side
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
    const serverField = enumField('server', SERVERS, true)
    const modeField = enumField('mode', MODES, true)
    const approvalPolicyField = enumField('approvalPolicy', APPROVAL_POLICIES, true)

    /** Schema defaults (index.js .default(...) / lib/servers.js DEFAULT_*). */
    const DEFAULT_SERVER = 'playwright'
    const DEFAULT_MODE = 'extension'
    const DEFAULT_APPROVAL_POLICY = 'sensitive'
    /** Modes per engine, mirroring lib/servers.js MODES_BY_SERVER (host truth). */
    const MODES_BY_SERVER = Object.freeze({
      playwright: Object.freeze(['launch', 'url', 'ws', 'extension']),
      'chrome-devtools': Object.freeze(['auto', 'url', 'ws']),
    })

    /**
     * Server/mode legality across two staged fields. Each spec parses its own
     * text only, so a mode that is legal for playwright with a staged
     * chrome-devtools server passes both specs, saves, and then fails the host
     * at reload (lib/servers.js buildServerArgs). The card folds the conflict
     * into the shell (Save blocked) and the mode field spells it out.
     * @returns {{server: string, legal: readonly string[], mode: string, conflict: boolean}}
     */
    const modeLegality = (state) => {
      const server = state.server.text || DEFAULT_SERVER
      const legal = MODES_BY_SERVER[server]
      const mode = state.mode.text || DEFAULT_MODE
      return { server, legal: legal ?? MODES, mode, conflict: legal !== undefined && !legal.includes(mode) }
    }

    /**
     * Stylesheet for the local select field (see the module header): the rules
     * of settings-form/fields.module.css under plugin-scoped classes, so the
     * control inherits the host theme through the same --dsw-* tokens. The
     * stock fields draw their separator with `.field + .field`, which never
     * matches next to a foreign element, so this field draws top AND bottom
     * hairlines minus the edges: every neighbour pair keeps exactly one line.
     * Rendered as a <style> element inside the card, so it leaves with it.
     */
    const SELECT_CSS = `
.cdc-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.cdc-field:first-child, .cdc-field + .cdc-field { border-top: 0; }
.cdc-field:last-child { border-bottom: 0; }
.cdc-head { display: flex; align-items: center; gap: 8px; }
.cdc-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.cdc-badges { display: inline-flex; align-items: center; gap: 8px; }
.cdc-reset { border: none; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.cdc-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.cdc-reset:disabled { cursor: default; }
.cdc-select { height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.cdc-select:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.cdc-select:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.cdc-select[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
.cdc-message { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.cdc-message-invalid { color: var(--dsw-alias-state-error-primary); }
`

    /**
     * Local enum control over the staged model: label, the overridden Tag and
     * reset (the real Tag, so the badge matches the stock fields), a native
     * <select>, and the hint / invalid / conflict message. The first option
     * (value '') is the schema default: choosing it stages a clear so the
     * field re-inherits, exactly like blanking a text field.
     * @param {object} props - the SettingsFieldProps text/overridden/invalid/disabled plus
     *   `choices` ({value, label}[]), `defaultLabel`, optional `warning`, onEdit, onReset.
     */
    function SettingsSelectField(props) {
      const messageId = `${props.id}-message`
      const problem = props.invalid ? props.invalidLabel : props.warning
      const hasMessage = problem !== undefined || Boolean(props.hint)
      return h('div', { className: 'cdc-field' },
        h('div', { className: 'cdc-head' },
          h('label', { className: 'cdc-label', htmlFor: props.id }, props.label),
          props.overridden
            ? h('span', { className: 'cdc-badges' },
              h(Tag, { tone: 'neutral' }, props.overriddenLabel),
              h('button', { type: 'button', className: 'cdc-reset', disabled: props.disabled, onClick: props.onReset }, props.resetLabel))
            : null),
        h('select', {
          id: props.id,
          className: 'cdc-select',
          value: props.text,
          disabled: props.disabled,
          ...(problem !== undefined ? { 'aria-invalid': 'true' } : {}),
          ...(hasMessage ? { 'aria-describedby': messageId } : {}),
          onChange: (event) => { props.onEdit(event.target.value) },
        },
          h('option', { value: '' }, props.defaultLabel),
          props.choices.map((choice) => h('option', { key: choice.value, value: choice.value }, choice.label))),
        hasMessage
          ? h('p', { id: messageId, className: problem !== undefined ? 'cdc-message cdc-message-invalid' : 'cdc-message', role: 'status' },
              problem !== undefined ? problem : props.hint)
          : null)
    }

    /** Option list with localized, descriptive labels for one enum field. */
    const options = (field, values, t) => values.map((value) => ({ value, label: t(`config.${field}.${value}`) }))

    /**
     * selectField(key, id, defaultValue, choicesFor): the staged-model wrapper
     * for SettingsSelectField, parallel to textField. `choicesFor(state, t)`
     * answers the options plus an optional cross-field `warning`.
     */
    function selectField(key, id, defaultValue, choicesFor) {
      return function StagedSelect({ t, state, edit, resetField }) {
        return h(SettingsSelectField, {
          id,
          label: t(`config.${key}`),
          hint: t(`config.${key}Hint`),
          defaultLabel: t('config.defaultOption', { value: t(`config.${key}.${defaultValue}`) }),
          overriddenLabel: t('config.overridden'),
          resetLabel: t('config.reset'),
          invalidLabel: t('config.invalid'),
          disabled: !state.writable,
          ...state[key],
          ...choicesFor(state, t),
          onEdit: (text) => { edit(key, text) },
          onReset: () => { resetField(key) },
        })
      }
    }
    const ServerField = selectField('server', 'chrome-cdp-config-server', DEFAULT_SERVER,
      (state, t) => ({ choices: options('server', SERVERS, t) }))
    // Only the staged engine's modes are offered; a staged mode that engine
    // forbids still heads the list so the control shows exactly what would be
    // saved, and the warning beneath (plus the blocked Save) names the fix.
    const ModeField = selectField('mode', 'chrome-cdp-config-mode', DEFAULT_MODE, (state, t) => {
      const { server, legal, mode, conflict } = modeLegality(state)
      const values = conflict && state.mode.text !== '' ? [state.mode.text, ...legal] : legal
      return {
        choices: options('mode', values, t),
        warning: conflict ? t('config.modeConflict', { mode, server, legal: legal.join(' / ') }) : undefined,
      }
    })
    const ApprovalPolicyField = selectField('approvalPolicy', 'chrome-cdp-config-approval-policy', DEFAULT_APPROVAL_POLICY,
      (state, t) => ({ choices: options('approvalPolicy', APPROVAL_POLICIES, t) }))
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
    function StatusSection({ t, status: state, refresh, form }) {
      const buttonStyle = { fontSize: 13, padding: '2px 10px', cursor: 'pointer' }
      // Structural fields whose staged form text differs from the mounted
      // snapshot: the mount keeps running the OLD values until plugin reload.
      const pending = state !== null && state !== undefined && state.available !== false && form !== undefined
        && ['server', 'mode', 'endpoint', 'channel'].some(f => {
          const text = form[f]?.text
          return text !== undefined && text !== '' && String(state[f] ?? '') !== String(text)
        })
      return h('div', { style: { marginBottom: 16, padding: '10px 12px', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('strong', { style: { fontSize: 13 } }, t('status.title')),
          pending ? h('span', { style: { fontSize: 12, color: '#b8860b' } }, t('status.pendingReload')) : null,
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
      const [status, setStatus] = React.useState(undefined)
      const refreshStatus = React.useCallback(() => {
        const ns = statusNs()
        if (ns?.status === undefined) { setStatus(null); return }
        Promise.resolve().then(() => ns.status())
          .then(r => setStatus(unwrap(r) ?? {}), () => setStatus(null))
      }, [])
      React.useEffect(() => { refreshStatus() }, [refreshStatus])
      if (view === 'summary') return t('config.summary')
      const saveAndRefresh = async (...args) => { try { return await save(...args) } finally { refreshStatus() } }
      const fieldProps = { t, state, edit, resetField }
      // Cross-field legality the per-field specs cannot see (modeLegality):
      // while the staged server/mode pair conflicts, the shell is invalid so
      // SettingsForm blocks Save instead of writing a pair the host would
      // reject at reload; the mode field carries the explanation.
      const formState = modeLegality(state).conflict ? { ...state, invalid: true } : state
      return h(React.Fragment, null,
        h(StatusSection, { t, status, refresh: refreshStatus, form: { server: state.server, mode: state.mode, endpoint: state.endpoint, channel: state.channel } }),
        h('style', null, SELECT_CSS),
        h(SettingsForm, { labels: formLabels(t), state: formState, onSave: saveAndRefresh, onDiscard: discard },
          h(ServerField, { t, ...fieldProps }),
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
        serverField,
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
        server: model.field('server'),
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
