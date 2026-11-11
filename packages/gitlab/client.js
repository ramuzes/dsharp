/**
 * dsh-gitlab — browser half.
 *
 * One self-contained script in the client module system's factory format: it
 * calls window.__ModuleLoader__.load() with the package name and a factory
 * that lazily requires its modules (React and the staged-form primitives are
 * module-table identities, so nothing is bundled) and returns a cordis plugin
 * object.
 *
 * The plugin contributes exactly one thing: the bundle's own configuration
 * card on the Plugins page (the `plugins.bundle.config` slot, keyed by the
 * package name). The card edits baseUrl / tokenEnv / timeouts /
 * workspaceRoots through a SettingsFormModel over the shared ConfigForm of
 * the `gitlab` row. The access token is the model's write-only control
 * (feishu-gateway card pattern): staged with the form, written on save
 * through the credentials Remote under the reference named by `tokenEnv`,
 * never echoed back — the card shows only 已配置/未配置.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gitlab',
  factory(require) {
    const React = require('react')
    const {
      SettingsForm, SettingsValueField, SettingsSecretField, SettingsFormModel,
      settingsTextField, settingsNumberField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Registration identity: the package name, the slot key the card files under. */
    const ID = 'dsh-gitlab'
    /** The Loader row id whose ConfigForm backs the card. */
    const ROW = 'gitlab'
    /** This plugin's copy namespace. */
    const NS = 'gitlab'

    const zh = {
      'config.summary': 'GitLab 实例地址、访问令牌与工具运行参数。',
      'config.baseUrl': '实例地址',
      'config.baseUrlHint': 'GitLab 根 URL，如 https://gitlab.example.com（自建或 gitlab.com）。',
      'config.tokenEnv': '令牌引用名',
      'config.tokenEnvHint': 'dsh 凭据存储里的引用名（默认 GITLAB_TOKEN）；令牌本体经下方密钥控件写入。',
      'config.token': '访问令牌',
      'config.tokenHint': 'GitLab Personal Access Token；填入后存入 dsh 凭据存储，不会再次显示。',
      'config.secretSet': '已配置',
      'config.secretUnset': '未配置（也可在启动环境 export GITLAB_TOKEN）',
      'config.apiTimeoutMs': 'REST 超时 (ms)',
      'config.gitTimeoutMs': 'git 命令超时 (ms)',
      'config.workspaceRoots': '工作区根目录',
      'config.workspaceRootsHint': 'git 本地操作允许的目录，逗号分隔（目录名可含空格）；留空则回退到启动环境 GITLAB_WORKSPACE_ROOTS。',
      'config.unavailable': '配置不可用',
      'config.readOnly': '只读',
      'config.saveFailed': '保存失败',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.overridden': '已被覆盖',
      'config.reset': '重置',
      'config.invalid': '无效',
    }
    const en = {
      'config.summary': 'GitLab instance URL, access token, and tool runtime parameters.',
      'config.baseUrl': 'Instance URL',
      'config.baseUrlHint': 'GitLab root URL, e.g. https://gitlab.example.com (self-hosted or gitlab.com).',
      'config.tokenEnv': 'Token reference',
      'config.tokenEnvHint': "Credential-store reference name (default GITLAB_TOKEN); the token itself is written via the secret control below.",
      'config.token': 'Access token',
      'config.tokenHint': 'GitLab personal access token; stored in the dsh credential store, never shown again.',
      'config.secretSet': 'Configured',
      'config.secretUnset': 'Not set (or export GITLAB_TOKEN in the launch environment)',
      'config.apiTimeoutMs': 'REST timeout (ms)',
      'config.gitTimeoutMs': 'git timeout (ms)',
      'config.workspaceRoots': 'Workspace roots',
      'config.workspaceRootsHint': 'Directories git operations may touch, comma-separated (paths may contain spaces); empty falls back to GITLAB_WORKSPACE_ROOTS.',
      'config.unavailable': 'Configuration unavailable',
      'config.readOnly': 'read-only',
      'config.saveFailed': 'Save failed',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.overridden': 'overridden',
      'config.reset': 'reset',
      'config.invalid': 'invalid',
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

    /** One plain value field over the staged model (chrome-cdp pattern). */
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

    const BaseUrlField = textField('baseUrl', 'gitlab-config-base-url')
    const TokenEnvField = textField('tokenEnv', 'gitlab-config-token-env')
    const ApiTimeoutField = textField('apiTimeoutMs', 'gitlab-config-api-timeout-ms', { numeric: true })
    const GitTimeoutField = textField('gitTimeoutMs', 'gitlab-config-git-timeout-ms', { numeric: true })
    const WorkspaceRootsField = textField('workspaceRoots', 'gitlab-config-workspace-roots')

    /**
     * The config card: shared form chrome, the staged value fields, and the
     * credentials-backed secret control (feishu-gateway card pattern).
     */
    function GitlabConfigCard(props) {
      const { view, t, useConfig, edit, resetField, save, discard } = props
      const state = useConfig((snapshot) => snapshot)
      if (view === 'summary') return t('config.summary')
      const fieldProps = { state, edit, resetField }
      return h(SettingsForm, { labels: formLabels(t), state, onSave: save, onDiscard: discard },
        h(BaseUrlField, { t, ...fieldProps }),
        h(SettingsSecretField, {
          id: 'gitlab-config-token',
          label: t('config.token'),
          hint: t('config.tokenHint'),
          disabled: !state.writable,
          text: state.token.text,
          configured: state.tokenConfigured,
          stateLabel: state.tokenConfigured ? t('config.secretSet') : t('config.secretUnset'),
          onEdit: (text) => { edit('token', text) },
        }),
        h(TokenEnvField, { t, ...fieldProps }),
        h(ApiTimeoutField, { t, ...fieldProps }),
        h(GitTimeoutField, { t, ...fieldProps }),
        h(WorkspaceRootsField, { t, ...fieldProps }))
    }

    /**
     * Build the staged model over the row's shared ConfigForm. The token is
     * one of the model's write-only controls (third constructor arg): its
     * draft stages with the form, a save writes it through the credentials
     * Remote under the reference named by `tokenEnv`, and a blank draft
     * writes nothing. The literal never rides a form response or a patch
     * layer; presence comes from CredentialInfo.configured.
     * @param {any} ctx - client context carrying configForms + remote.credentials.
     * @returns {{face: () => object, dispose: () => void}} the slot registration inputs.
     */
    function buildConfigCard(ctx) {
      const configForm = ctx.configForms.get(ROW)

      /** The credential reference the Host resolves; `tokenEnv` names it. */
      const refOf = () => {
        const value = configForm.getSnapshot().value?.tokenEnv
        return typeof value === 'string' && value !== '' ? value : 'GITLAB_TOKEN'
      }

      // Token presence, refreshed on subscribe and after each write. The
      // config snapshot is MEMOIZED: getSnapshot must return the same object
      // between notifications or React's useSyncExternalStore loops
      // (Minified React error #185).
      let tokenConfigured = false
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
        if (next === tokenConfigured && snapshotCache !== null) return
        tokenConfigured = next
        notify()
      }
      /** The secret spec's save-time write: store, then re-read presence. */
      const writeToken = async (text) => {
        await ctx.remote.credentials.set(refOf(), text)
        await refresh()
        return tokenConfigured
      }

      // Field specs mirroring the host Config schema (index.js).
      const timeoutSpec = (field) => {
        const base = settingsNumberField(field)
        return {
          field,
          format: base.format,
          parse: (text) => {
            const write = base.parse(text)
            if (write === undefined || write.kind !== 'set') return write
            // Mirror the schema's .min(1000): a smaller number blocks the save here.
            return write.value >= 1000 ? write : undefined
          },
        }
      }
      const workspaceRootsSpec = {
        field: 'workspaceRoots',
        format: (value) => Array.isArray(value) ? value.join(', ') : '',
        parse: (text) => {
          // Paths may contain spaces; split only on commas and new lines.
          const roots = text.split(/[,\n]+/).map((line) => line.trim()).filter((line) => line !== '')
          return roots.length === 0 ? { kind: 'clear' } : { kind: 'set', value: roots }
        },
      }

      const model = new SettingsFormModel(
        configForm,
        [
          settingsTextField('baseUrl'),
          settingsTextField('tokenEnv'),
          timeoutSpec('apiTimeoutMs'),
          timeoutSpec('gitTimeoutMs'),
          workspaceRootsSpec,
        ],
        [{ field: 'token', write: writeToken }],
      )
      const formStore = model.bind(() => ({}))
      const computeSnapshot = () => ({
        ...model.shell(),
        baseUrl: model.field('baseUrl'),
        tokenEnv: model.field('tokenEnv'),
        apiTimeoutMs: model.field('apiTimeoutMs'),
        gitTimeoutMs: model.field('gitTimeoutMs'),
        workspaceRoots: model.field('workspaceRoots'),
        token: model.field('token'),
        tokenConfigured,
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
        const card = buildConfigCard(ctx)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gitlab: dictionaries')
        ctx.effect(() => () => { card.dispose() }, 'dsh-gitlab: config model')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: ID, locale: NS, inject: card.face },
          GitlabConfigCard,
        )), 'dsh-gitlab: bundle config card')
      },
    }
  },
})
