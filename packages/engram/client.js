/**
 * dsh-engram — browser half.
 *
 * One self-contained script in the client module system's factory format,
 * mirroring packages/chrome-cdp/client.js: window.__ModuleLoader__.load()
 * with the package name and a factory that lazily requires its modules and
 * returns a cordis plugin object.
 *
 * The plugin contributes exactly one thing: the bundle's own configuration
 * card on the Plugins page (the `plugins.bundle.config` slot, keyed by the
 * package name). The card edits the host Config fields (index.js) grouped
 * as Daemon (daemonMode / port / httpTokenRef), Project (projectMode /
 * fixedProject / projectMap), Injection (contextInjection / contextMaxBytes),
 * and Cloud (an autosync switch; cloud server/token deliberately stay with
 * engram's own configuration). toolProfile stays out of the card (advanced,
 * v1 core-only). There is NO status section: v1
 * has no Remote namespace. Chrome-cdp's `chromeCdp` status namespace is the
 * v2 precedent if a live-status card is added later.
 *
 * Implementation note — no `@deepseek-ai/dsh-client-ui-*` import (repo rule:
 * copy markup, never require the primitives module). The staged-form model
 * and the field chrome are therefore hand-rolled here as a faithful SUBSET
 * of the shipped primitives (verified against the dsh checkout,
 * packages/client/ui-primitives/src/settings-form/form-model.ts and
 * SettingsForm.tsx / fields.tsx): staged drafts, an overridden badge from
 * user-layer PRESENCE (not value comparison), revision-fenced saves with
 * read-back re-seed, invalid drafts blocking the save, and discard-on-unmount.
 * Markup/CSS behavior copies those components with `engram-`-prefixed classes
 * and only `--dsw-alias-*` theme tokens, injected as one plugin-tagged style
 * element (the airboard pattern).
 */
window.__ModuleLoader__.load({
  id: 'dsh-engram',
  factory(require) {
    const React = require('react')
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
      'config.daemonModeHint': 'auto-spawn（默认，按需拉起本地守护进程）或 connect-only（仅连接已运行的实例）。结构字段，保存后重载插件生效',
      'config.port': '守护进程端口',
      'config.portHint': '如 7437；留空使用 engram 协议默认端口',
      'config.httpToken': 'HTTP 令牌',
      'config.httpTokenHint': '守护进程本地 API 的 Bearer 令牌；填入后存入 dsh 凭据存储，不会再次显示',
      'config.secretSet': '已配置',
      'config.secretUnset': '未配置（留空表示守护进程无鉴权）',
      'config.projectMode': '项目模式',
      'config.projectModeHint': 'auto（按工作目录自动解析）/ fixed（固定项目）/ map（按映射表）；留空恢复 auto',
      'config.fixedProject': '固定项目',
      'config.fixedProjectHint': 'projectMode=fixed 时使用的 engram 项目名',
      'config.projectMap': '项目映射表',
      'config.projectMapHint': '每行一条「目录名=engram 项目名」；留空恢复默认空表',
      'config.contextInjection': '上下文注入',
      'config.contextInjectionHint': 'off（默认）/ on：on 时在每轮对话注入记忆摘要',
      'config.contextMaxBytes': '注入字节上限',
      'config.contextMaxBytesHint': '不小于 0 的字节数，默认 2048',
      'config.autosync': '自动同步',
      'config.autosyncHint': '仅对 DSH 拉起的守护进程生效：注入 ENGRAM_CLOUD_AUTOSYNC=1 开启后台云同步',
      'config.cloudNote': '云同步的服务器与令牌沿用 engram 自身的配置（~/.engram/cloud.json，经 engram cloud config/enroll 设置）——此处不重复配置，避免覆盖。',
      'group.daemon': '守护进程',
      'group.project': '项目',
      'group.injection': '注入',
      'group.cloud': '云端',
      'config.overridden': '已覆盖',
      'config.reset': '重置',
      'config.invalid': '无效值',
      'config.unavailable': '配置不可用',
      'config.readOnly': '只读',
      'config.saveFailed': '保存失败',
      'config.save': '保存',
      'config.saving': '保存中…',
    }

    const en = {
      'config.summary': 'Durable engram memory: daemon stewardship, project resolution, optional context injection, and an autosync switch.',
      'config.daemonMode': 'Daemon mode',
      'config.daemonModeHint': 'auto-spawn (default; the host spawns the local daemon as needed) or connect-only (attach to an already-running instance). Structural: takes effect after plugin reload',
      'config.port': 'Daemon port',
      'config.portHint': 'e.g. 7437; empty uses engram\'s documented protocol default',
      'config.httpToken': 'HTTP token',
      'config.httpTokenHint': "Bearer token for the daemon's local API; stored in the dsh credential store, never shown again",
      'config.secretSet': 'Configured',
      'config.secretUnset': 'Not set (empty means the daemon takes no auth)',
      'config.projectMode': 'Project mode',
      'config.projectModeHint': 'auto (resolve from the working directory) / fixed (one fixed project) / map (per mapping table); empty re-inherits auto',
      'config.fixedProject': 'Fixed project',
      'config.fixedProjectHint': 'The engram project name used when projectMode is fixed',
      'config.projectMap': 'Project map',
      'config.projectMapHint': 'One "directory-name=engram-project" pair per line; empty restores the default empty map',
      'config.contextInjection': 'Context injection',
      'config.contextInjectionHint': 'off (default) / on: on injects a memory summary into every prompt',
      'config.contextMaxBytes': 'Injection byte cap',
      'config.contextMaxBytesHint': 'Bytes, at least 0; default 2048',
      'config.autosync': 'Autosync',
      'config.autosyncHint': 'Applies only to daemons DSH spawns: injects ENGRAM_CLOUD_AUTOSYNC=1 for background cloud sync',
      'config.cloudNote': 'Cloud sync reuses engram\'s own configuration (~/.engram/cloud.json via `engram cloud config/enroll`) — deliberately not duplicated here, so nothing shadows your setup.',
      'group.daemon': 'Daemon',
      'group.project': 'Project',
      'group.injection': 'Injection',
      'group.cloud': 'Cloud',
      'config.overridden': 'Overridden',
      'config.reset': 'Reset',
      'config.invalid': 'Invalid value',
      'config.unavailable': 'Configuration unavailable',
      'config.readOnly': 'Read-only',
      'config.saveFailed': 'Save failed',
      'config.save': 'Save',
      'config.saving': 'Saving…',
    }

    /** Minimal snapshot store: same reference between notifications (React uSES #185 rule). */
    function createStore(initial) {
      let cache = initial
      const listeners = new Set()
      return {
        getSnapshot: () => cache,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        set(next) {
          if (next === cache) return
          cache = next
          for (const listener of listeners) listener()
        },
      }
    }

    /**
     * Field specs mirroring the host Config schema (index.js). All enum and
     * free-text fields have schema defaults, so an empty draft clears and the
     * field re-inherits the default; an illegal draft parses to undefined,
     * which marks the field invalid and blocks the save.
     */
    const enumField = (field, legal) => ({
      field,
      format: (value) => typeof value === 'string' ? value : '',
      parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        return legal.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
      },
    })
    const textField = (field) => ({
      field,
      format: (value) => typeof value === 'string' ? value : '',
      parse: (text) => {
        const trimmed = text.trim()
        return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
      },
    })
    // port is a STRING in the schema ('' = engram's protocol default), but only
    // digits can be a port, so anything else blocks the save instead of staging
    // a doomed write.
    const portField = {
      field: 'port',
      format: (value) => typeof value === 'string' ? value : '',
      parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        return /^\d+$/.test(trimmed) ? { kind: 'set', value: trimmed } : undefined
      },
    }
    // projectMap is Schema.dict(String): one "name=project" pair per line.
    const projectMapField = {
      field: 'projectMap',
      format: (value) => value !== null && typeof value === 'object'
        ? Object.entries(value).map(([name, project]) => `${name}=${project}`).join('\n')
        : '',
      parse: (text) => {
        const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
        if (lines.length === 0) return { kind: 'clear' }
        const map = {}
        for (const line of lines) {
          const eq = line.indexOf('=')
          if (eq <= 0) return undefined // no name, or no separator: block, don't guess
          map[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
        }
        return { kind: 'set', value: map }
      },
    }
    // Mirror Schema.number().min(0): a negative draft blocks the save here.
    const contextMaxBytesField = {
      field: 'contextMaxBytes',
      format: (value) => typeof value === 'number' ? String(value) : '',
      parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        const parsed = Number(trimmed)
        return Number.isFinite(parsed) && parsed >= 0 ? { kind: 'set', value: parsed } : undefined
      },
    }
    // autosync is a boolean rendered as a checkbox: 'true' stages a set, any
    // other state stages a clear (re-inherits the default false).
    const autosyncField = {
      field: 'autosync',
      format: (value) => value === true ? 'true' : 'false',
      parse: (text) => text === 'true' ? { kind: 'set', value: true } : { kind: 'clear' },
    }

    const DAEMON_MODES = ['auto-spawn', 'connect-only'] // index.js Schema.union(...)
    const PROJECT_MODES = ['auto', 'fixed', 'map'] // index.js Schema.union(...)
    const INJECTION_MODES = ['off', 'on'] // index.js Schema.union(...)

    /**
     * Staged-form model — a faithful subset of the shipped SettingsFormModel
     * (dsh checkout, ui-primitives/src/settings-form/form-model.ts): staged
     * drafts per field, a plan built in staging order, one revision-fenced
     * mutate per save with read-back re-seed, and overridden from user-layer
     * PRESENCE. Secret fields follow the feishu SettingsSecretField pattern
     * (hand-rolled so this card stays free of the primitives module):
     * write-only staged text saved through the credentials Remote instead of
     * a config op, a Configured/Not-set badge from describe, never a
     * read-back, and blank staging is a no-op.
     */
    class EngramFormModel {
      constructor(scope, specs, secrets = {}) {
        this.specs = new Map(specs.map((spec) => [spec.field, spec]))
        this.scope = scope
        // field -> { refOf: () => credential ref name }; secretApi is the
        // client credentials Remote ({ set(ref, value), describe(refs) }) or
        // null when unavailable (controls render disabled).
        this.secrets = secrets.fields ?? {}
        this.secretApi = secrets.api ?? null
        this.secretConfigured = {}
        this.staged = new Map()
        this.listeners = new Set()
        this.baseline = undefined
        this.saving = false
        this.failed = false
        this.unsubscribe = scope.subscribe(() => { this.publish() })
      }

      bind(project) {
        const store = createStore(project())
        this.listeners.add(() => { store.set(project()) })
        return store
      }

      shell() {
        const snapshot = this.scope.getSnapshot()
        const plan = this.plan()
        return {
          available: snapshot.status === 'ready',
          writable: snapshot.writable,
          dirty: plan.length > 0,
          invalid: plan.some((item) => item.op === undefined && item.run === undefined),
          saving: this.saving,
          failed: this.failed,
        }
      }

      field(name) {
        // Secret fields have no config spec: write-only staged text plus the
        // Configured badge from the last credentials describe.
        if (this.secrets[name] !== undefined) {
          const staged = this.staged.get(name)
          return {
            text: staged?.text ?? '',
            overridden: false,
            invalid: false,
            configured: this.secretConfigured[name] ?? false,
            available: this.secretApi !== null,
          }
        }
        const spec = this.spec(name)
        const staged = this.staged.get(name)
        if (staged === undefined) {
          return {
            text: spec.format(this.sectionValue(name)),
            overridden: this.stored(name),
            invalid: false,
          }
        }
        const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
        return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
      }

      actions() {
        return {
          edit: (field, text) => { this.stage(field, { text, clear: false }) },
          resetField: (field) => { this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true }) },
          save: () => { void this.save() },
          discard: () => {
            if (this.staged.size === 0 && !this.failed) return
            this.staged.clear()
            this.baseline = undefined
            this.failed = false
            this.publish()
          },
        }
      }

      async save() {
        const plan = this.plan()
        if (!plan.length || this.saving || !this.scope.getSnapshot().writable
          || plan.some((item) => item.op === undefined && item.run === undefined)) return
        this.saving = true
        this.failed = false
        this.publish()
        try {
          const ops = plan.flatMap((item) => item.op === undefined ? [] : [item.op])
          const runs = plan.flatMap((item) => item.run === undefined ? [] : [item.run])
          const landed = !ops.length || await this.scope.mutate(ops, this.baseline?.revision)
          let runsLanded = true
          if (landed && runs.length) {
            try { for (const run of runs) await run() } catch { runsLanded = false }
            await this.refreshSecrets()
          }
          const ok = landed && runsLanded
          if (ok) { this.staged.clear(); this.baseline = undefined }
          this.failed = !ok
        } catch {
          this.failed = true
        } finally {
          this.saving = false
          this.publish()
        }
      }

      dispose() { this.unsubscribe(); this.listeners.clear() }

      /** Every staged edit a save would write, in staging order. */
      plan() {
        const plan = []
        // Secret fields first: non-empty staged text becomes a credentials
        // write (run) — never a config op; empty/blank staging is a no-op
        // (a blank save never clobbers the stored secret).
        for (const [name, spec] of Object.entries(this.secrets)) {
          const staged = this.staged.get(name)
          if (staged === undefined || staged.clear) continue
          const value = staged.text.trim()
          if (value === '') continue
          plan.push({
            field: name,
            run: async () => { await this.secretApi.set(spec.refOf(), value) },
          })
        }
        for (const [field, staged] of this.staged) {
          if (this.secrets[field] !== undefined) continue
          const spec = this.spec(field)
          if (staged.clear) {
            if (this.stored(field)) plan.push({ field, op: { op: 'unset', path: [field] } })
            continue
          }
          if (staged.text === spec.format(this.sectionValue(field))) continue
          const write = spec.parse(staged.text)
          if (write === undefined) plan.push({ field })
          else if (write.kind === 'clear') plan.push({ field, op: { op: 'unset', path: [field] } })
          else plan.push({ field, op: { op: 'set', path: [field], value: write.value } })
        }
        return plan
      }

      /** Refresh the Configured badges from the credentials store (contained). */
      async refreshSecrets() {
        if (this.secretApi === null) return
        try {
          const entries = Object.entries(this.secrets)
          const refs = entries.map(([, spec]) => spec.refOf())
          const infos = await this.secretApi.describe(refs)
          for (const [name, spec] of entries) {
            const info = infos?.[spec.refOf()]
            this.secretConfigured[name] = info?.configured === true
          }
          this.publish()
        } catch { /* keep last-known badges */ }
      }

      stage(field, edit) {
        this.baseline ??= this.scope.getSnapshot()
        this.staged.set(field, edit)
        this.failed = false
        this.publish()
      }

      spec(field) {
        const spec = this.specs.get(field)
        // Every call site names a declared field; a miss is a wiring mistake.
        if (spec === undefined) throw new Error(`plugin card has no field ${field}`)
        return spec
      }

      sectionValue(field) { return this.scope.getSnapshot().value?.[field] }
      baseValue(field) { return this.scope.getSnapshot().base?.[field] }
      stored(field) {
        const user = this.scope.getSnapshot().user
        return user !== undefined && user !== null && Object.hasOwn(user, field)
      }

      publish() { for (const listener of this.listeners) listener() }
    }

    /** Card chrome, copied from the shipped settings-form markup with engram- classes and --dsw-alias-* tokens only. */
    const STYLES = `
.engram-config-form { display: flex; flex-direction: column; gap: 20px; }
.engram-config-notice { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.engram-config-group { display: flex; flex-direction: column; gap: 12px; }
.engram-config-group-title { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.engram-config-footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.engram-config-failed { margin: 0; margin-right: auto; font-size: 13px; color: var(--dsw-alias-label-error); }
.engram-config-save { padding: 5px 14px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; cursor: pointer; }
.engram-config-save:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.engram-config-save:disabled { opacity: 0.5; cursor: default; }
.engram-field { display: flex; flex-direction: column; gap: 4px; }
.engram-field-head { display: flex; align-items: center; gap: 8px; }
.engram-field-label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.engram-field-label:disabled { color: var(--dsw-alias-label-secondary); }
.engram-field-badges { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
.engram-field-badge { font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 1px 8px; }
.engram-field-reset { border: none; background: transparent; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0; }
.engram-field-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.engram-field-reset:disabled { opacity: 0.5; cursor: default; }
.engram-input { box-sizing: border-box; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 5px 8px; }
.engram-input:focus { outline: 1px solid var(--dsw-alias-border-l2); }
.engram-input:disabled { opacity: 0.5; }
.engram-input[aria-invalid='true'] { border-color: var(--dsw-alias-label-error); }
.engram-field-message { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.engram-field-message.engram-field-invalid { color: var(--dsw-alias-label-error); }
.engram-check { display: inline-flex; align-items: center; gap: 6px; }
`

    /** Inject the card's stylesheet once per mount; returns the disposer. */
    function injectStyles() {
      if (typeof document === 'undefined') return undefined
      const style = document.createElement('style')
      style.dataset.plugin = ID
      style.textContent = STYLES
      document.head.append(style)
      return () => { style.remove() }
    }

    /** Labels this card's chrome asks for. */
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
     * One staged field control: label, overridden badge + reset, the input,
     * and the hint (swapped for the invalid message while the draft is not a
     * value the field accepts). Nothing here writes — edit stages only.
     * `numeric` only hints the keypad, as the shipped control does.
     */
    function ValueField({ t, id, field, fieldState, disabled, numeric, onEdit, onReset }) {
      const invalid = fieldState.invalid
      return h('div', { className: 'engram-field' },
        h('div', { className: 'engram-field-head' },
          h('label', { className: 'engram-field-label', htmlFor: id }, t(`config.${field}`)),
          fieldState.overridden
            ? h('span', { className: 'engram-field-badges' },
              h('span', { className: 'engram-field-badge' }, t('config.overridden')),
              h('button', {
                type: 'button', className: 'engram-field-reset', disabled,
                onClick: () => { onReset(field) },
              }, t('config.reset')))
            : null),
        h('input', {
          id,
          className: 'engram-input',
          type: 'text',
          ...(numeric ? { inputMode: 'numeric' } : {}),
          ...(invalid ? { 'aria-invalid': 'true' } : {}),
          value: fieldState.text,
          disabled,
          onChange: (event) => { onEdit(field, event.target.value) },
        }),
        h('p', {
          className: invalid ? 'engram-field-message engram-field-invalid' : 'engram-field-message',
          id: `${id}-message`,
        }, invalid ? t('config.invalid') : t(`config.${field}Hint`)))
    }

    /** The autosync boolean as a checkbox; a toggle stages exactly what a save would store. */
    function CheckField({ t, id, fieldState, disabled, onEdit }) {
      return h('div', { className: 'engram-field' },
        h('div', { className: 'engram-field-head' },
          h('label', { className: 'engram-field-label', htmlFor: id }, t('config.autosync'))),
        h('span', { className: 'engram-check' },
          h('input', {
            id,
            type: 'checkbox',
            checked: fieldState.text === 'true',
            disabled,
            onChange: (event) => { onEdit('autosync', event.target.checked ? 'true' : 'false') },
          }),
          h('p', { className: 'engram-field-message', id: `${id}-message` }, t('config.autosyncHint'))))
    }

    /**
     * A credentials-backed secret control (the feishu SettingsSecretField
     * pattern): write-only input, a Configured/Not-set badge from the last
     * describe, no reset and never a read-back. Blank staging is a no-op — a
     * blank save never clobbers the stored secret.
     */
    function SecretField({ t, id, field, fieldState, disabled, onEdit }) {
      const unavailable = fieldState.available === false
      return h('div', { className: 'engram-field' },
        h('div', { className: 'engram-field-head' },
          h('label', { className: 'engram-field-label', htmlFor: id }, t(`config.${field}`)),
          h('span', { className: 'engram-field-badges' },
            h('span', { className: 'engram-field-badge' },
              unavailable ? t('config.unavailable') : fieldState.configured ? t('config.secretSet') : t('config.secretUnset')))),
        h('input', {
          id,
          className: 'engram-input',
          type: 'password',
          value: fieldState.text,
          disabled: disabled || unavailable,
          autoComplete: 'new-password',
          onChange: (event) => { onEdit(field, event.target.value) },
        }),
        h('p', { className: 'engram-field-message', id: `${id}-message` }, t(`config.${field}Hint`)))
    }

    /**
     * The card's groups, in display order. Each entry names the group label
     * key, the plain value fields it renders, and the write-only secret
     * fields; autosync is the one checkbox and renders inside Cloud with a
     * note pointing at engram's own cloud configuration.
     */
    const GROUPS = [
      { key: 'group.daemon', fields: ['daemonMode', 'port'], secrets: ['httpToken'] },
      { key: 'group.project', fields: ['projectMode', 'fixedProject', 'projectMap'] },
      { key: 'group.injection', fields: ['contextInjection', 'contextMaxBytes'] },
      { key: 'group.cloud', fields: [] },
    ]
    const NUMERIC_FIELDS = new Set(['contextMaxBytes'])

    /**
     * The config card: the shared form chrome over the grouped staged fields.
     * The Plugins page supplies `view` ('page' | 'summary'), `t`, the face's
     * `useConfig` hook, and the staged-form actions.
     */
    function EngramConfigCard(props) {
      const { view, t, useConfig, edit, resetField, save, discard } = props
      const state = useConfig((snapshot) => snapshot)
      // Leaving the page drops every staged edit, as the shipped form does.
      React.useEffect(() => () => { discard() }, [])
      if (view === 'summary') return t('config.summary')
      if (!state.available) return h('p', { className: 'engram-config-notice', role: 'status' }, t('config.unavailable'))
      const fieldProps = { t, disabled: !state.writable, onEdit: edit, onReset: resetField }
      const blocked = !state.dirty || state.invalid || state.saving
      return h('div', { className: 'engram-config-form' },
        !state.writable ? h('p', { className: 'engram-config-notice', role: 'status' }, t('config.readOnly')) : null,
        GROUPS.map((group) => h('section', { className: 'engram-config-group', key: group.key },
          h('h4', { className: 'engram-config-group-title' }, t(group.key)),
          group.key === 'group.cloud'
            ? h('p', { className: 'engram-config-notice', role: 'note' }, t('config.cloudNote'))
            : null,
          group.fields.map((field) => h(ValueField, {
            key: field,
            id: `engram-config-${field}`,
            field,
            fieldState: state[field],
            numeric: NUMERIC_FIELDS.has(field),
            ...fieldProps,
          })),
          (group.secrets ?? []).map((field) => h(SecretField, {
            key: field,
            id: `engram-config-${field}`,
            field,
            fieldState: state[field],
            ...fieldProps,
          })),
          group.key === 'group.cloud'
            ? h(CheckField, { id: 'engram-config-autosync', fieldState: state.autosync, ...fieldProps })
            : null)),
        h('div', { className: 'engram-config-footer' },
          state.failed ? h('p', { className: 'engram-config-failed', role: 'status' }, t('config.saveFailed')) : null,
          h('button', {
            type: 'button', className: 'engram-config-save', disabled: blocked, onClick: save,
          }, state.saving ? t('config.saving') : t('config.save'))))
    }

    /**
     * Build the staged model over the row's shared ConfigForm and expose the
     * slot face: the memoized `config` snapshot hook (same object between
     * notifications — React uSES loops otherwise) plus the staged-form
     * actions. The snapshot memoization and face shape follow
     * packages/chrome-cdp/client.js buildConfigCard.
     * @param {any} ctx - client context carrying configForms.
     * @returns {{face: () => object, dispose: () => void}} the slot registration inputs.
     */
    function buildConfigCard(ctx) {
      const configForm = ctx.configForms.get(ROW)
      // The credentials Remote backs the write-only secret control (feishu
      // pattern); absent remote leaves the control disabled, never broken.
      const remote = ctx.remote
      const secretApi = remote?.credentials && typeof remote.credentials.set === 'function'
        && typeof remote.credentials.describe === 'function'
        ? remote.credentials
        : null
      // Live credential-ref name: the config field's current value, falling
      // back to the schema default ENGRAM_HTTP_TOKEN.
      const httpTokenRefOf = () => {
        const raw = configForm.getSnapshot().value?.httpTokenRef
        const name = typeof raw?.get === 'function' ? raw.get() : raw
        return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'ENGRAM_HTTP_TOKEN'
      }
      const model = new EngramFormModel(configForm, [
        enumField('daemonMode', DAEMON_MODES),
        portField,
        enumField('projectMode', PROJECT_MODES),
        textField('fixedProject'),
        projectMapField,
        enumField('contextInjection', INJECTION_MODES),
        contextMaxBytesField,
        autosyncField,
      ], {
        fields: { httpToken: { refOf: httpTokenRefOf } },
        api: secretApi,
      })
      void model.refreshSecrets()
      const formStore = model.bind(() => ({}))
      const FIELDS = ['daemonMode', 'port', 'httpToken', 'projectMode', 'fixedProject',
        'projectMap', 'contextInjection', 'contextMaxBytes', 'autosync']
      const computeSnapshot = () => {
        const snapshot = { ...model.shell() }
        for (const field of FIELDS) snapshot[field] = model.field(field)
        return snapshot
      }

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
              return formStore.subscribe(wake)
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
        // The effect setup must RETURN the disposer, not run it (the
        // chrome-cdp pattern: `() => () => { card.dispose() }`).
        ctx.effect(() => () => { card.dispose() }, 'dsh-engram: config model')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: ID, locale: NS, inject: card.face },
          EngramConfigCard,
        )), 'dsh-engram: bundle config card')
        ctx.effect(() => injectStyles(), 'dsh-engram: card styles')
      },
    }
  },
})
