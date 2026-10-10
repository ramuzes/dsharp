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
 * package name). The card edits appId / appSecret / domain through a
 * SettingsFormModel over the shared ConfigForm of the `feishu-gateway` row.
 * The secret is a write-through control: typed once, stored through
 * configForm.set, never echoed back — the card shows only 已配置/未配置.
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

    /**
     * The config card: shared form chrome, the two staged value fields, and
     * the credentials-backed secret control (writes through the face's
     * `storeSecret`; presence from the presence store). The Plugins page
     * supplies `view` ('page' | 'summary'), `t`, the face's `useConfig`
     * hook, the staged-form actions, and `storeSecret`.
     */
    function FeishuGatewayConfigCard(props) {
      const { view, t, useConfig, edit, resetField, save, discard, storeSecret } = props
      const state = useConfig(snapshot => snapshot)
      if (view === 'summary') return t('config.summary')
      const fieldProps = { state, edit, resetField }
      return h(SettingsForm, { labels: formLabels(t), state, onSave: save, onDiscard: discard },
        h(AppIdField, { t, ...fieldProps }),
        h(SettingsSecretField, {
          id: 'feishu-gateway-config-app-secret',
          label: t('config.appSecret'),
          hint: t('config.appSecretHint'),
          disabled: !state.writable,
          text: '',
          configured: state.secretConfigured,
          stateLabel: state.secretConfigured ? t('config.secretSet') : t('config.secretUnset'),
          onEdit: (text) => { storeSecret?.(text) },
        }),
        h(DomainField, { t, ...fieldProps }))
    }

    /**
     * Build the staged model over the row's shared ConfigForm. The secret
     * does NOT ride the form: the control writes through the credentials
     * Remote (`set`/`describe`, the Models-page API-key pattern) under the
     * reference named by `appSecretEnv`, so the literal never touches a
     * patch layer or a form response. Presence comes from
     * CredentialInfo.configured and refreshes after each write.
     * @param {any} ctx - client context carrying configForms + remote.credentials.
     * @returns {{face: () => object, dispose: () => void}} the slot registration inputs.
     */
    function buildConfigCard(ctx) {
      const configForm = ctx.configForms.get(ROW)
      const model = new SettingsFormModel(
        configForm,
        [settingsTextField('appId'), settingsTextField('domain')],
      )
      const formStore = model.bind(() => ({}))

      /** The credential reference the Host resolves; `appSecretEnv` names it. */
      const refOf = () => {
        const value = configForm.getSnapshot().value?.appSecretEnv
        return typeof value === 'string' && value !== '' ? value : 'FEISHU_APP_SECRET'
      }

      // Secret presence store: written through remote.credentials, refreshed
      // on subscribe and after each write, fanned out to the card's listeners.
      let secretConfigured = false
      const listeners = new Set()
      const notify = () => { for (const listener of listeners) listener() }
      const refresh = async () => {
        try {
          const response = await ctx.remote.credentials.describe([refOf()])
          secretConfigured = response.ok ? (response.value?.[refOf()]?.configured ?? false) : false
        } catch {
          secretConfigured = false
        }
        notify()
      }
      const storeSecret = async (text) => {
        await ctx.remote.credentials.set(refOf(), text)
        await refresh()
      }

      const face = () => ({
        hooks: {
          config: {
            getSnapshot: () => ({
              ...model.shell(),
              appId: model.field('appId'),
              domain: model.field('domain'),
              secretConfigured,
            }),
            subscribe: (listener) => {
              listeners.add(listener)
              const offForm = formStore.subscribe(listener)
              refresh()
              return () => { listeners.delete(listener); offForm() }
            },
          },
        },
        ...model.actions(),
        storeSecret,
      })
      return { face, dispose: () => { model.dispose(); listeners.clear() } }
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'remote.credentials'],
      apply(ctx) {
        const card = buildConfigCard(ctx)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-feishu-gateway: dictionaries')
        ctx.effect(() => () => { card.dispose() }, 'dsh-feishu-gateway: config model')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: ID, locale: NS, inject: card.face },
          FeishuGatewayConfigCard,
        )), 'dsh-feishu-gateway: bundle config card')
      },
    }
  },
})
