/**
 * dsh-agent-roster — browser half.
 *
 * One self-contained script in the client module system's factory format: it
 * calls window.__ModuleLoader__.load() with the package name and a factory
 * that lazily requires its modules (React and the baseline ui-primitives are
 * module-table identities, so nothing is bundled) and returns a cordis
 * plugin object (packages/airboard/client.js:18-27 shape).
 *
 * Task 6 scope — the happy path only: the locale dictionaries, the
 * `agentRoster` remote namespace mount (all six Host methods, Tasks 2–4),
 * one "+"-menu command, and the spawn modal (template list → member name →
 * model stub → first task → custom-role seam → confirm/cancel). Team-gating
 * states, the custom-role form, AI drafting, and real model selection are
 * Task 7; the settings card is Task 8.
 *
 * dsh interfaces consumed (verified in the checkout, AGENTS.md 2b):
 * - `commandUi` service 'commandUi' (packages/client/ui-commands/src/client/
 *   service.ts:95): `register({ name, label?(), description?(), icon?,
 *   available(session), ui })` with `ui: { kind: 'action', run(session) }`
 *   (contract.ts:96-109 CommandContribution, contract.ts:77-82 ActionSpec);
 *   `session` is the ClientSessionContext `{ sessionId }`
 *   (packages/client/ui-input-trigger/src/types.ts:29-31).
 * - `Modal` from '@deepseek-ai/dsh-client-ui-primitives'
 *   (packages/client/ui-primitives/src/index.ts:51): open/onClose/title/
 *   closeLabel/description/footer props, mask + Escape + aria-modal handled
 *   by the primitive (Modal.tsx ModalBaseProps) — kept intact.
 * - `conversation.input.overlay` list slot, scope session
 *   (packages/client/ui-conversation/src/client/contract/slots.ts:310) —
 *   the placement ui-message-feedback uses for its dialog
 *   (packages/client/ui-message-feedback/src/client/index.ts:115-131): the
 *   seat renders per session, `run(session)` flips that session's open state.
 * - `ctx.remote.$mount` with version-1 invocation descriptors
 *   (packages/typert/protocol/src/types.ts InvocationDescriptor) — the
 *   chrome-cdp client.js:385-399 pattern. The mounted namespace is read
 *   through the sanctioned optional lookup `ctx.get('remote.agentRoster')`;
 *   property access on a non-injected remote THROWS in cordis (the engram
 *   0.1.2 incident), so every read goes through the try/lookup helper.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-roster',
  factory(require) {
    const React = require('react')
    const { Modal, IconPlusOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Registration identity: the package name. */
    const ID = 'dsh-agent-roster'
    /** This plugin's copy namespace. */
    const NS = 'agent-roster'
    /** The overlay seat's id within conversation.input.overlay. */
    const SEAT_ID = 'roster-modal'

    const zh = {
      'command.label': '添加成员',
      'command.description': '从角色花名册挑选模板，创建一名团队成员',
      'modal.title': '添加团队成员',
      'modal.description': '选择角色模板，指定成员名称与首个任务',
      'modal.close': '关闭',
      'templates.title': '角色模板',
      'templates.loading': '正在加载模板…',
      'templates.unavailable': '花名册服务不可用：宿主插件未加载或版本过旧',
      'templates.error': '模板加载失败',
      'templates.empty': '还没有角色模板',
      'memberName.label': '成员名称',
      'memberName.placeholder': '留空使用模板名称',
      'memberName.hint': '成员在其会话树中的名字；留空时由模板名称派生',
      'model.label': '模型',
      'model.inherit': '继承当前会话模型',
      'task.label': '首个任务（可选）',
      'task.placeholder': '交给这位成员的第一个任务',
      'custom.toggle': '自定义角色（不用模板）',
      'action.confirm': '创建成员',
      'action.confirming': '创建中…',
      'action.cancel': '取消',
      'spawn.success': '成员 {name} 已创建',
      'spawn.failed': '创建失败',
    }
    const en = {
      'command.label': 'Add member',
      'command.description': 'Pick a roster template and spawn a team member',
      'modal.title': 'Add team member',
      'modal.description': 'Choose a role template, set the member name and first task',
      'modal.close': 'Close',
      'templates.title': 'Role templates',
      'templates.loading': 'Loading templates…',
      'templates.unavailable': 'Roster service unavailable: host plugin not loaded or too old',
      'templates.error': 'Template load failed',
      'templates.empty': 'No role templates yet',
      'memberName.label': 'Member name',
      'memberName.placeholder': 'Leave blank to use the template name',
      'memberName.hint': "The member's name in its session tree; blank derives from the template name",
      'model.label': 'Model',
      'model.inherit': 'Inherit the current session model',
      'task.label': 'First task (optional)',
      'task.placeholder': 'The first task to hand this member',
      'custom.toggle': 'Custom role (no template)',
      'action.confirm': 'Create member',
      'action.confirming': 'Creating…',
      'action.cancel': 'Cancel',
      'spawn.success': 'Member {name} created',
      'spawn.failed': 'Spawn failed',
    }

    /**
     * The plugin ctx of the most recent apply (chrome-cdp client.js:227
     * precedent). The mounted `agentRoster` namespace is a cordis service
     * named `remote.agentRoster`: property access on a non-injected service
     * THROWS in cordis ("cannot get property ... without inject" — the
     * engram 0.1.2 incident), so every read goes through the sanctioned
     * optional lookup `ctx.get(name)` — undefined until $mount lands.
     */
    let pluginCtx = null

    /** Optional roster namespace lookup; undefined until $mount lands. */
    const rosterNs = () => {
      try { return pluginCtx?.get?.('remote.agentRoster') } catch { return undefined }
    }

    /** Unwrap a RemoteResult ({ok, value}) or pass a raw object through. */
    function unwrap(result) {
      if (result !== null && typeof result === 'object' && 'ok' in result) return result.ok ? result.value : undefined
      return result
    }

    /**
     * The Host half's six remote methods (lib/roster-service.js — Tasks 2-4)
     * as version-1 invocation descriptors. Wire parameter names mirror the
     * Host method signatures: object-input methods take one `input`, delete
     * one `id` string, listTemplates none; every result is src-json. The
     * id/service/namespace/invocation shape follows the chrome-cdp
     * client.js:389-396 pattern over typert InvocationDescriptor.
     */
    const SRC_JSON = Object.freeze({ mode: 'src-json' })
    const jsonParameter = (name) => Object.freeze({ name, wire: name, source: 'json', codec: { mode: 'src-json' } })
    const ROSTER_METHODS = [
      { method: 'listTemplates', parameters: [] },
      { method: 'saveTemplate', parameters: [jsonParameter('input')] },
      { method: 'deleteTemplate', parameters: [jsonParameter('id')] },
      { method: 'spawnMember', parameters: [jsonParameter('input')] },
      { method: 'teamStatus', parameters: [jsonParameter('input')] },
      { method: 'draft', parameters: [jsonParameter('input')] },
    ]

    /**
     * Mount this plugin's `agentRoster` Remote namespace. Contained like the
     * chrome-cdp precedent: a failed mount must never surface as an
     * unhandled rejection in the page — the modal simply renders its
     * unavailable line while `remote.agentRoster` is missing.
     * @param {any} ctx - client context carrying remote.
     * @returns {() => void} disposer for ctx.effect.
     */
    function mountAgentRosterRemote(ctx) {
      const owned = ctx.remote.$mount({
        package: ID,
        descriptors: ROSTER_METHODS.map(({ method, parameters }) => ({
          id: `${ID}#agentRoster/${method}`,
          service: 'agentRoster',
          namespace: 'agentRoster',
          method,
          invocation: { kind: 'direct' },
          parameters,
          result: SRC_JSON,
        })),
      }).then((dispose) => dispose, () => {})
      return () => { void owned.then((dispose) => { dispose().catch(() => {}) }, () => {}) }
    }

    /**
     * Per-session modal openers: the overlay seat of one session registers
     * an opener from its mount effect, and the command's run(session) flips
     * exactly that session's modal (the ui-message-feedback surfaceFor
     * pattern, one dialog entry per session, without its heavier store —
     * the only shared state is the open bit).
     */
    const modalOpeners = new Map()

    /** Open the roster modal of one session; a no-op when its seat is not mounted. */
    const openRosterModal = (sessionId) => { modalOpeners.get(sessionId)?.() }

    /**
     * Render one error detail line from whatever error shape arrived: the
     * Host sends RemoteError with `roster/*` codes, but spawn also surfaces
     * the runtime's own typed errors (e.g. SubagentError INVALID /
     * DUPLICATE_AGENT_NAME) and the session's typed errors — so the line
     * shows code + message of ANY error, never assuming a roster prefix.
     * @param {unknown} error - the rejection value.
     * @returns {object | null} the detail span, or null for a shapeless error.
     */
    function errorDetail(error) {
      if (error === null || error === undefined) return null
      const code = typeof error.code === 'string' && error.code !== '' ? error.code : undefined
      const message = typeof error.message === 'string' && error.message !== '' ? error.message : undefined
      if (code === undefined && message === undefined) return null
      return h('span', { className: 'agent-roster-error-detail' }, [code, message].filter(Boolean).join(' — '))
    }

    /**
     * The spawn modal. Everything it keeps is local state; nothing outlives
     * the open modal. The body renders the briefed order — team-status
     * banner area (Task 7 fills it), template list, member name, model
     * selector (inherit-only stub in this task), first task, custom-role
     * toggle + form seam (Task 7) — over the shared Modal chrome.
     * @param {any} props - `sessionId`, `close()`, and the locale seat's `t`.
     */
    function RosterModal(props) {
      const { sessionId, close, t } = props
      const [templates, setTemplates] = React.useState({ phase: 'loading' })
      const [selectedId, setSelectedId] = React.useState(null)
      const [memberName, setMemberName] = React.useState('')
      const [task, setTask] = React.useState('')
      const [custom, setCustom] = React.useState(false)
      const [outcome, setOutcome] = React.useState(null)
      const [spawning, setSpawning] = React.useState(false)

      // Load the template list once per open. The namespace may be missing
      // (host plugin not loaded) — that degrades to the unavailable line,
      // never a crash.
      React.useEffect(() => {
        const ns = rosterNs()
        if (ns?.listTemplates === undefined) {
          setTemplates({ phase: 'unavailable' })
          return undefined
        }
        let alive = true
        Promise.resolve().then(() => ns.listTemplates())
          .then(
            (result) => { if (alive) setTemplates({ phase: 'ready', list: Array.isArray(unwrap(result)) ? unwrap(result) : [] }) },
            (error) => { if (alive) setTemplates({ phase: 'failed', error }) },
          )
        return () => { alive = false }
      }, [])

      const list = templates.phase === 'ready' ? templates.list : []
      // The first row is the default selection until the user picks another.
      const effectiveId = (selectedId !== null && list.some((tpl) => tpl.id === selectedId)
        ? selectedId
        : list[0]?.id) ?? null
      // Task 7 seam: a toggled custom role becomes the member source and the
      // template selection stops applying; until its form exists, confirm
      // cannot run (no valid member source would be sent).
      const canConfirm = effectiveId !== null && !custom

      /** Confirm: spawn the selected template and land the outcome banner. */
      const confirmSpawn = async () => {
        if (!canConfirm || spawning) return
        setSpawning(true)
        setOutcome(null)
        const ns = rosterNs()
        if (ns?.spawnMember === undefined) {
          setOutcome({ ok: false, error: { code: 'roster/unavailable', message: t('templates.unavailable') } })
          setSpawning(false)
          return
        }
        try {
          const result = await ns.spawnMember({
            sessionId,
            templateId: effectiveId,
            ...(memberName.trim() === '' ? {} : { memberName: memberName.trim() }),
            model: null,
            ...(task.trim() === '' ? {} : { task: task.trim() }),
          })
          setOutcome({ ok: true, name: unwrap(result)?.name })
        } catch (error) {
          setOutcome({ ok: false, error })
        } finally {
          setSpawning(false)
        }
      }

      const footer = h('div', { className: 'agent-roster-footer' },
        h('button', {
          type: 'button',
          className: 'agent-roster-button agent-roster-button-confirm',
          'data-agent-roster-confirm': '',
          disabled: !canConfirm || spawning,
          onClick: () => { void confirmSpawn() },
        }, spawning ? t('action.confirming') : t('action.confirm')),
        h('button', {
          type: 'button',
          className: 'agent-roster-button',
          'data-agent-roster-cancel': '',
          disabled: spawning,
          onClick: close,
        }, t('action.cancel')))

      return h(Modal, {
        open: true,
        onClose: close,
        title: t('modal.title'),
        closeLabel: t('modal.close'),
        description: t('modal.description'),
        footer,
        contentClassName: 'agent-roster-content',
      },
      h('div', { className: 'agent-roster-root', 'data-agent-roster': '' },
        h('section', { className: 'agent-roster-section', 'data-agent-roster-section': 'banner', 'aria-live': 'polite' },
          outcome === null ? null
            : outcome.ok
              ? h('div', { className: 'agent-roster-banner agent-roster-banner-success', 'data-agent-roster-banner': 'success' },
                t('spawn.success', { name: outcome.name ?? '' }))
              : h('div', {
                className: 'agent-roster-banner agent-roster-banner-error',
                'data-agent-roster-banner': 'error',
                'data-agent-roster-error': typeof outcome.error?.code === 'string' ? outcome.error.code : '',
                role: 'alert',
              },
              h('span', { className: 'agent-roster-error-label' }, t('spawn.failed')),
              errorDetail(outcome.error))),
        h('section', { className: 'agent-roster-section', 'data-agent-roster-section': 'templates' },
          h('div', { className: 'agent-roster-label' }, t('templates.title')),
          templates.phase === 'loading'
            ? h('div', { className: 'agent-roster-note', 'data-agent-roster-note': 'loading' }, t('templates.loading')) : null,
          templates.phase === 'unavailable'
            ? h('div', { className: 'agent-roster-note agent-roster-error', 'data-agent-roster-note': 'unavailable' }, t('templates.unavailable')) : null,
          templates.phase === 'failed'
            ? h('div', {
              className: 'agent-roster-note agent-roster-error',
              'data-agent-roster-note': 'error',
              'data-agent-roster-error': typeof templates.error?.code === 'string' ? templates.error.code : '',
            },
            h('span', { className: 'agent-roster-error-label' }, t('templates.error')),
            errorDetail(templates.error)) : null,
          templates.phase === 'ready' && list.length === 0
            ? h('div', { className: 'agent-roster-note', 'data-agent-roster-note': 'empty' }, t('templates.empty')) : null,
          templates.phase === 'ready'
            ? h('div', { className: 'agent-roster-templates', role: 'listbox', 'aria-label': t('templates.title') },
              list.map((tpl) => h('button', {
                type: 'button',
                key: tpl.id,
                role: 'option',
                className: 'agent-roster-template',
                'data-agent-roster-template': tpl.id,
                'aria-selected': tpl.id === effectiveId ? 'true' : 'false',
                onClick: () => { setSelectedId(tpl.id) },
              },
              h('span', { className: 'agent-roster-template-name' }, String(tpl.name ?? '')),
              tpl.description === undefined || tpl.description === null || tpl.description === ''
                ? null
                : h('span', { className: 'agent-roster-template-desc' }, String(tpl.description)))))
            : null),
        h('section', { className: 'agent-roster-section', 'data-agent-roster-section': 'member-name' },
          h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-member-name' }, t('memberName.label')),
          h('input', {
            id: 'agent-roster-member-name',
            type: 'text',
            className: 'agent-roster-input',
            'data-agent-roster-member-name': '',
            value: memberName,
            placeholder: t('memberName.placeholder'),
            'aria-describedby': 'agent-roster-member-name-hint',
            autoComplete: 'off',
            onChange: (event) => { setMemberName(event.target.value) },
          }),
          h('p', { id: 'agent-roster-member-name-hint', className: 'agent-roster-hint' }, t('memberName.hint'))),
        h('section', { className: 'agent-roster-section', 'data-agent-roster-section': 'model' },
          h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-model' }, t('model.label')),
          // Task 6 stub: inherit-only. Real model selection is Task 7; the
          // spawn payload always sends model: null (explicit inherit) until
          // then. No select primitive exists (chrome-cdp client.js:19-29),
          // so this is the house pattern: raw control, prefixed classes.
          h('select', {
            id: 'agent-roster-model',
            className: 'agent-roster-select',
            'data-agent-roster-model': 'inherit',
            disabled: true,
            value: '',
            onChange: () => {},
          }, h('option', { value: '' }, t('model.inherit')))),
        h('section', { className: 'agent-roster-section', 'data-agent-roster-section': 'task' },
          h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-task' }, t('task.label')),
          h('textarea', {
            id: 'agent-roster-task',
            className: 'agent-roster-input agent-roster-textarea',
            'data-agent-roster-task': '',
            rows: 3,
            value: task,
            placeholder: t('task.placeholder'),
            onChange: (event) => { setTask(event.target.value) },
          })),
        h('section', { className: 'agent-roster-section', 'data-agent-roster-section': 'custom' },
          h('label', { className: 'agent-roster-toggle' },
            h('input', {
              type: 'checkbox',
              'data-agent-roster-custom-toggle': '',
              checked: custom,
              onChange: (event) => { setCustom(event.target.checked) },
            }),
            h('span', {}, t('custom.toggle'))),
          // Task 7 seam: the custom-role form fields land here; until then
          // the empty container marks where they render.
          custom ? h('div', { className: 'agent-roster-custom-form', 'data-agent-roster-custom-form': '' }) : null)))
    }

    /**
     * The overlay seat: one entry per session in conversation.input.overlay.
     * It owns the open bit; the command's run(session) flips it through the
     * opener its mount effect registers (the ui-message-feedback dialog
     * placement pattern — the Modal portals from here, the overlay supplies
     * the per-session scope).
     * @param {any} props - the seat's composed props: the inject face's
     *   `sessionId` and the locale seat's `t`.
     */
    function RosterModalSeat(props) {
      const { sessionId, t } = props
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        const opener = () => { setOpen(true) }
        modalOpeners.set(sessionId, opener)
        return () => { if (modalOpeners.get(sessionId) === opener) modalOpeners.delete(sessionId) }
      }, [sessionId])
      return open ? h(RosterModal, { sessionId, close: () => { setOpen(false) }, t }) : null
    }

    /** Scoped sheet, appended once per activation and removed with the plugin. */
    const STYLES = `
[data-agent-roster] { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
.agent-roster-content { max-height: min(520px, 70vh); overflow: auto; }
.agent-roster-section { display: flex; flex-direction: column; gap: 6px; }
.agent-roster-label { font-size: 11px; font-weight: 600; letter-spacing: 0.05em; color: var(--dsw-alias-label-secondary); }
.agent-roster-hint { margin: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.agent-roster-note { padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); }
.agent-roster-error { color: var(--dsw-alias-state-warn-primary); }
.agent-roster-error-detail { font-family: var(--dsw-alias-font-mono, monospace); font-size: 11px; }
.agent-roster-banner { padding: 8px 10px; font-size: 12px; border-radius: var(--dsw-radius-sm); }
.agent-roster-banner-success { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-banner-error { display: flex; flex-direction: column; gap: 2px; color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-error-label { font-weight: 600; }
.agent-roster-templates { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto; }
.agent-roster-template { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; border: 1px solid transparent; border-radius: var(--dsw-radius-sm); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.agent-roster-template:hover { background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-template[aria-selected='true'] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-active); }
.agent-roster-template-name { font-size: 13px; font-weight: 600; }
.agent-roster-template-desc { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.agent-roster-input { box-sizing: border-box; width: 100%; font: inherit; font-size: 13px; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); padding: 6px 8px; }
.agent-roster-textarea { resize: vertical; min-height: 56px; }
.agent-roster-select { box-sizing: border-box; width: 100%; font: inherit; font-size: 12px; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); padding: 5px 6px; }
.agent-roster-select:disabled { opacity: 0.6; }
.agent-roster-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.agent-roster-custom-form { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); }
.agent-roster-footer { display: flex; justify-content: flex-end; gap: 8px; }
.agent-roster-button { padding: 6px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.agent-roster-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-button:disabled { opacity: 0.5; cursor: default; }
.agent-roster-button-confirm { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
`

    function injectStyles() {
      if (typeof document === 'undefined') return undefined
      const style = document.createElement('style')
      style.dataset.plugin = ID
      style.textContent = STYLES
      document.head.append(style)
      return () => { style.remove() }
    }

    return {
      inject: ['commandUi', 'locale', 'slots', 'remote'],
      apply(ctx) {
        pluginCtx = ctx
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agent-roster: dictionaries')
        ctx.effect(() => mountAgentRosterRemote(ctx), 'dsh-agent-roster: roster remote namespace')
        ctx.effect(() => ctx.commandUi.register({
          name: 'add-agent-member',
          label: () => t('command.label'),
          description: () => t('command.description'),
          icon: IconPlusOutlineRegular,
          available: () => true,
          ui: { kind: 'action', run: (session) => { openRosterModal(session.sessionId) } },
        }), 'dsh-agent-roster: + command')
        ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: SEAT_ID,
            order: 40,
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          },
          RosterModalSeat,
        )), 'dsh-agent-roster: spawn modal seat')
        ctx.effect(() => injectStyles(), 'dsh-agent-roster: styles')
      },
    }
  },
})
