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
 * package name). The card edits appId / appSecretEnv / domain through a
 * SettingsFormModel over the shared ConfigForm of the `feishu-gateway` row.
 * The secret itself is not a form value: `appSecretEnv` names a credential
 * reference resolved Host-side through the credentials service.
 */
window.__ModuleLoader__.load({
  id: 'dsh-feishu-gateway',
  factory(require) {
    const React = require('react')
    const {
      SettingsForm, SettingsValueField, SettingsFormModel, settingsTextField,
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
      'config.appSecretEnv': '凭证引用（环境变量名）',
      'config.appSecretEnvHint': 'App Secret 存放的位置，经 dsh 凭证服务解析；填环境变量名（如 FEISHU_APP_SECRET），secret 本身不写进配置',
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
      'config.appSecretEnv': 'Credential reference (env var name)',
      'config.appSecretEnvHint': 'Where the app secret lives, resolved through the dsh credentials service; enter an environment-variable name (e.g. FEISHU_APP_SECRET) — never the secret itself',
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
    const SecretEnvField = textField('appSecretEnv', 'feishu-gateway-config-secret-env')
    const DomainField = textField('domain', 'feishu-gateway-config-domain')

    /**
     * The config card: shared form chrome plus the three staged fields. The
     * Plugins page supplies `view` ('page' | 'summary'), `t`, the face's
     * `useConfig` hook, and the staged-form actions.
     */
    function FeishuGatewayConfigCard(props) {
      const { view, t, useConfig, edit, resetField, save, discard } = props
      const state = useConfig(snapshot => snapshot)
      if (view === 'summary') return t('config.summary')
      const fieldProps = { state, edit, resetField }
      return h(SettingsForm, { labels: formLabels(t), state, onSave: save, onDiscard: discard },
        h(AppIdField, { t, ...fieldProps }),
        h(SecretEnvField, { t, ...fieldProps }),
        h(DomainField, { t, ...fieldProps }))
    }

    /**
     * Build the staged model over the row's shared ConfigForm.
     * @param {any} ctx - client context carrying configForms.
     * @returns {{face: () => object, dispose: () => void}} the slot registration inputs.
     */
    function buildConfigCard(ctx) {
      const configForm = ctx.configForms.get(ROW)
      const model = new SettingsFormModel(
        configForm,
        [settingsTextField('appId'), settingsTextField('appSecretEnv'), settingsTextField('domain')],
      )
      return {
        face: () => ({ hooks: { config: model.bind(() => ({
          ...model.shell(),
          appId: model.field('appId'),
          appSecretEnv: model.field('appSecretEnv'),
          domain: model.field('domain'),
        })) }, ...model.actions() }),
        dispose: () => { model.dispose() },
      }
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
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
