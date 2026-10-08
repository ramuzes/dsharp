/**
 * dsh-airboard — browser half.
 *
 * One self-contained script in the client module system's factory format: it
 * calls window.__ModuleLoader__.load() with the package name and a factory
 * that lazily requires its modules (React and the baseline ui-primitives are
 * module-table identities, so nothing is bundled) and returns a cordis plugin
 * object.
 *
 * The plugin contributes one right-Sidebar page tab — kind `airboard` — that
 * lists the AirBoard projects and their resources (ADR / PRD / SPEC / PLAN /
 * ISSUE, grouped by kind, dotted by lifecycle state) and renders the selected
 * resource's markdown with the shared MarkdownText primitive. Data arrives
 * same-origin from the Host half's read-only proxy at /airboard, so no token
 * and no CORS are involved here. AirBoard has no push channel, so the tab
 * loads on open/navigation and refreshes through the tab's refresh command.
 */
window.__ModuleLoader__.load({
  id: 'dsh-airboard',
  factory(require) {
    const React = require('react')
    const {
      MarkdownText, IconRefreshOutlineRegular,
      SettingsForm, SettingsValueField, SettingsSecretField,
      SettingsFormModel, settingsTextField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Registration identity: the package name, the key the body registers under. */
    const ID = 'dsh-airboard'
    /** The right-Sidebar tab kind openTab() names. */
    const KIND = 'airboard'
    /** This plugin's copy namespace. */
    const NS = 'airboard'
    /** The Host half's same-origin proxy prefix. */
    const PROXY = '/airboard'
    /** AirBoard's five resource kinds, in display order. */
    const KIND_ORDER = ['ADR', 'PRD', 'SPEC', 'PLAN', 'ISSUE']
    // Note: AirBoard's list endpoint hides cancelled resources unless a status
    // filter asks for them, so the cancelled dot/locale below is normally
    // unreachable — it stays for the day the service (or a status filter UI)
    // lists them.

    const zh = {
      'type.title': 'AirBoard',
      'guide.title': 'AirBoard 看板',
      'guide.description': '浏览 AirBoard 项目的 ADR / PRD / SPEC / PLAN / ISSUE 文档',
      'project.select': '项目',
      refresh: '刷新',
      loading: '加载中…',
      'select.hint': '在左侧选择一个资源',
      'empty.projects': '没有可见项目：请检查服务地址与访问令牌',
      'empty.resources': '该项目暂无资源',
      'error.unauthorized': '令牌缺失或无效：在 Plugins 页面的 dsh-airboard 行配置访问令牌',
      'error.unreachable': '无法连接 AirBoard 服务',
      'error.generic': '读取失败',
      'status.draft': '草稿',
      'status.active': '生效',
      'status.done': '完成',
      'status.cancelled': '已取消',
      rev: '第 {rev} 版',
      'code.copy': '复制',
      'code.copied': '已复制',
      'code.title': '代码块',
      'code.wrap': '换行',
      'code.unwrap': '取消换行',
      'code.footnotes': '脚注',
      'config.summary': 'AirBoard 服务地址与访问令牌',
      'config.baseUrl': '服务地址',
      'config.baseUrlHint': 'AirBoard 服务的来源地址，例如 http://ab.antaresy.cc',
      'config.token': '访问令牌',
      'config.tokenHint': 'AirBoard 的 abt_… 访问令牌；保存后只保存在宿主进程，不会进入浏览器。留空表示不修改已保存的令牌',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.saveFailed': '保存未被接受，请重试',
      'config.readOnly': '当前连接不支持写入配置',
      'config.unavailable': '配置暂不可用',
      'config.overridden': '已覆盖',
      'config.reset': '重置',
      'config.invalid': '输入无效',
      'config.tokenSet': '已配置',
      'config.tokenUnset': '未配置',
    }
    const en = {
      'type.title': 'AirBoard',
      'guide.title': 'AirBoard board',
      'guide.description': 'Browse ADR / PRD / SPEC / PLAN / ISSUE documents of AirBoard projects',
      'project.select': 'Project',
      refresh: 'Refresh',
      loading: 'Loading…',
      'select.hint': 'Select a resource on the left',
      'empty.projects': 'No visible projects: check the service address and access token',
      'empty.resources': 'No resources in this project',
      'error.unauthorized': 'Token missing or invalid: configure the access token on the dsh-airboard row of the Plugins page',
      'error.unreachable': 'Cannot reach the AirBoard service',
      'error.generic': 'Read failed',
      'status.draft': 'Draft',
      'status.active': 'Active',
      'status.done': 'Done',
      'status.cancelled': 'Cancelled',
      rev: 'Revision {rev}',
      'code.copy': 'Copy',
      'code.copied': 'Copied',
      'code.title': 'Code block',
      'code.wrap': 'Wrap',
      'code.unwrap': 'Unwrap',
      'code.footnotes': 'Footnotes',
      'config.summary': 'AirBoard service address and access token',
      'config.baseUrl': 'Service address',
      'config.baseUrlHint': 'The AirBoard service origin, e.g. http://ab.antaresy.cc',
      'config.token': 'Access token',
      'config.tokenHint': 'The AirBoard abt_… token; after saving it stays in the Host process and never reaches the browser. Leave blank to keep the saved token',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.saveFailed': 'The save was not accepted, try again',
      'config.readOnly': 'This connection does not support writing configuration',
      'config.unavailable': 'Configuration is unavailable',
      'config.overridden': 'Overridden',
      'config.reset': 'Reset',
      'config.invalid': 'Invalid input',
      'config.tokenSet': 'Configured',
      'config.tokenUnset': 'Not set',
    }

    /**
     * GET one path under the proxy and return the parsed body.
     * @param {string} path - path under /airboard, query included.
     * @param {AbortSignal} signal - cancels with the loading effect.
     * @returns {Promise<unknown>} the JSON body on 2xx.
     * @throws {{status: number, code: string, message: string}} on transport or HTTP failure.
     */
    async function apiFetch(path, signal) {
      let response
      try {
        response = await fetch(`${PROXY}${path}`, { headers: { accept: 'application/json' }, signal })
      } catch (error) {
        throw { status: 0, code: 'NETWORK', message: error?.message ?? String(error) }
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        // Non-JSON body (or none): fall through with the HTTP status alone.
      }
      if (!response.ok) {
        const code = body?.error?.code ?? `HTTP_${response.status}`
        throw { status: response.status, code, message: body?.error?.message ?? response.statusText ?? code }
      }
      return body
    }

    /**
     * Group resources by kind in AirBoard's kind order, most recently updated
     * first within each group (AirBoard's `updated_at` is UTC
     * "YYYY-MM-DD HH:MM:SS", so plain string comparison orders it).
     * @param {ReadonlyArray<Record<string, unknown>>} resources - one project's list.
     * @returns {[string, Record<string, unknown>[]][]} non-empty groups.
     */
    function groupByKind(resources) {
      const groups = new Map(KIND_ORDER.map((kind) => [kind, []]))
      for (const resource of resources) {
        const bucket = groups.get(resource?.kind)
        if (bucket === undefined) continue
        bucket.push(resource)
      }
      for (const list of groups.values()) {
        list.sort((left, right) =>
          String(right.updated_at ?? right.created_at ?? '').localeCompare(String(left.updated_at ?? left.created_at ?? ''))
          || String(left.id).localeCompare(String(right.id)))
      }
      return [...groups.entries()].filter(([, list]) => list.length > 0)
    }

    /** Say why a load failed, in terms the reader can act on. */
    function errorLine(t, error) {
      if (error?.status === 401 || error?.code === 'UNAUTHORIZED') return t('error.unauthorized')
      if (error?.status === 0 || error?.code === 'NETWORK' || error?.code === 'AIRBOARD_UNREACHABLE') return t('error.unreachable')
      return `${t('error.generic')}${error?.message === undefined ? '' : `: ${error.message}`}`
    }

    /** Labels for the shared markdown renderer's copy-dependent chrome. */
    function markdownLabels(t) {
      return {
        code: {
          copyLabel: t('code.copy'),
          copiedLabel: t('code.copied'),
          toolbarLabels: { codeLabel: t('code.title'), wrapLabel: t('code.wrap'), unwrapLabel: t('code.unwrap') },
        },
        footnotes: t('code.footnotes'),
      }
    }

    /**
     * The tab body. Everything it keeps is local state on one keepMounted body;
     * nothing here outlives the tab, so no store is declared.
     * @param {any} props - the seat's composed props: `useTabInfo` and `t`.
     */
    function AirboardBody(props) {
      const { useTabInfo, t } = props
      const tab = useTabInfo?.().tab
      const navRevision = tab?.navigation?.revision ?? 0
      const [tick, setTick] = React.useState(0)
      const [projects, setProjects] = React.useState({ phase: 'loading' })
      const [projectKey, setProjectKey] = React.useState(null)
      const [resources, setResources] = React.useState({ phase: 'idle' })
      const [selectedId, setSelectedId] = React.useState(null)

      const refresh = React.useCallback(() => { setTick((count) => count + 1) }, [])

      React.useEffect(() => {
        const controller = new AbortController()
        let alive = true
        apiFetch('/api/projects', controller.signal)
          .then((list) => {
            if (!alive) return
            if (!Array.isArray(list) || list.length === 0) {
              setProjects({ phase: 'empty' })
              return
            }
            setProjects({ phase: 'ready', list })
            setProjectKey((current) => (list.some((project) => project.key === current) ? current : list[0].key))
          })
          .catch((error) => { if (alive) setProjects({ phase: 'failed', error }) })
        return () => { alive = false; controller.abort() }
      }, [tick, navRevision])

      React.useEffect(() => {
        if (projectKey === null) return
        const controller = new AbortController()
        let alive = true
        setResources({ phase: 'loading' })
        apiFetch(`/api/projects/${encodeURIComponent(projectKey)}/resources`, controller.signal)
          .then((list) => {
            if (!alive) return
            const items = Array.isArray(list) ? list : []
            setResources({ phase: 'ready', list: items })
            const firstDisplayed = groupByKind(items)[0]?.[1]?.[0]?.id ?? null
            setSelectedId((current) => (items.some((item) => item.id === current) ? current : firstDisplayed))
          })
          .catch((error) => { if (alive) setResources({ phase: 'failed', error }) })
        return () => { alive = false; controller.abort() }
      }, [projectKey, tick, navRevision])

      React.useEffect(() => {
        const actions = tab?.actions
        if (actions?.bindCommands === undefined) return undefined
        return actions.bindCommands({ refresh })
      }, [tab, refresh])

      const selected = resources.phase === 'ready' ? resources.list.find((item) => item.id === selectedId) : undefined
      const labels = markdownLabels(t)
      const onChangeProject = (event) => {
        setProjectKey(event.target.value)
        setSelectedId(null)
      }

      return h('div', { className: 'airboard-root', 'data-airboard': '' },
        h('div', { className: 'airboard-list' },
          h('div', { className: 'airboard-bar' },
            projects.phase === 'ready'
              ? h('select', {
                className: 'airboard-select',
                'data-airboard-project': projectKey ?? '',
                value: projectKey,
                'aria-label': t('project.select'),
                onChange: onChangeProject,
              }, projects.list.map((project) => h('option', { key: project.key, value: project.key }, `${project.key} — ${project.name}`)))
              : h('span', { className: 'airboard-bar-title' }, t('type.title')),
            h('button', {
              type: 'button',
              className: 'airboard-iconbtn',
              onClick: refresh,
              'aria-label': t('refresh'),
              title: t('refresh'),
            }, h(IconRefreshOutlineRegular, { className: 'airboard-icon' }))),
          h('div', { className: 'airboard-scroll' },
            projects.phase === 'loading' ? h('div', { className: 'airboard-note', 'data-airboard-note': 'loading' }, t('loading')) : null,
            projects.phase === 'empty' ? h('div', { className: 'airboard-note', 'data-airboard-note': 'empty' }, t('empty.projects')) : null,
            projects.phase === 'failed' ? h('div', { className: 'airboard-note airboard-error', 'data-airboard-error': projects.error?.code ?? '' }, errorLine(t, projects.error)) : null,
            projects.phase === 'ready' && resources.phase === 'loading' ? h('div', { className: 'airboard-note', 'data-airboard-note': 'loading' }, t('loading')) : null,
            projects.phase === 'ready' && resources.phase === 'failed' ? h('div', { className: 'airboard-note airboard-error', 'data-airboard-error': resources.error?.code ?? '' }, errorLine(t, resources.error)) : null,
            projects.phase === 'ready' && resources.phase === 'ready' && resources.list.length === 0
              ? h('div', { className: 'airboard-note', 'data-airboard-note': 'empty' }, t('empty.resources'))
              : null,
            resources.phase === 'ready' ? groupByKind(resources.list).map(([kind, list]) => h('div', { className: 'airboard-group', key: kind },
              h('div', { className: 'airboard-group-head', 'data-airboard-kind': kind },
                h('span', { className: 'airboard-kind' }, kind),
                h('span', { className: 'airboard-count' }, String(list.length))),
              list.map((resource) => h('button', {
                type: 'button',
                key: resource.id,
                className: 'airboard-row',
                'data-airboard-row': resource.id,
                'aria-current': resource.id === selectedId ? 'true' : undefined,
                title: `${resource.id} — ${resource.title ?? ''}`,
                onClick: () => { setSelectedId(resource.id) },
              },
              h('span', { className: 'airboard-dot', 'data-status': resource.status, 'aria-hidden': 'true' }),
              h('span', { className: 'airboard-id' }, resource.id),
              h('span', { className: 'airboard-title' }, resource.title ?? ''))))) : null)),
        h('div', { className: 'airboard-content', 'data-airboard-content': '' },
          selected === undefined
            ? h('div', { className: 'airboard-note' }, resources.phase === 'ready' ? t('select.hint') : null)
            : h('article', { className: 'airboard-doc' },
              h('header', { className: 'airboard-doc-head' },
                h('span', { className: 'airboard-doc-id', 'data-airboard-doc-id': selected.id }, selected.id),
                h('h1', { className: 'airboard-doc-title' }, selected.title ?? ''),
                h('span', { className: 'airboard-doc-meta', 'data-airboard-doc-meta': selected.status ?? '' },
                  `${t(`status.${selected.status}`)} · ${t('rev', { rev: selected.rev })}${selected.updated_at === undefined ? '' : ` · ${selected.updated_at}`}`)),
              h(MarkdownText, { text: selected.content_markdown ?? '', labels }))))
    }

    /** Scoped sheet, appended once per activation and removed with the plugin. */
    const CSS = `
[data-airboard] { display: flex; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); }
.airboard-list { width: 264px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--dsw-alias-border-l2); }
.airboard-bar { display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.airboard-bar-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.airboard-select { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; font-size: 12px; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); padding: 4px 6px; }
.airboard-iconbtn { display: inline-flex; flex: none; align-items: center; justify-content: center; padding: 4px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.airboard-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.airboard-icon { width: 16px; height: 16px; }
.airboard-scroll { flex: 1; min-height: 0; overflow: auto; padding: 6px 4px 16px; }
.airboard-group { margin: 0 0 6px; }
.airboard-group-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 8px 8px 2px; }
.airboard-kind { font-size: 11px; font-weight: 600; letter-spacing: 0.05em; color: var(--dsw-alias-label-secondary); }
.airboard-count { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.airboard-row { display: flex; width: 100%; align-items: center; gap: 6px; padding: 5px 8px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: inherit; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.airboard-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.airboard-row[aria-current='true'] { background: var(--dsw-alias-interactive-bg-active); }
.airboard-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.airboard-dot[data-status='draft'] { background: var(--dsw-alias-state-warn-primary); }
.airboard-dot[data-status='active'] { background: var(--dsw-alias-brand-primary); }
.airboard-dot[data-status='done'] { background: var(--dsw-alias-state-success-primary); }
.airboard-dot[data-status='cancelled'] { background: var(--dsw-alias-label-tertiary); }
.airboard-id { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.airboard-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.airboard-content { flex: 1; min-width: 0; overflow: auto; }
.airboard-note { padding: 16px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.airboard-error { color: var(--dsw-alias-state-warn-primary); }
.airboard-doc { max-width: 860px; margin: 0 auto; padding: 20px 24px 48px; }
.airboard-doc-head { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 10px; margin: 0 0 12px; padding: 0 0 10px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.airboard-doc-id { flex: none; font-size: 12px; font-weight: 600; letter-spacing: 0.03em; color: var(--dsw-alias-label-secondary); }
.airboard-doc-title { flex: 1; min-width: 200px; margin: 0; font-size: 18px; font-weight: 600; }
.airboard-doc-meta { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
`

    function injectStyles() {
      if (typeof document === 'undefined') return undefined
      const style = document.createElement('style')
      style.dataset.plugin = ID
      style.textContent = CSS
      document.head.append(style)
      return () => { style.remove() }
    }

    /**
     * The bundle's own config card on the Plugins page (the Web-Search-style
     * placement: click the bundle card and the form is right there, between
     * the description and the rows). Follows the shipped companion packages:
     * a SettingsFormModel stages edits over the shared ConfigForm, the token
     * is a write-through secret control whose literal never rides a response,
     * and the face injects the model's store as a selector hook plus its
     * staged-form actions.
     */

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
     * The config card: shared form chrome, the baseUrl value field, and the
     * token secret field. Everything flows through the model's injected face.
     * @param {any} props - `view`, `t`, the face's `useConfig` hook and the staged-form actions.
     */
    function AirboardConfigCard(props) {
      const { view, t, useConfig, edit, resetField, save, discard } = props
      const state = useConfig(snapshot => snapshot)
      if (view === 'summary') return t('config.summary')
      return h(SettingsForm, { labels: formLabels(t), state, onSave: save, onDiscard: discard },
        h(SettingsValueField, {
          id: 'airboard-config-base-url',
          label: t('config.baseUrl'),
          hint: t('config.baseUrlHint'),
          overriddenLabel: t('config.overridden'),
          resetLabel: t('config.reset'),
          invalidLabel: t('config.invalid'),
          disabled: !state.writable,
          ...state.baseUrl,
          onEdit: (text) => { edit('baseUrl', text) },
          onReset: () => { resetField('baseUrl') },
        }),
        h(SettingsSecretField, {
          id: 'airboard-config-token',
          label: t('config.token'),
          hint: t('config.tokenHint'),
          disabled: !state.writable,
          text: state.token.text,
          configured: state.tokenConfigured,
          stateLabel: state.tokenConfigured ? t('config.tokenSet') : t('config.tokenUnset'),
          onEdit: (text) => { edit('token', text) },
        }))
    }

    /**
     * Build the model, its store, and the describe-derived token presence.
     * @param {any} ctx - client context carrying configForms.
     * @returns {{store: object, face: () => object, dispose: () => void}} the registration inputs.
     */
    function buildConfigCard(ctx) {
      const configForm = ctx.configForms.get('airboard')
      const describe = ctx.configForms.describe?.()
      const model = new SettingsFormModel(
        configForm,
        [settingsTextField('baseUrl')],
        [{ field: 'token', write: (text) => configForm.set('token', text) }],
      )
      const tokenConfigured = () => {
        try {
          const namespaces = describe?.getSnapshot?.()?.view?.namespaces ?? []
          const served = namespaces.find((entry) => entry.ns === 'airboard')
          return served?.secrets?.some((secret) => secret.path?.[0] === 'token' && secret.set) ?? false
        } catch {
          return false
        }
      }
      const store = model.bind(() => ({
        ...model.shell(),
        baseUrl: model.field('baseUrl'),
        token: model.field('token'),
        tokenConfigured: tokenConfigured(),
      }))
      return {
        store,
        face: () => ({ hooks: { config: store }, ...model.actions() }),
        dispose: () => { model.dispose() },
      }
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const card = buildConfigCard(ctx)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-airboard: dictionaries')
        ctx.effect(() => () => { card.dispose() }, 'dsh-airboard: config model')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          priority: 'extension',
          keepMounted: true,
          title: () => t('type.title'),
          guide: [{
            id: 'airboard',
            order: 40,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
          }],
        }), 'dsh-airboard: airboard tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: ID, locale: NS },
          AirboardBody,
        )), 'dsh-airboard: airboard tab body')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: ID, locale: NS, inject: card.face },
          AirboardConfigCard,
        )), 'dsh-airboard: bundle config card')
        ctx.effect(() => injectStyles(), 'dsh-airboard: styles')
      },
    }
  },
})
