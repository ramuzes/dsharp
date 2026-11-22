/**
 * dsh-engram — browser half.
 *
 * One self-contained script in the client module system's factory format
 * (packages/gitlab/client.js skeleton): window.__ModuleLoader__.load() with
 * the package name and a factory that lazily requires its modules (React and
 * the staged-form primitives are module-table identities, so nothing is
 * bundled) and returns a cordis plugin object.
 *
 * The plugin contributes exactly one thing: the bundle's own configuration
 * card on the Plugins page (the `plugins.bundle.config` slot, keyed by the
 * package name). The card edits daemonMode / port / the daemon HTTP token
 * (write-only secret control, stored under the httpTokenRef credential
 * reference) / autosync / projectMode / fixedProject / projectMap /
 * contextInjection / contextMaxBytes over the shared ConfigForm of the
 * `engram` row.
 *
 * Inject list matches the proven gitlab card exactly, including
 * 'remote.credentials': the credentials Remote namespace is its own inject
 * entry — accessing ctx.remote.credentials without it throws in the client
 * inject system, which (contained) registered nothing and made the whole
 * card disappear silently. The enum and boolean fields render as text
 * fields whose hints list the legal values (the primitives ship no select
 * or checkbox; chrome-cdp does the same for its enums).
 */
window.__ModuleLoader__.load({
  id: 'dsh-engram',
  factory(require) {
    const React = require('react')
    const {
      SettingsForm, SettingsValueField, SettingsSecretField, SettingsFormModel,
      settingsTextField, settingsNumberField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Registration identity: the package name, the slot key the card files under. */
    const ID = 'dsh-engram'
    /** The Loader row id whose ConfigForm backs the card (cordis.patch.yml). */
    const ROW = 'engram'
    /** This plugin's copy namespace. */
    const NS = 'engram'

    const zh = {
      'config.summary': 'engram 持久记忆：守护进程托管、项目解析、可选的上下文注入与自动同步开关。',
      'config.daemonMode': '守护进程模式',
      'config.daemonModeHint': 'auto-spawn（默认，按需拉起本地守护进程）或 connect-only（仅连接已运行实例）。结构字段，保存后重载插件生效',
      'config.port': '守护进程端口',
      'config.portHint': '如 7437；留空使用 engram 协议默认端口',
      'config.httpToken': 'HTTP 令牌',
      'config.httpTokenHint': '守护进程本地 API 的 Bearer 令牌；填入后存入 dsh 凭据存储，不会再次显示',
      'config.secretSet': '已配置',
      'config.secretUnset': '未配置（留空表示守护进程无鉴权）',
      'config.autosync': '自动同步',
      'config.autosyncHint': 'true / false（默认 false）。仅对 DSH 拉起的守护进程生效：注入 ENGRAM_CLOUD_AUTOSYNC=1 开启后台云同步',
      'config.cloudNote': '云同步的服务器与令牌沿用 engram 自身的配置（~/.engram/cloud.json，经 engram cloud config/enroll 设置）——此处不重复配置，避免覆盖。',
      'config.projectMode': '项目模式',
      'config.projectModeHint': 'auto（默认，按工作目录自动解析）/ fixed（固定项目）/ map（按映射表）',
      'config.fixedProject': '固定项目',
      'config.fixedProjectHint': 'projectMode=fixed 时使用的 engram 项目名',
      'config.projectMap': '项目映射表',
      'config.projectMapHint': '逗号分隔的「目录名=engram 项目名」，如 ws-a=projA, ws-b=projB；留空恢复默认空表',
      'config.contextInjection': '上下文注入',
      'config.contextInjectionHint': 'off（默认）/ on：on 时在每轮对话注入记忆摘要',
      'config.contextMaxBytes': '注入字节上限',
      'config.contextMaxBytesHint': '不小于 0 的字节数，默认 2048',
      'config.unavailable': '配置不可用',
      'config.readOnly': '只读',
      'config.saveFailed': '保存失败',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.overridden': '已覆盖',
      'config.reset': '重置',
      'config.invalid': '无效值',
    }
    const en = {
      'config.summary': 'Durable engram memory: daemon stewardship, project resolution, optional context injection, and an autosync switch.',
      'config.daemonMode': 'Daemon mode',
      'config.daemonModeHint': 'auto-spawn (default; the host spawns the local daemon as needed) or connect-only (attach to an already-running instance). Structural: takes effect after plugin reload',
      'config.port': 'Daemon port',
      'config.portHint': "e.g. 7437; empty uses engram's documented protocol default",
      'config.httpToken': 'HTTP token',
      'config.httpTokenHint': "Bearer token for the daemon's local API; stored in the dsh credential store, never shown again",
      'config.secretSet': 'Configured',
      'config.secretUnset': 'Not set (empty means the daemon takes no auth)',
      'config.autosync': 'Autosync',
      'config.autosyncHint': 'true / false (default false). Applies only to daemons DSH spawns: injects ENGRAM_CLOUD_AUTOSYNC=1 for background cloud sync',
      'config.cloudNote': "Cloud sync reuses engram's own configuration (~/.engram/cloud.json via `engram cloud config/enroll`) — deliberately not duplicated here, so nothing shadows your setup.",
      'config.projectMode': 'Project mode',
      'config.projectModeHint': 'auto (default; resolve from the working directory) / fixed (one fixed project) / map (per mapping table)',
      'config.fixedProject': 'Fixed project',
      'config.fixedProjectHint': 'The engram project name used when projectMode is fixed',
      'config.projectMap': 'Project map',
      'config.projectMapHint': 'Comma-separated "directory-name=engram-project" pairs, e.g. ws-a=projA, ws-b=projB; empty restores the default empty map',
      'config.contextInjection': 'Context injection',
      'config.contextInjectionHint': 'off (default) / on: on injects a memory summary into every prompt',
      'config.contextMaxBytes': 'Injection byte cap',
      'config.contextMaxBytesHint': 'Bytes, at least 0; default 2048',
      'config.unavailable': 'Configuration unavailable',
      'config.readOnly': 'Read-only',
      'config.saveFailed': 'Save failed',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.overridden': 'Overridden',
      'config.reset': 'Reset',
      'config.invalid': 'Invalid value',
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

    /** One plain value field over the staged model (gitlab card pattern). */
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

    const DaemonModeField = textField('daemonMode', 'engram-config-daemon-mode')
    const PortField = textField('port', 'engram-config-port')
    const AutosyncField = textField('autosync', 'engram-config-autosync')
    const ProjectModeField = textField('projectMode', 'engram-config-project-mode')
    const FixedProjectField = textField('fixedProject', 'engram-config-fixed-project')
    const ProjectMapField = textField('projectMap', 'engram-config-project-map')
    const InjectionField = textField('contextInjection', 'engram-config-context-injection')
    const MaxBytesField = textField('contextMaxBytes', 'engram-config-context-max-bytes', { numeric: true })

    /**
     * The config card: shared form chrome, the staged value fields, the
     * write-only token control, and a note pointing cloud configuration at
     * engram's own cloud.json (gitlab/feishu card pattern).
     */
    function EngramConfigCard(props) {
      const { view, t, useConfig, edit, resetField, save, discard } = props
      const state = useConfig((snapshot) => snapshot)
      if (view === 'summary') return t('config.summary')
      const fieldProps = { state, edit, resetField }
      return h(SettingsForm, { labels: formLabels(t), state, onSave: save, onDiscard: discard },
        h(DaemonModeField, { t, ...fieldProps }),
        h(PortField, { t, ...fieldProps }),
        h(SettingsSecretField, {
          id: 'engram-config-http-token',
          label: t('config.httpToken'),
          hint: t('config.httpTokenHint'),
          disabled: !state.writable,
          text: state.httpToken.text,
          configured: state.tokenConfigured,
          stateLabel: state.tokenConfigured ? t('config.secretSet') : t('config.secretUnset'),
          onEdit: (text) => { edit('httpToken', text) },
        }),
        h('p', { style: { margin: '0 0 4px', fontSize: '13px' } }, t('config.cloudNote')),
        h(AutosyncField, { t, ...fieldProps }),
        h(ProjectModeField, { t, ...fieldProps }),
        h(FixedProjectField, { t, ...fieldProps }),
        h(ProjectMapField, { t, ...fieldProps }),
        h(InjectionField, { t, ...fieldProps }),
        h(MaxBytesField, { t, ...fieldProps }))
    }

    /**
     * Build the staged model over the row's shared ConfigForm. The daemon
     * token is one of the model's write-only controls (third constructor
     * arg): its draft stages with the form, a save writes it through the
     * credentials Remote under the reference named by `httpTokenRef`, and a
     * blank draft writes nothing (gitlab writeToken pattern).
     * @param {any} ctx - client context carrying configForms + remote.credentials.
     * @returns {{face: () => object, dispose: () => void}} the slot registration inputs.
     */
    function buildConfigCard(ctx) {
      const configForm = ctx.configForms.get(ROW)

      /** The credential reference the Host resolves; `httpTokenRef` names it. */
      const refOf = () => {
        const value = configForm.getSnapshot().value?.httpTokenRef
        return typeof value === 'string' && value !== '' ? value : 'ENGRAM_HTTP_TOKEN'
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

      // Field specs mirroring the host Config schema (index.js). Enum-typed
      // and boolean fields accept exactly their legal values (anything else
      // blocks the save); projectMap renders one comma-separated pair list.
      const enumSpec = (field, legal) => {
        const base = settingsTextField(field)
        return {
          field,
          format: base.format,
          parse: (text) => {
            const trimmed = text.trim()
            if (trimmed === '') return { kind: 'clear' }
            return legal.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
          },
        }
      }
      const booleanSpec = enumSpec('autosync', ['true', 'false'])
      const projectMapSpec = {
        field: 'projectMap',
        format: (value) => value !== null && typeof value === 'object'
          ? Object.entries(value).map(([name, project]) => `${name}=${project}`).join(', ')
          : '',
        parse: (text) => {
          const parts = text.split(',').map((part) => part.trim()).filter((part) => part !== '')
          if (parts.length === 0) return { kind: 'clear' }
          const map = {}
          for (const part of parts) {
            const eq = part.indexOf('=')
            if (eq <= 0) return undefined // no name, or no separator: block, don't guess
            map[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
          }
          return { kind: 'set', value: map }
        },
      }
      const model = new SettingsFormModel(
        configForm,
        [
          enumSpec('daemonMode', ['auto-spawn', 'connect-only']),
          settingsTextField('port'),
          enumSpec('projectMode', ['auto', 'fixed', 'map']),
          settingsTextField('fixedProject'),
          projectMapSpec,
          enumSpec('contextInjection', ['off', 'on']),
          settingsNumberField('contextMaxBytes'),
          booleanSpec,
        ],
        [{ field: 'httpToken', write: writeToken }],
      )
      const formStore = model.bind(() => ({}))
      const computeSnapshot = () => ({
        ...model.shell(),
        daemonMode: model.field('daemonMode'),
        port: model.field('port'),
        httpToken: model.field('httpToken'),
        autosync: model.field('autosync'),
        projectMode: model.field('projectMode'),
        fixedProject: model.field('fixedProject'),
        projectMap: model.field('projectMap'),
        contextInjection: model.field('contextInjection'),
        contextMaxBytes: model.field('contextMaxBytes'),
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
        // Containment: a failed card build must register NOTHING — a dead
        // entry or a missing dictionary would blank the slot cell for the
        // whole bundle. The failure is logged; the Plugins page simply shows
        // no config card instead of a broken one.
        let card = null
        try {
          card = buildConfigCard(ctx)
        } catch (error) {
          console.error('[dsh-engram] config card build failed:', error)
        }
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-engram: dictionaries')
        if (card === null) return
        ctx.effect(() => () => { card.dispose() }, 'dsh-engram: config model')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: ID, locale: NS, inject: card.face },
          EngramConfigCard,
        )), 'dsh-engram: bundle config card')
      },
    }
  },
})
