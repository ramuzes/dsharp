/**
 * dsh-feishu-gateway — browser half.
 *
 * One self-contained script in the client module system's factory format: it
 * calls window.__ModuleLoader__.load() with the package name and a factory
 * that lazily requires its modules (React and the staged-form primitives are
 * module-table identities, so nothing is bundled) and returns a cordis plugin
 * object.
 *
 * The plugin contributes exactly one thing: the bundle's own configuration
 * card on the Plugins page (the `plugins.bundle.config` slot, keyed by the
 * package name). The card edits appId / domain / App Secret through a
 * SettingsFormModel over the shared ConfigForm of the `feishu-gateway` row.
 * The secret is the model's write-only control (web-search-card pattern):
 * staged with the form, written on save through the credentials Remote,
 * never echoed back — the card shows only 已配置/未配置.
 */
window.__ModuleLoader__.load({
  id: 'dsh-feishu-gateway',
  factory(require) {
    const React = require('react')
    const {
      SettingsForm, SettingsValueField, SettingsSecretField, SettingsFormModel, settingsTextField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Registration identity: the package name, the slot key the card files under. */
    const ID = 'dsh-feishu-gateway'
    /** The Loader row id whose ConfigForm backs the card. */
    const ROW = 'feishu-gateway'
    /** This plugin's copy namespace. */
    const NS = 'feishuGateway'

    const zh = {
      'config.summary': '飞书机器人网关的应用凭证与接入地址。',
      'config.appId': 'App ID',
      'config.appIdHint': '飞书开发者后台「凭证与基础信息」里的应用 ID（cli_ 开头）',
      'config.appSecret': 'App Secret',
      'config.appSecretHint': '飞书开发者后台「凭证与基础信息」里的应用密钥；填入后存入 dsh 凭证存储，不会再次显示',
      'config.secretSet': '已配置',
      'config.secretUnset': '未配置（也可在启动环境 export FEISHU_APP_SECRET）',
      'config.domain': '开放平台地址',
      'config.domainHint': '国内 https://open.feishu.cn，海外 https://open.larksuite.com',
      'config.overridden': '已被上层覆盖',
      'config.reset': '重置',
      'config.invalid': '无效值',
      'config.unavailable': '配置不可用',
      'config.readOnly': '只读',
      'config.saveFailed': '保存失败',
      'config.save': '保存',
      'config.saving': '保存中…',
      'diag.title': '网关诊断',
      'diag.stage': '运行阶段',
      'diag.connectedAt': '连接建立于',
      'diag.inbound': '已收事件',
      'diag.lastWsError': '最近 WS 错误',
      'diag.probe': '测试连通性',
      'diag.probing': '测试中…',
      'diag.probeOk': '凭证有效、可访问开放平台',
      'diag.probeFail': '测试失败',
      'diag.unavailable': '诊断不可用（宿主插件未加载或版本过旧）',
      'diag.stageHint.connected': '长连接已建立',
      'diag.stageHint.transport-started': '已发起连接，等待 SDK 就绪',
      'diag.stageHint.never-connected': 'SDK 30 秒内未建立连接（常见：代理变量是 https:// 前缀、WSS 出网被挡）',
      'diag.stageHint.transport-error': '连接出错，详见最近 WS 错误',
      'diag.stageHint.inactive': '未激活：appId 或 App Secret 未配置',
      'diag.stageHint.boot-failed': '启动失败，详见宿主日志',
      'diag.stageHint.stopped': '已停止',
      'diag.refresh': '刷新',
    }

    const en = {
      'config.summary': 'Feishu bot gateway app credentials and endpoint.',
      'config.appId': 'App ID',
      'config.appIdHint': "The app id (cli_…) from the Feishu developer console's Credentials page",
      'config.appSecret': 'App Secret',
      'config.appSecretHint': "The app secret from the console's Credentials page; stored in the dsh credential store, never shown again",
      'config.secretSet': 'Configured',
      'config.secretUnset': 'Not set (or export FEISHU_APP_SECRET in the launch environment)',
      'config.domain': 'Open platform endpoint',
      'config.domainHint': 'https://open.feishu.cn (CN) or https://open.larksuite.com (international)',
      'config.overridden': 'Overridden by a higher layer',
      'config.reset': 'Reset',
      'config.invalid': 'Invalid value',
      'config.unavailable': 'Configuration unavailable',
      'config.readOnly': 'Read-only',
      'config.saveFailed': 'Save failed',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'diag.title': 'Gateway diagnostics',
      'diag.stage': 'Stage',
      'diag.connectedAt': 'Connected at',
      'diag.inbound': 'Inbound events',
      'diag.lastWsError': 'Last WS error',
      'diag.probe': 'Test connectivity',
      'diag.probing': 'Testing…',
      'diag.probeOk': 'Credentials valid, open platform reachable',
      'diag.probeFail': 'Test failed',
      'diag.unavailable': 'Diagnostics unavailable (host plugin not loaded or too old)',
      'diag.stageHint.connected': 'Long connection established',
      'diag.stageHint.transport-started': 'Connect issued, waiting for the SDK',
      'diag.stageHint.never-connected': 'SDK did not connect within 30s (common: https:// proxy scheme, blocked WSS egress)',
      'diag.stageHint.transport-error': 'Connection error — see last WS error',
      'diag.stageHint.inactive': 'Inactive: appId or App Secret not configured',
      'diag.stageHint.boot-failed': 'Boot failed — see host logs',
      'diag.stageHint.stopped': 'Stopped',
      'diag.refresh': 'Refresh',
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
     */
    function textField(key, id) {
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
          onEdit: (text) => { edit(key, text) },
          onReset: () => { resetField(key) },
        })
      }
    }

    const AppIdField = textField('appId', 'feishu-gateway-config-app-id')
    const DomainField = textField('domain', 'feishu-gateway-config-domain')

    /** The plugin ctx of the most recent apply. The mounted `feishuGateway`
     * namespace is a cordis service named `remote.feishuGateway`: property
     * access on a non-injected service THROWS in cordis ("cannot get
     * property ... without inject"), so every read goes through the
     * sanctioned optional lookup `ctx.get(name)` — undefined until mounted. */
    let pluginCtx = null

    /** Optional diagnostics namespace lookup; undefined until $mount lands. */
    const diagnosticsNs = () => {
      try { return pluginCtx?.get?.('remote.feishuGateway') } catch { return undefined }
    }

    /** Unwrap a RemoteResult ({ok, value}) or pass a raw object through. */
    function unwrap(result) {
      if (result !== null && typeof result === 'object' && 'ok' in result) return result.ok ? result.value : undefined
      return result
    }

    const diagRow = (label, value, extra) =>
      h('div', { style: { display: 'flex', gap: 8, margin: '2px 0', fontSize: 13 } },
        h('span', { style: { opacity: 0.7, minWidth: 96 } }, label),
        h('span', { style: { wordBreak: 'break-all', ...extra } }, value))

    /**
     * Live gateway diagnostics: stage, connection time, inbound count, last
     * WS error, and an on-demand credential/egress probe (the host half's
     * `feishuGateway` Remote). Everything degrades to a single "unavailable"
     * line when the host plugin is older than this Remote.
     */
    function DiagnosticsSection({ t }) {
      const [state, setState] = React.useState(undefined)
      const [probe, setProbe] = React.useState(undefined)
      const refresh = React.useCallback(() => {
        const ns = diagnosticsNs()
        if (ns?.status === undefined) { setState(null); return }
        Promise.resolve().then(() => ns.status())
          .then(r => setState(unwrap(r) ?? {}), () => setState(null))
      }, [])
      React.useEffect(() => { refresh() }, [refresh])
      const runProbe = () => {
        const ns = diagnosticsNs()
        if (ns?.probe === undefined) { setProbe({ ok: false, reason: 'unavailable' }); return }
        setProbe('pending')
        Promise.resolve().then(() => ns.probe())
          .then(r => setProbe(unwrap(r) ?? { ok: false }), e => setProbe({ ok: false, reason: String(e) }))
      }
      const stage = state === null || state === undefined ? undefined : String(state.stage ?? '')
      const hintKey = stage === undefined ? undefined : `diag.stageHint.${stage}`
      const buttonStyle = { fontSize: 13, padding: '2px 10px', cursor: 'pointer' }
      return h('div', { style: { marginBottom: 16, padding: '10px 12px', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('strong', { style: { fontSize: 13 } }, t('diag.title')),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: buttonStyle, onClick: refresh }, t('diag.refresh')),
          h('button', {
            type: 'button',
            style: buttonStyle,
            disabled: probe === 'pending',
            onClick: runProbe,
          }, probe === 'pending' ? t('diag.probing') : t('diag.probe'))),
        state === null
          ? h('div', { style: { fontSize: 13, opacity: 0.7 } }, t('diag.unavailable'))
          : state === undefined
            ? h('div', { style: { fontSize: 13, opacity: 0.7 } }, '…')
            : h('div', null,
              diagRow(t('diag.stage'), stage || '—', (stage === 'connected'
                ? { color: 'var(--dsh-color-success, #2e7d32)' }
                : stage === 'never-connected' || stage === 'transport-error' || stage === 'boot-failed'
                  ? { color: 'var(--dsh-color-danger, #c62828)' }
                  : {})),
              hintKey !== undefined && t(hintKey) !== hintKey
                ? h('div', { style: { fontSize: 12, opacity: 0.7, margin: '2px 0 2px 104px' } }, t(hintKey))
                : null,
              state.appId ? diagRow('App ID', String(state.appId)) : null,
              state.connectedAt ? diagRow(t('diag.connectedAt'), String(state.connectedAt)) : null,
              typeof state.inboundCount === 'number' ? diagRow(t('diag.inbound'), `${state.inboundCount}${state.lastEventAt ? ` (last ${state.lastEventAt})` : ''}`) : null,
              state.lastWsError ? diagRow(t('diag.lastWsError'), String(state.lastWsError), { color: 'var(--dsh-color-danger, #c62828)' }) : null),
        probe !== undefined && probe !== 'pending'
          ? h('div', { style: { fontSize: 13, marginTop: 6, color: probe.ok ? 'var(--dsh-color-success, #2e7d32)' : 'var(--dsh-color-danger, #c62828)' } },
            `${probe.ok ? t('diag.probeOk') : t('diag.probeFail')}${probe.code !== undefined ? ` (code ${probe.code})` : ''}${probe.reason ?? probe.msg ? `: ${probe.reason ?? probe.msg}` : ''}${probe.latencyMs !== undefined ? ` · ${probe.latencyMs}ms` : ''}`)
          : null)
    }

    /**
     * The config card: shared form chrome, the two staged value fields, and
     * the credentials-backed secret control. The secret is staged with the
     * rest of the form (`edit('appSecret', …)`) and written only on save,
     * through the SettingsFormModel secret spec — the web-search-card
     * pattern. The Plugins page supplies `view` ('page' | 'summary'), `t`,
     * the face's `useConfig` hook, and the staged-form actions.
     */
    function FeishuGatewayConfigCard(props) {
      const { view, t, useConfig, edit, resetField, save, discard } = props
      const state = useConfig(snapshot => snapshot)
      if (view === 'summary') return t('config.summary')
      const fieldProps = { state, edit, resetField }
      return h(React.Fragment, null,
        h(DiagnosticsSection, { t }),
        h(SettingsForm, { labels: formLabels(t), state, onSave: save, onDiscard: discard },
          h(AppIdField, { t, ...fieldProps }),
          h(SettingsSecretField, {
            id: 'feishu-gateway-config-app-secret',
            label: t('config.appSecret'),
            hint: t('config.appSecretHint'),
            disabled: !state.writable,
            text: state.appSecret.text,
            configured: state.secretConfigured,
            stateLabel: state.secretConfigured ? t('config.secretSet') : t('config.secretUnset'),
            onEdit: (text) => { edit('appSecret', text) },
          }),
          h(DomainField, { t, ...fieldProps })))
    }

    /**
     * Build the staged model over the row's shared ConfigForm. The secret
     * is one of the model's write-only controls (third constructor arg): its
     * draft stages with the form, a save writes it through the credentials
     * Remote under the reference named by `appSecretEnv`, and a blank draft
     * writes nothing. The literal never rides a form response or a patch
     * layer; presence comes from CredentialInfo.configured.
     * @param {any} ctx - client context carrying configForms + remote.credentials.
     * @returns {{face: () => object, dispose: () => void}} the slot registration inputs.
     */
    function buildConfigCard(ctx) {
      const configForm = ctx.configForms.get(ROW)

      /** The credential reference the Host resolves; `appSecretEnv` names it. */
      const refOf = () => {
        const value = configForm.getSnapshot().value?.appSecretEnv
        return typeof value === 'string' && value !== '' ? value : 'FEISHU_APP_SECRET'
      }

      // Secret presence, refreshed on subscribe and after each write, fanned
      // out to the card's listeners. The config snapshot is MEMOIZED:
      // getSnapshot must return the same object between notifications or
      // React's useSyncExternalStore loops (Minified React error #185).
      // Every notification invalidates the cache; the next read recomputes.
      let secretConfigured = false
      let snapshotCache = null
      const listeners = new Set()
      const notify = () => {
        snapshotCache = null
        for (const listener of listeners) listener()
      }
      const refresh = async () => {
        let next = false
        try {
          const response = await ctx.remote.credentials.describe([refOf()])
          next = response.ok ? (response.value?.[refOf()]?.configured ?? false) : false
        } catch {
          next = false
        }
        if (next === secretConfigured && snapshotCache !== null) return
        secretConfigured = next
        notify()
      }
      /** The secret spec's save-time write: store, then re-read presence. */
      const writeSecret = async (text) => {
        await ctx.remote.credentials.set(refOf(), text)
        await refresh()
        return secretConfigured
      }

      const model = new SettingsFormModel(
        configForm,
        [settingsTextField('appId'), settingsTextField('domain')],
        [{ field: 'appSecret', write: writeSecret }],
      )
      const formStore = model.bind(() => ({}))
      const computeSnapshot = () => ({
        ...model.shell(),
        appId: model.field('appId'),
        domain: model.field('domain'),
        appSecret: model.field('appSecret'),
        secretConfigured,
      })

      const face = () => ({
        hooks: {
          config: {
            getSnapshot: () => {
              if (snapshotCache === null) snapshotCache = computeSnapshot()
              return snapshotCache
            },
            subscribe: (listener) => {
              listeners.add(listener)
              const wake = () => {
                snapshotCache = null
                listener()
              }
              const offForm = formStore.subscribe(wake)
              void refresh()
              return () => { listeners.delete(listener); offForm() }
            },
          },
        },
        ...model.actions(),
      })
      return { face, dispose: () => { model.dispose(); listeners.clear(); snapshotCache = null } }
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'],
      apply(ctx) {
        pluginCtx = ctx
        const card = buildConfigCard(ctx)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-feishu-gateway: dictionaries')
        ctx.effect(() => () => { card.dispose() }, 'dsh-feishu-gateway: config model')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: ID, locale: NS, inject: card.face },
          FeishuGatewayConfigCard,
        )), 'dsh-feishu-gateway: bundle config card')
        // Mount the plugin's own `feishuGateway` Remote namespace (host half in
        // lib/diagnostics.js). Zero-parameter methods need no strict codecs;
        // src-json results match the Gateway's source-mode descriptors.
        ctx.effect(() => {
          // Contained: a failed namespace mount must never surface as an
          // unhandled rejection in the page — the diagnostics section simply
          // reports "unavailable" when remote.feishuGateway is missing.
          const owned = ctx.remote.$mount({
            package: ID,
            descriptors: [
              {
                id: `${ID}#feishuGateway/status`, service: 'feishuGateway', namespace: 'feishuGateway',
                method: 'status', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
              },
              {
                id: `${ID}#feishuGateway/probe`, service: 'feishuGateway', namespace: 'feishuGateway',
                method: 'probe', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
              },
            ],
          }).then(dispose => dispose, () => {})
          return () => { void owned.then(dispose => { dispose().catch(() => {}) }, () => {}) }
        }, 'dsh-feishu-gateway: diagnostics remote namespace')
      },
    }
  },
})
