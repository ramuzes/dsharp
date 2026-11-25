/**
 * dsh-agent-roster — browser half.
 *
 * One self-contained script in the client module system's factory format: it
 * calls window.__ModuleLoader__.load() with the package name and a factory
 * that lazily requires its modules (React and the baseline ui-primitives are
 * module-table identities, so nothing is bundled) and returns a cordis
 * plugin object (packages/airboard/client.js:18-27 shape).
 *
* ADR-0012 shape: the "+"-menu modal collects a template, an optional
 * per-spawn model and an optional first task, stages that request through the
 * `agentRoster` remote and runs `/roster` on the session. The command is the
 * host's act-without-a-model-message path (two log-only lifecycle events, the
 * `/compact` precedent): no user bubble, no lead turn. The member itself is
 * created host-side by the command handler through the subagent runtime; the
 * lead can still create members itself with the `roster_spawn` tool.
 * The Settings section is the roster manager (list/add/edit/delete and the
 * per-template default model); the templates are the whole configuration —
 * there is no drafting surface and no teamwork gating.
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
 *   by the primitive (Modal.tsx ModalBaseProps) — kept intact; this task
 *   only gates the `onClose` it hands over (while the instruction is being injected).
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
 * - `remote.session.modelCatalog()` — host `@Remote('modelCatalog')`
 *   (packages/api/session-controller/src/index.ts:317-318), no arguments,
 *   RemoteResult over ModelCatalog `{ default, routableProviders, groups:
 *   [{ id, name, models: [{ id, name, reasoning?: { efforts: [{ id, name }],
 *   defaultEffort } }] }], failures }` (types.ts:103-135). Consumed through
 *   the optional `remote.session` face exactly as the Web GUI's own selector
 *   does (packages/client/ui-model-selection/src/client/catalog.ts:56).
 * - `remote.agentTeams.setEnabled(sessionId, enabled)` — the generated face's
 *   ONLY client method (usage precedent packages/client/ui-agent-team/src/
 *   client/mount.ts:41-45; the face answers RemoteResult, value undefined).
 * - `remote.pluginInventory.list()` — RemoteResult over
 *   `{ entries: [{ entryId, moduleName, enabled, ... }], ... }`
 *   (packages/host/plugin-inventory/src/index.ts:68-80).
 * - `remote.pluginManager.setPluginEnabled(entryId, enabled)` — RemoteResult
 *   over ChangeResult (packages/boot/plugin-manager/src/index.ts:935-961;
 *   client usage precedent packages/client/ui-plugin-manager/src/client/
 *   manager-store.ts:870).
 *   These four faces are NOT in the inject list (an injected dependency
 *   would crash the plugin on hosts without them); each is resolved per use
 *   through the same try-guarded ctx.get() optional lookup as the roster
 *   namespace, and absence degrades the UI instead of throwing.
 * - `settings.section` list slot, scope root — one Settings page entry
 *   (`{ id, order, label }` options; ui-settings contract/slots.ts:17-27,
 *   registration precedent ui-settings-models client/index.ts:143-152).
 *   With no `plugins.bundle.config` card of our own, the Plugins page
 *   shows this section's entry on the bundle row (settings shell
 *   contract). The section body is the roster manager: templates are the
 *   only configuration the plugin has.
 * - `sessions` client service (inject list) — the object layer the `/roster`
 *   command line is admitted through: `ctx.sessions.using(sessionId, {
 *   source }, ref => ref.binding.session.command('/roster <name>'))`
 *   (api/session-controller/src/client/sessions/session.ts `command()`:
 *   "the full command line, leading slash included… the host executor durably
 *   logs the lifecycle; outcomes render as flow nodes, never as a response
 *   echo"). Precedent for reaching a session object: ui-commands/src/client/
 *   service.ts `sessions.using(…)` (ADR-0012).
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-roster',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { z } = require('zod')
    const {
      Modal, IconPlusOutlineRegular, MenuSurface, MenuGroup,
      IconChevronDownOutlineRegular, IconCheckOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Registration identity: the package name. */
    const ID = 'dsh-agent-roster'
    /** This plugin's copy namespace. */
    const NS = 'agent-roster'
    /** The overlay seat's id within conversation.input.overlay. */
    const SEAT_ID = 'roster-modal'

    const zh = {
      'command.label': '添加成员',
      'command.description': '从角色花名册挑选模板，让 agent 创建团队成员',
      'modal.title': '添加团队成员',
      'modal.close': '关闭',
      'templates.title': '角色模板',
      'templates.loading': '正在加载模板…',
      'templates.unavailable': '花名册服务不可用：宿主插件未加载或版本过旧',
      'templates.error': '模板加载失败',
      'templates.empty': '还没有角色模板',
      'templates.none': '还没有模板。请先到 设置 > Agent roster 新建一个角色模板。',
      'spawn.model.label': '成员模型',
      'spawn.model.inherit': '继承当前会话模型',
      'task.label': '本次任务（可选）',
      'task.placeholder': '交给这位成员的本次任务，例如：审查 payments 模块',
      'command.action': '创建成员',
      'command.sending': '创建中…',
      'command.sent': '已提交创建成员「{name}」的请求，结果见会话中的命令记录',
      'command.failed': '创建失败',
      'command.unmatched': '宿主没有 /roster 命令：请确认 Agent roster 插件已启用且为最新版本',
      'command.unavailable': '会话命令通道不可用，无法创建成员',
      'model.effort.label': '推理力度（可选）',
      'model.effort.default': '模型默认',
      'custom.name.label': '角色名称',
      'custom.name.placeholder': '例如：Market Scout',
      'custom.description.label': '角色描述（可选）',
      'custom.description.placeholder': '一句话说明这个角色负责什么',
      'custom.prompt.label': '角色提示词',
      'custom.prompt.placeholder': '写给这位成员的完整常驻指令（职责边界与主要目标）',
      'card.title': '角色花名册',
      'card.add': '新建角色模板',
      'card.edit': '编辑',
      'card.delete': '删除',
      'card.delete.confirm': '再次点击以确认删除',
      'card.deleting': '删除中…',
      'card.save': '保存',
      'card.saving': '保存中…',
      'card.cancel': '取消',
      'card.incomplete': '填写角色名称与提示词后才能保存',
      'card.saveFailed': '保存失败',
      'card.deleteFailed': '删除失败',
      'card.defaultModel': '默认模型',
      'card.model.none': '不设默认模型',
      'card.model.chip': '{provider} / {model}',
      'card.model.chip.effort': '{provider} / {model} · {effort}',
      'card.updatedAt': '更新于 {time}',
      'settings.nav': '角色花名册',
    }
    const en = {
      'command.label': 'Add member',
      'command.description': 'Pick a roster template and let the agent create the member',
      'modal.title': 'Add team member',
      'modal.close': 'Close',
      'templates.title': 'Role templates',
      'templates.loading': 'Loading templates…',
      'templates.unavailable': 'Roster service unavailable: host plugin not loaded or too old',
      'templates.error': 'Template load failed',
      'templates.empty': 'No role templates yet',
      'templates.none': 'No templates yet. Create one in Settings > Agent roster first.',
      'spawn.model.label': 'Member model',
      'spawn.model.inherit': 'Inherit the session model',
      'task.label': 'Task for this member (optional)',
      'task.placeholder': 'This session\'s task for the member, e.g. review the payments module',
      'command.action': 'Create member',
      'command.sending': 'Creating…',
      'command.sent': 'Requested member «{name}»; the outcome appears in the command record of this conversation',
      'command.failed': 'Creation failed',
      'command.unmatched': 'The host has no /roster command: make sure the Agent roster plugin is enabled and up to date',
      'command.unavailable': 'The session command channel is unavailable; cannot create the member',
      'model.effort.label': 'Reasoning effort (optional)',
      'model.effort.default': 'Model default',
      'custom.name.label': 'Role name',
      'custom.name.placeholder': 'e.g. Market Scout',
      'custom.description.label': 'Role description (optional)',
      'custom.description.placeholder': 'One line on what this role is for',
      'custom.prompt.label': 'Role prompt',
      'custom.prompt.placeholder': 'The standing instruction for this member: responsibility boundary and main goal',
      'card.title': 'Role roster',
      'card.add': 'New role template',
      'card.edit': 'Edit',
      'card.delete': 'Delete',
      'card.delete.confirm': 'Click again to confirm deletion',
      'card.deleting': 'Deleting…',
      'card.save': 'Save',
      'card.saving': 'Saving…',
      'card.cancel': 'Cancel',
      'card.incomplete': 'Fill in the role name and prompt to save',
      'card.saveFailed': 'Save failed',
      'card.deleteFailed': 'Delete failed',
      'card.defaultModel': 'Default model',
      'card.model.none': 'No default model',
      'card.model.chip': '{provider} / {model}',
      'card.model.chip.effort': '{provider} / {model} \u00b7 {effort}',
      'card.updatedAt': 'Updated {time}',
      'settings.nav': 'Agent roster',
    }

    /**
     * The plugin ctx of the most recent apply (chrome-cdp client.js:227
     * precedent). Remote namespaces are cordis services named
     * `remote.<namespace>`: property access on a non-injected service
     * THROWS in cordis ("cannot get property ... without inject" — the
     * engram 0.1.2 incident), so every read goes through the sanctioned
     * optional lookup `ctx.get(name)` (undefined until the face mounts).
     */
    let pluginCtx = null

    /**
     * Optional lookup of one client service by name — `remote.agentRoster`
     * (our mounted namespace), `remote.session` (the model catalog), and
     * `sessions` (the session object layer the member instruction is injected
     * through). Try-guarded ctx.get: undefined when the service is absent on
     * this host, so every consumer degrades instead of throwing.
     */
    const optService = (name) => {
      try { return pluginCtx?.get?.(name) } catch { return undefined }
    }

    /** Optional roster namespace lookup; undefined until $mount lands. */
    const rosterNs = () => optService('remote.agentRoster')

    /**
     * Await one RemoteResult-shaped call and yield its value: `{ok: true}`
     * unwraps, `{ok: false}` rejects with the carried error, and anything
     * else (a raw value, or a rejection thrown by the transport) passes
     * through. The generated client faces answer `{ok, value|error}`
     * (ui-agent-team tests/browser-plugin.client.spec.ts:100-106) while a
     * thrown RemoteError is the mounted-namespace failure mode — both
     * normalize here so callers have one catch path.
     * @param {Promise<unknown>} promise - the remote call.
     * @returns {Promise<unknown>} the call's value.
     */
    function settle(promise) {
      return Promise.resolve(promise).then((result) => {
        if (result !== null && typeof result === 'object' && 'ok' in result) {
          if (result.ok) return result.value
          throw result.error ?? new Error('remote call failed')
        }
        return result
      })
    }

    /**
     * The Host half's four remote methods (lib/roster-service.js) as
     * version-1 invocation descriptors. Wire parameter names mirror the Host
     * method signatures: object-input methods (saveTemplate, stageSpawn) take
     * one `input`, delete one `id` string, listTemplates none; every result
     * is src-json. The
     * id/service/namespace/invocation shape follows the chrome-cdp
     * client.js:389-396 pattern over typert InvocationDescriptor.
     */
    const SRC_JSON = Object.freeze({ mode: 'src-json' })
    // Parameter codecs must be STRICT, not src-json: the gateway's mount
    // validation rejects any parameter whose codec mode is not 'strict'
    // (dsh packages/api/gateway/src/client/index.ts validateContribution
    // :283-330 → requireStrictInputs :299-303 → requireStrictCodec :341-346;
    // 'src-json' is legal for RESULTS only). After validation the invoke path
    // reads only `parameter.wire` (prepareInvocation :505-546), so the
    // minimal legal TypertCodec is mode 'strict' + typeSymbol + create.
    // `create` comes from baseline zod (browser module table, hmr precedent:
    // generated remote artifacts `import { z } from 'zod'`).
    const STRICT_JSON_CODEC = Object.freeze({
      mode: 'strict',
      typeSymbol: '@local/dsh-agent-roster/json-value',
      create: () => z.unknown(),
    })
    const jsonParameter = (name) => Object.freeze({ name, wire: name, source: 'json', codec: STRICT_JSON_CODEC })
    const ROSTER_METHODS = [
      { method: 'listTemplates', parameters: [] },
      { method: 'saveTemplate', parameters: [jsonParameter('input')] },
      { method: 'deleteTemplate', parameters: [jsonParameter('id')] },
      { method: 'stageSpawn', parameters: [jsonParameter('input')] },
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

    // -------------------------------------------------------------------------
    // Shared building blocks: the Settings roster manager's add/edit forms and
    // the modal's instruction preview render the same role fields and the same
    // ModelRef selector.
    // -------------------------------------------------------------------------

    /**
     * The Host model catalog as flat selector rows, loaded once per consumer
     * (modal open / card form mount). The session face may be absent or fail
     * (older host, provider outage): rows degrade to [] — callers offer the
     * default entry only and never block on the catalog.
     * @returns {{ rows: Array<object> }} the flat rows (`key` is the JSON
     *   [provider, model] pair).
     */
    function useModelRows() {
      const [catalog, setCatalog] = React.useState({ phase: 'loading' })
      React.useEffect(() => {
        const face = optService('remote.session')
        if (face?.modelCatalog === undefined) {
          setCatalog({ phase: 'degraded' })
          return undefined
        }
        let alive = true
        settle(face.modelCatalog()).then(
          (value) => { if (alive) setCatalog(Array.isArray(value?.groups) ? { phase: 'ready', value } : { phase: 'degraded' }) },
          () => { if (alive) setCatalog({ phase: 'degraded' }) },
        )
        return () => { alive = false }
      }, [])
      const rows = React.useMemo(() => {
        if (catalog.phase !== 'ready') return []
        const flat = []
        for (const group of catalog.value.groups ?? []) {
          if (group === null || typeof group !== 'object' || typeof group.id !== 'string') continue
          for (const model of group.models ?? []) {
            if (typeof model?.id !== 'string') continue
            flat.push({
              key: JSON.stringify([group.id, model.id]),
              provider: group.id,
              model: model.id,
              name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
              groupName: typeof group.name === 'string' && group.name !== '' ? group.name : group.id,
              efforts: Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : [],
            })
          }
        }
        return flat
      }, [catalog])
      return { rows }
    }

    /** Map one flat-row list by row key (JSON [provider, model]). */
    const rowsByKey = (rows) => new Map(rows.map((row) => [row.key, row]))

    /**
     * Provider-grouped DATA groups over a flat-row list — the ModelMenu
     * `groups` shape ({name, rows}), replacing the old <optgroup> elements
     * when the selects became host-picker menus.
     */
    function catalogGroups(rows) {
      const groups = []
      for (const row of rows) {
        let group = groups.find((entry) => entry.name === row.groupName)
        if (group === undefined) { group = { name: row.groupName, rows: [] }; groups.push(group) }
        group.rows.push(row)
      }
      return groups
    }

    /**
     * The model reference of one catalog row: an explicit choice sends
     * {provider, model[, reasoningEffort]}; the caller's default (no row)
     * sends null — the modal's spawn then omits agentOptions so the child
     * inherits the parent's route (lib/spawn.js model precedence), and the
     * card stores "no default model".
     * @param {object | undefined} row - the chosen flat row, if any.
     * @param {string} effort - the chosen reasoning effort ('' = none).
     */
    const modelRefOf = (row, effort) => row === undefined ? null : {
      provider: row.provider,
      model: row.model,
      ...(effort !== '' ? { reasoningEffort: effort } : {}),
    }

    /** Per-instance CSS anchor-name sequence for ModelMenu (host ModelSelect
     * uses useId for the same purpose; the fake React has none). */
    let rosterMenuSeq = 0

    /**
     * ModelMenu: the host model-picker dropdown pattern, copied and renamed
     * under this plugin's prefix (practices.md copy rule). Sources:
     * - trigger/menu geometry, anchoring, and rows — dsh
     *   packages/client/ui-model-selection/src/client/ModelSelect.tsx and
     *   ModelSelect.module.css (CSS anchor positioning: trigger declares
     *   anchor-name via an inline custom property, the fixed body portal
     *   declares position-anchor; right: anchor(right); bottom:
     *   calc(anchor(top) + 8px)).
     * - surface material and sticky group headings — ui-primitives
     *   MenuSurface.tsx / MenuGroup.tsx (used as real components from the
     *   browser module table, exactly as the host imports them).
     * Behavior kept from the host: outside pointerdown closes, Escape
     * closes, ArrowUp/Down move focus between rows, the selected row keeps
     * a trailing check (never a fill), and rows are real buttons with
     * menuitemradio semantics. Search and drill-in panes stay out — our
     * catalogs are small.
     * @param {any} props - `marker` (trigger data attribute), `markerValue`
     *   (its value for the current choice), `value` (current key; '' = the
     *   `noneLabel` entry), `noneLabel`, `groups` (catalogOptgroups shape;
     *   null = plain ungrouped rows), `rows` (ungrouped flat options),
     *   `onPick(key)`, `disabled`, `ariaLabel`, `triggerClass`.
     */
    function ModelMenu(props) {
      const {
        marker, markerValue, value, noneLabel, groups, rows, onPick, disabled, ariaLabel, triggerClass,
      } = props
      const [open, setOpen] = React.useState(false)
      const [anchorVar] = React.useState(() => `--dsh-roster-menu-${(rosterMenuSeq += 1)}`)
      const rootRef = React.useRef(null)
      // The menu SURFACE lives in a body portal, OUTSIDE rootRef — the host
      // ModelSelect checks both refs in closeOutside (ModelSelect.tsx:173-188)
      // and so must we: checking only the root closed the menu on the row's
      // own pointerdown, killing the click before it could select (the
      // 2026-11-23 "click does nothing" incident).
      const menuRef = React.useRef(null)
      const openRef = React.useRef(false)
      openRef.current = open

      // Outside pointerdown closes (host closeOutside pattern: pointerdown
      // covers WebKit taps; the portal subtree counts as inside).
      React.useEffect(() => {
        // Environments without a DOM (the test harness renders without one)
        // simply skip the outside-close wiring; the host page always has it.
        if (!open || typeof document === 'undefined') return undefined
        const closeOutside = (event) => {
          const target = event?.target
          if (typeof target !== 'object' || target === null) return
          // The portaled card is outside the trigger subtree; check both.
          if (rootRef.current?.contains?.(target) === true) return
          if (menuRef.current?.contains?.(target) === true) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', closeOutside)
        document.addEventListener('mousedown', closeOutside)
        return () => {
          document.removeEventListener('pointerdown', closeOutside)
          document.removeEventListener('mousedown', closeOutside)
        }
      }, [open])

      const flatRows = groups !== null && groups !== undefined
        ? groups.flatMap((group) => group.rows)
        : (rows ?? [])
      // Rows carry either `label` (mapped callers) or `name` (flat catalog
      // rows from catalogGroups) — normalize once; the 2026-11-23 empty-row
      // incident came from reading only `label`.
      const labelOf = (row) => row?.label ?? row?.name ?? ''
      const currentLabel = value === ''
        ? noneLabel
        : (labelOf(flatRows.find((row) => row.key === value)) || noneLabel)

      /** Escape closes; arrows move focus between rows (host moveFocus). */
      const onKeyDown = (event) => {
        if (event.key === 'Escape' && openRef.current) {
          event.preventDefault()
          setOpen(false)
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const items = rootRef.current === null ? [] : Array.from(
          rootRef.current.querySelectorAll('button[role="menuitemradio"]:not([disabled])'),
        )
        if (items.length === 0) return
        event.preventDefault()
        const active = items.findIndex((item) => item === document.activeElement)
        const next = active === -1
          ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
          : (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus?.()
      }

      const rowButton = (row, selected) => h('button', {
        key: row.key,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': selected ? 'true' : 'false',
        'data-agent-roster-menu-option': row.key,
        className: 'agent-roster-menu-option',
        disabled,
        onClick: () => { setOpen(false); onPick(row.key) },
      },
        h('span', { className: 'agent-roster-menu-option-copy' },
          h('span', { className: 'agent-roster-menu-option-name' }, labelOf(row))),
        h('span', { className: 'agent-roster-menu-check' },
          selected ? h(IconCheckOutlineRegular, null) : null))

      return h('div', {
        ref: rootRef,
        className: 'agent-roster-menu-root',
        'data-agent-roster-menu': open ? 'open' : 'closed',
        onKeyDown,
      },
        h('button', {
          type: 'button',
          className: `agent-roster-menu-trigger ${triggerClass ?? ''}`,
          style: { '--dsh-roster-anchor': anchorVar },
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': ariaLabel,
          [marker]: markerValue,
          'data-agent-roster-menu-value': value,
          disabled,
          onClick: () => { setOpen(!open) },
        },
          h('span', { className: 'agent-roster-menu-trigger-label' }, currentLabel),
          h(IconChevronDownOutlineRegular, {
            className: `agent-roster-menu-chevron ${open ? 'agent-roster-menu-chevron-open' : ''}`,
          })),
        // The body portal escapes overflow ancestors (clipping Modal and
        // docked composer) exactly like the host ModelSelect; environments
        // without a DOM (the node test renderer) render the menu inline
        // instead — same tree, no portal container.
        open
          ? (typeof document === 'undefined'
              ? h('div', { className: 'agent-roster-menu-inline' },
                  h('div', { className: 'agent-roster-menu-groups' },
                    h('div', { key: 'none', role: 'group' },
                      rowButton({ key: '', label: noneLabel }, value === '')),
                    groups !== null && groups !== undefined
                      ? groups.map((group) => h(MenuGroup, { key: group.name, label: group.name },
                          group.rows.map((row) => rowButton(row, row.key === value))))
                      : (rows ?? []).map((row) => rowButton(row, row.key === value))))
              : createPortal(
                h(MenuSurface, {
                  ref: menuRef,
                  className: 'agent-roster-menu-surface',
                  role: 'menu',
                  style: { '--dsh-roster-anchor': anchorVar },
                },
                  h('div', { className: 'agent-roster-menu-groups' },
                    h('div', { key: 'none', role: 'group' },
                      rowButton({ key: '', label: noneLabel }, value === '')),
                    groups !== null && groups !== undefined
                      ? groups.map((group) => h(MenuGroup, { key: group.name, label: group.name },
                          group.rows.map((row) => rowButton(row, row.key === value))))
                      : (rows ?? []).map((row) => rowButton(row, row.key === value)))),
                document.body,
              ))
          : null)
    }

    /**
     * The shared ModelRef editor: a labeled provider-grouped select over the
     * flat catalog rows with a labeled default entry whose copy is the
     * caller's (spawn "inherit", card "no default"), plus the optional
     * reasoning-effort select beside an explicit choice that advertises
     * efforts. Controlled and hook-free: choice/effort state and the
     * resulting ModelRef stay with the caller.
     * @param {any} props - `section` (optional data-agent-roster-section
     *   value), `id`, `marker` (the select's data attribute), `noneMarker`
     *   (marker value for the default entry), `label`, `defaultLabel`,
     *   `effortLabel`, `effortDefaultLabel`, `rows`, `byKey`, `choice`,
     *   `onChoice`, `effort`, `onEffort` (omit for no effort input),
     *   `disabled`.
     */
    function ModelRefEditor(props) {
      const {
        section, id, marker, noneMarker, label, defaultLabel, effortLabel, effortDefaultLabel,
        rows, byKey, choice, onChoice, effort, onEffort, disabled,
      } = props
      const chosen = choice === '' ? undefined : byKey.get(choice)
      return h('section', {
        className: 'agent-roster-section',
        ...(section === undefined ? {} : { 'data-agent-roster-section': section }),
      },
        h('label', { className: 'agent-roster-label', htmlFor: id }, label),
        h(ModelMenu, {
          marker,
          markerValue: choice === '' ? noneMarker : choice,
          value: choice,
          noneLabel: defaultLabel,
          groups: catalogGroups(rows),
          onPick: onChoice,
          disabled,
          ariaLabel: label,
          triggerClass: 'agent-roster-menu-trigger-form',
        }),
        // Always mounted, hidden when no explicit model advertises
        // efforts: the client test harness keys hooks by a global render
        // cursor, so a conditionally mounted hook-bearing component would
        // shift every later slot (real React keys them per fiber, but the
        // DOM stays stable under this pattern too).
        onEffort !== undefined
          ? (() => {
            const advertised = (chosen?.efforts ?? []).map((item) => ({ key: String(item?.id ?? ''), label: String(item?.name ?? item?.id ?? '') }))
            // A stored effort the catalog no longer advertises stays
            // selectable, so the trigger never reads "model default" while
            // that effort is still the value being sent.
            const effortRows = effort !== '' && !advertised.some((row) => row.key === effort)
              ? [...advertised, { key: effort, label: effort }]
              : advertised
            const visible = effortRows.length > 0
            return h('div', {
              className: 'agent-roster-effort',
              hidden: !visible,
              'data-agent-roster-effort-area': visible ? 'on' : 'off',
            },
              h('label', { className: 'agent-roster-label', htmlFor: `${id}-effort` }, effortLabel),
              h(ModelMenu, {
                marker: 'data-agent-roster-effort',
                markerValue: effort,
                value: effort,
                noneLabel: effortDefaultLabel,
                groups: null,
                rows: effortRows,
                onPick: onEffort,
                disabled: disabled || !visible,
                ariaLabel: effortLabel,
                triggerClass: 'agent-roster-menu-trigger-form',
              }))
          })()
          : null)
    }

    /**
     * The shared role fields — name, description, prompt — of the Settings
     * roster manager's template add/edit forms. Controlled and hook-free;
     * `idPrefix` namespaces the
     * label/field ids so the two surfaces never collide in one document.
     * @param {any} props - `t`, `idPrefix`, `name`, `description`, `prompt`,
     *   `onName`, `onDescription`, `onPrompt`.
     */
    function RoleFields(props) {
      const { t, idPrefix, name, description, prompt, onName, onDescription, onPrompt } = props
      return h('div', { className: 'agent-roster-role-fields' },
        h('label', { className: 'agent-roster-label', htmlFor: `${idPrefix}-role-name` }, t('custom.name.label')),
        h('input', {
          id: `${idPrefix}-role-name`,
          type: 'text',
          className: 'agent-roster-input',
          'data-agent-roster-role-name': '',
          value: name,
          placeholder: t('custom.name.placeholder'),
          autoComplete: 'off',
          onChange: (event) => { onName(event.target.value) },
        }),
        h('label', { className: 'agent-roster-label', htmlFor: `${idPrefix}-role-description` }, t('custom.description.label')),
        h('input', {
          id: `${idPrefix}-role-description`,
          type: 'text',
          className: 'agent-roster-input',
          'data-agent-roster-role-description': '',
          value: description,
          placeholder: t('custom.description.placeholder'),
          autoComplete: 'off',
          onChange: (event) => { onDescription(event.target.value) },
        }),
        h('label', { className: 'agent-roster-label', htmlFor: `${idPrefix}-role-prompt` }, t('custom.prompt.label')),
        h('textarea', {
          id: `${idPrefix}-role-prompt`,
          className: 'agent-roster-input agent-roster-textarea',
          'data-agent-roster-role-prompt': '',
          rows: 5,
          value: prompt,
          placeholder: t('custom.prompt.placeholder'),
          onChange: (event) => { onPrompt(event.target.value) },
        }))
    }

    /**
     * One stored ModelRef as a stable key: JSON [provider, model], or null.
     * A ref whose provider or model is empty is no usable route and reads as
     * "no default" (null) everywhere — the picker, the chip, and the synthetic
     * editor row — instead of becoming an explicit choice the host refuses.
     */
    const refKey = (ref) => ref !== null && typeof ref === 'object'
      && typeof ref.provider === 'string' && ref.provider !== ''
      && typeof ref.model === 'string' && ref.model !== ''
      ? JSON.stringify([ref.provider, ref.model])
      : null

    /**
     * The editor rows for one stored default model: the catalog rows plus,
     * when the ref is valid but no catalog row carries it (catalog degraded
     * or model retired), a synthetic row whose only effort option is the
     * stored effort — so an open→save round-trip that never touches the
     * control keeps provider/model/effort intact (the card always sends an
     * explicit defaultModel, so a missing option would silently null it).
     */
    function rowsWithRef(rows, ref) {
      const key = refKey(ref)
      if (key === null || rows.some((row) => row.key === key)) return rows
      const efforts = typeof ref.reasoningEffort === 'string' && ref.reasoningEffort !== ''
        ? [{ id: ref.reasoningEffort, name: ref.reasoningEffort }]
        : []
      return [...rows, { key, provider: ref.provider, model: ref.model, name: `${ref.provider} / ${ref.model}`, groupName: ref.provider, efforts }]
    }

    /** The default-model chip text of one stored ModelRef (or the none label). */
    function modelChipText(t, ref) {
      if (refKey(ref) === null) return t('card.model.none')
      const params = { provider: ref.provider, model: ref.model }
      return typeof ref.reasoningEffort === 'string' && ref.reasoningEffort !== ''
        ? t('card.model.chip.effort', { ...params, effort: ref.reasoningEffort })
        : t('card.model.chip', params)
    }

    /**
     * The "+"-menu modal (ADR-0012): pick a template, optionally override the
     * member model and give a first task, then confirm. Confirming stages the
     * request and runs `/roster` — nothing is injected into the conversation.
     * The member MODEL is the one surface the user may override per spawn: the
     * picker starts from the template's default and the choice is staged, so
     * it reaches the spawn without editing the template.
     * @param {any} props - `sessionId`, `close()`, the locale seat's `t`.
     */
    function RosterModal(props) {
      const { sessionId, close, t } = props
      const [templates, setTemplates] = React.useState({ phase: 'loading' })
      const [selectedId, setSelectedId] = React.useState(null)
      const [task, setTask] = React.useState('')
      const [outcome, setOutcome] = React.useState(null)
      const [sending, setSending] = React.useState(false)
      // Per-spawn model choice. A pick belongs to the template it was made for
      // (`choiceFor`): switching templates falls back to the new template's
      // default instead of carrying a stale route. '' = inherit.
      const [choice, setChoice] = React.useState('')
      const [effort, setEffort] = React.useState('')
      const [choiceFor, setChoiceFor] = React.useState(null)
      const { rows } = useModelRows()

      // Load the template list once per open; a missing namespace (host plugin
      // not loaded) degrades to the unavailable line, never a crash.
      React.useEffect(() => {
        const ns = rosterNs()
        if (ns?.listTemplates === undefined) {
          setTemplates({ phase: 'unavailable' })
          return undefined
        }
        let alive = true
        settle(ns.listTemplates()).then(
          (value) => { if (alive) setTemplates({ phase: 'ready', list: Array.isArray(value) ? value : [] }) },
          (error) => { if (alive) setTemplates({ phase: 'failed', error }) },
        )
        return () => { alive = false }
      }, [])

      const list = templates.phase === 'ready' ? templates.list : []
      const effectiveId = (selectedId !== null && list.some((tpl) => tpl.id === selectedId)
        ? selectedId
        : list[0]?.id) ?? null
      const selected = list.find((tpl) => tpl.id === effectiveId) ?? null
      // Effective choice: the user's own pick for THIS template, else the
      // template's default. rowsWithRef keeps a default the catalog does not
      // list (degraded catalog, retired model) selectable and lossless.
      const defaultRef = selected?.defaultModel ?? null
      const defaultKey = refKey(defaultRef) ?? ''
      const defaultEffort = typeof defaultRef?.reasoningEffort === 'string' ? defaultRef.reasoningEffort : ''
      const ownPick = selected !== null && choiceFor === selected.id
      const modelChoice = ownPick ? choice : defaultKey
      const effortChoice = ownPick ? effort : defaultEffort
      const modelRows = React.useMemo(() => rowsWithRef(rows, defaultRef), [rows, defaultRef])
      const byKey = React.useMemo(() => rowsByKey(modelRows), [modelRows])
      const memberModel = modelRefOf(modelChoice === '' ? undefined : byKey.get(modelChoice), effortChoice)
      const canConfirm = selected !== null && !sending
      /** Pick the member model: another model starts on its own default effort;
       * re-picking the template's model restores its stored effort. */
      const pickModel = (key) => {
        setChoice(key)
        setChoiceFor(effectiveId)
        setEffort(key === defaultKey ? defaultEffort : '')
        setOutcome(null)
      }
      const pickEffort = (id) => {
        // An effort pick is a choice about the model in effect: capture that
        // model too, or the pick would read as "inherit the session model"
        // while the user only asked for another effort (review 2026-11-25).
        setChoice(modelChoice)
        setEffort(id)
        setChoiceFor(effectiveId)
        setOutcome(null)
      }

      /**
       * Create the member the way `/compact` compacts: stage what the user
       * chose through the remote, then run `/roster` on this session. The
       * command leaves two log-only lifecycle events in the transcript and no
       * model message (dsh packages/interaction/commands README); its outcome
       * renders as a flow node, so the admission `{ matched }` is all this
       * dialog ever sees.
       */
      const confirm = async () => {
        if (!canConfirm) return
        setSending(true)
        setOutcome(null)
        try {
          const ns = rosterNs()
          if (ns?.stageSpawn === undefined) throw new Error(t('command.unavailable'))
          // Staging resolves the template NOW, so an unknown one fails here,
          // in front of the user, instead of inside the command node.
          await settle(ns.stageSpawn({ sessionId, templateId: selected.id, model: memberModel, task }))
          const sessions = optService('sessions')
          if (sessions?.using === undefined) throw new Error(t('command.unavailable'))
          await sessions.using(sessionId, { source: 'agent-roster' }, async (reference) => {
            const result = await reference.binding.session.command(`/roster ${selected.name}`)
            if (result?.ok === false) throw result.error ?? new Error(t('command.failed'))
            if (result.value?.matched !== true) throw new Error(t('command.unmatched'))
            return result
          })
          setOutcome({ ok: true })
        } catch (error) {
          setOutcome({ ok: false, error })
        } finally {
          setSending(false)
        }
      }

      return h(Modal, {
        open: true,
        onClose: sending ? undefined : close,
        title: t('modal.title'),
        closeLabel: t('modal.close'),
        contentClassName: 'agent-roster-content',
        footer: h('div', { className: 'agent-roster-footer' },
          h('button', {
            type: 'button',
            className: 'agent-roster-button',
            'data-agent-roster-cancel': '',
            disabled: sending,
            onClick: close,
          }, t('modal.close')),
          h('button', {
            type: 'button',
            className: 'agent-roster-button agent-roster-button-confirm',
            'data-agent-roster-confirm': '',
            disabled: !canConfirm,
            onClick: () => { void confirm() },
          }, sending ? t('command.sending') : t('command.action'))),
      },
      h('div', { className: 'agent-roster', 'data-agent-roster': '' },
        outcome === null
          ? null
          : outcome.ok === true
            ? h('div', {
              className: 'agent-roster-banner agent-roster-banner-success',
              'data-agent-roster-banner': 'success',
              role: 'status',
              'aria-live': 'polite',
            }, t('command.sent', { name: selected?.name ?? '' }))
            : h('div', {
              className: 'agent-roster-banner agent-roster-banner-error',
              'data-agent-roster-banner': 'error',
              'data-agent-roster-error': typeof outcome.error?.code === 'string' ? outcome.error.code : '',
              role: 'alert',
            },
            h('span', { className: 'agent-roster-error-label' }, t('command.failed')),
            errorDetail(outcome.error)),
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
            ? h('div', { className: 'agent-roster-note', 'data-agent-roster-note': 'empty' }, t('templates.none')) : null,
          templates.phase === 'ready' && list.length > 0
            ? h('div', { className: 'agent-roster-templates', role: 'listbox', 'aria-label': t('templates.title') },
              list.map((tpl) => h('button', {
                type: 'button',
                key: tpl.id,
                role: 'option',
                className: 'agent-roster-template',
                'data-agent-roster-template': tpl.id,
                'aria-selected': tpl.id === effectiveId ? 'true' : 'false',
                onClick: () => { setSelectedId(tpl.id); setOutcome(null) },
              },
              h('span', { className: 'agent-roster-template-name' }, String(tpl.name ?? '')),
              tpl.description === '' ? null : h('span', { className: 'agent-roster-template-desc' }, String(tpl.description)))))
            : null),
        selected === null
          ? null
          : h(ModelRefEditor, {
            section: 'model',
            id: 'agent-roster-model',
            marker: 'data-agent-roster-model',
            noneMarker: 'inherit',
            label: t('spawn.model.label'),
            defaultLabel: t('spawn.model.inherit'),
            effortLabel: t('model.effort.label'),
            effortDefaultLabel: t('model.effort.default'),
            rows: modelRows,
            byKey,
            choice: modelChoice,
            onChoice: pickModel,
            effort: effortChoice,
            onEffort: pickEffort,
            disabled: sending,
          }),
        selected === null
          ? null
          : h('section', { className: 'agent-roster-section', 'data-agent-roster-section': 'task' },
            h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-task' }, t('task.label')),
            h('textarea', {
              id: 'agent-roster-task',
              className: 'agent-roster-input agent-roster-textarea',
              'data-agent-roster-task': '',
              rows: 2,
              value: task,
              placeholder: t('task.placeholder'),
              disabled: sending,
              onChange: (event) => { setTask(event.target.value) },
            }))))
    }

    /**
     * The overlay seat: one entry per session in conversation.input.overlay.
     * It owns the open bit; the command's run(session) flips it through the
     * opener its mount effect registers (the ui-message-feedback dialog
     * placement pattern — the Modal portals from here, the overlay supplies
     * the per-session scope).
     * @param {any} props - the seat's composed props: the inject face's
     *   `sessionId` and the locale seat's `t` (the slot's other standard
     *   props are accepted and unused).
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

    // -------------------------------------------------------------------------
    // The Settings roster manager (templates: list / add / edit / delete).
    // -------------------------------------------------------------------------

    /**
     * The roster manager body: the template list with per-row edit/delete
     * and the add button, or one open editor form. Every write goes through
     * the module-level rosterNs() lookup; failures render bilingual
     * reasons and the list re-reads after each successful write.
     */
    /**
     * The settings.section entry: renders through the Settings page's
     * `settings.section.view` factory with `{ id, close }` owner props
     * (ui-settings contract/slots.ts:17-27) — no `view` gate and no session
     * identity. The body is the roster manager.
     * @param {any} props - the section view props; the bound locale `t`
     *   comes from the registration's `locale` option.
     */
    function RosterSettingsSection(props) {
      const { t } = props
      return h('div', { className: 'agent-roster-settings', 'data-agent-roster-settings': '' },
        h(RosterCardPage, { t }))
    }

    /**
     * The card body (hook-bearing, mounted only for the page view so the
     * wrapper stays hook-order-stable): the template list with per-row
     * edit/delete and the add button, or one open editor form. Every write
     * goes through the service; failures render bilingual reasons and the
     * list re-reads after each successful write.
     * @param {any} props - the locale seat's `t` and the (usually absent)
     *   `sessionId` seat prop.
     */
    function RosterCardPage(props) {
      const { t } = props
      const [templates, setTemplates] = React.useState({ phase: 'loading' })
      // null = list view; { mode: 'add' } | { mode: 'edit', template } = the open form.
      const [editor, setEditor] = React.useState(null)
      // The armed (confirm-pending) delete row id — the modal's
      // confirm-then-act pattern for destructive actions.
      const [armed, setArmed] = React.useState(null)
      const [deleting, setDeleting] = React.useState(false)
      const [deleteError, setDeleteError] = React.useState(null)

      const loadTemplates = React.useCallback(() => {
        const ns = rosterNs()
        if (ns?.listTemplates === undefined) {
          setTemplates({ phase: 'unavailable' })
          return undefined
        }
        return settle(ns.listTemplates()).then(
          (value) => {
            setTemplates({ phase: 'ready', list: Array.isArray(value) ? value : [] })
            // A successful refresh retires any stale delete-failure banner
            // (whole-branch review: the banner must not outlive the state
            // it describes).
            setDeleteError(null)
          },
          (error) => { setTemplates({ phase: 'failed', error }) },
        )
      }, [])
      React.useEffect(() => { loadTemplates() }, [loadTemplates])

      /** Delete one template after its row's two-click confirm. */
      const removeTemplate = async (id) => {
        if (deleting) return
        const ns = rosterNs()
        if (ns?.deleteTemplate === undefined) {
          setDeleteError({ code: 'roster/unavailable', message: t('templates.unavailable') })
          return
        }
        setDeleting(true)
        setDeleteError(null)
        try {
          await settle(ns.deleteTemplate(id))
          setArmed(null)
          await loadTemplates()
        } catch (error) {
          setDeleteError(error)
          setArmed(null)
        } finally {
          setDeleting(false)
        }
      }

      const list = templates.phase === 'ready' ? templates.list : []

      const rowOf = (tpl) => h('div', {
        key: String(tpl?.id ?? ''),
        className: 'agent-roster-card-row',
        'data-agent-roster-row': String(tpl?.id ?? ''),
      },
        h('div', { className: 'agent-roster-card-row-head' },
          h('span', { className: 'agent-roster-card-row-name', 'data-agent-roster-row-name': '' }, String(tpl?.name ?? '')),
          h('div', { className: 'agent-roster-card-meta' },
            h('span', { className: 'agent-roster-card-chip', 'data-agent-roster-row-model': '' }, modelChipText(t, tpl?.defaultModel ?? null)),
            h('span', { className: 'agent-roster-card-row-updated', 'data-agent-roster-row-updated': '' },
              t('card.updatedAt', { time: String(tpl?.updatedAt ?? '') })))),
        tpl?.description ? h('span', { className: 'agent-roster-card-row-desc', 'data-agent-roster-row-desc': '' }, String(tpl.description)) : null,
        h('div', { className: 'agent-roster-card-row-actions' },
          h('button', {
            type: 'button',
            className: 'agent-roster-button',
            'data-agent-roster-row-edit': tpl?.id,
            onClick: () => { setArmed(null); setDeleteError(null); setEditor({ mode: 'edit', template: tpl }) },
          }, t('card.edit')),
          h('button', {
            type: 'button',
            className: 'agent-roster-button',
            'data-agent-roster-row-delete': tpl?.id,
            disabled: deleting,
            onClick: () => {
              if (armed === tpl?.id) { void removeTemplate(tpl?.id) } else { setArmed(tpl?.id) }
            },
          }, deleting && armed === tpl?.id ? t('card.deleting') : armed === tpl?.id ? t('card.delete.confirm') : t('card.delete'))))

      return h('div', { className: 'agent-roster-card', 'data-agent-roster-card': '' },
        deleteError === null ? null : h('div', {
          className: 'agent-roster-banner agent-roster-banner-error',
          'data-agent-roster-card-error': '',
          'data-agent-roster-error': typeof deleteError.code === 'string' ? deleteError.code : '',
          role: 'alert',
        },
        h('span', { className: 'agent-roster-error-label' }, t('card.deleteFailed')),
        errorDetail(deleteError)),
        editor === null
          ? h('div', { className: 'agent-roster-card-list' },
            h('div', { className: 'agent-roster-card-head' },
              h('span', { className: 'agent-roster-label' }, t('card.title')),
              h('button', {
                type: 'button',
                className: 'agent-roster-button agent-roster-button-confirm',
                'data-agent-roster-card-add': '',
                onClick: () => { setArmed(null); setDeleteError(null); setEditor({ mode: 'add' }) },
              }, t('card.add'))),
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
              ? h('div', { className: 'agent-roster-card-rows' }, list.map(rowOf))
              : null)
          : h(RosterCardForm, {
            key: editor.mode === 'edit' ? `edit:${editor.template?.id ?? ''}` : 'add',
            mode: editor.mode,
            template: editor.mode === 'edit' ? editor.template : null,
            t,
            close: () => { setEditor(null) },
            saved: () => { setEditor(null); void loadTemplates() },
          }))
    }

    /**
     * The card's add/edit form: the shared
     * RoleFields and the shared ModelRefEditor (default = no default model).
     * Saves go through saveTemplate — `id` on edit, none on add — with the
     * full explicit field set (patch semantics not relied upon, so clearing
     * a field actually clears it); a failure stays in-form with its
     * bilingual reason, a success closes the form and refreshes the list.
     * @param {any} props - `mode` ('add' | 'edit'), `template` (edit only),
     *   `t`, `close()`, `saved()`.
     */
    function RosterCardForm(props) {
      const { mode, template, t, close, saved } = props
      const storedModel = mode === 'edit' ? (template?.defaultModel ?? null) : null
      const { rows } = useModelRows()
      const startKey = refKey(storedModel)
      const startEffort = storedModel !== null && typeof storedModel.reasoningEffort === 'string' ? storedModel.reasoningEffort : ''
      const [name, setName] = React.useState(typeof template?.name === 'string' ? template.name : '')
      const [description, setDescription] = React.useState(typeof template?.description === 'string' ? template.description : '')
      const [prompt, setPrompt] = React.useState(typeof template?.prompt === 'string' ? template.prompt : '')
      const [modelChoice, setModelChoice] = React.useState(startKey ?? '')
      const [effortChoice, setEffortChoice] = React.useState(startEffort)
      const [saving, setSaving] = React.useState(false)
      const [outcome, setOutcome] = React.useState(null)

      // Lossless model editing: the stored ref rides as a synthetic row
      // when the catalog does not carry it, so an untouched open→save
      // round-trip keeps provider/model/effort intact. When the catalog
      // DOES carry the model but does not advertise the stored effort, the
      // effort input stays hidden while the stored effort still rides the
      // saved ref (modelRefOf forwards effortChoice unchanged).
      const editRows = React.useMemo(() => rowsWithRef(rows, storedModel), [rows, storedModel])
      const byKey = React.useMemo(() => rowsByKey(editRows), [editRows])

      const nameText = name.trim()
      const descriptionText = description.trim()
      const promptText = prompt.trim()
      const complete = nameText !== '' && promptText !== ''
      const chosen = modelChoice === '' ? undefined : byKey.get(modelChoice)
      const modelRef = modelRefOf(chosen, effortChoice)

      /** Save through saveTemplate; failures stay in-form for a fix. */
      const confirmSave = async () => {
        if (!complete || saving) return
        const ns = rosterNs()
        setSaving(true)
        setOutcome(null)
        if (ns?.saveTemplate === undefined) {
          setOutcome({ ok: false, error: { code: 'roster/unavailable', message: t('templates.unavailable') } })
          setSaving(false)
          return
        }
        try {
          await settle(ns.saveTemplate({
            ...(mode === 'edit' ? { id: template?.id } : {}),
            name: nameText,
            description: descriptionText,
            prompt: promptText,
            defaultModel: modelRef,
          }))
          saved()
        } catch (error) {
          setOutcome({ ok: false, error })
        } finally {
          setSaving(false)
        }
      }

      return h('div', { className: 'agent-roster-card-form', 'data-agent-roster-card-form': '' },
        h('div', { className: 'agent-roster-card-head' },
          h('span', { className: 'agent-roster-label' }, mode === 'edit' ? t('card.edit') : t('card.add'))),
        h(RoleFields, {
          t,
          idPrefix: 'agent-roster-card',
          name,
          description,
          prompt,
          onName: setName,
          onDescription: setDescription,
          onPrompt: setPrompt,
        }),
        h(ModelRefEditor, {
          id: 'agent-roster-card-model',
          marker: 'data-agent-roster-card-model',
          noneMarker: 'none',
          label: t('card.defaultModel'),
          defaultLabel: t('card.model.none'),
          effortLabel: t('model.effort.label'),
          effortDefaultLabel: t('model.effort.default'),
          rows: editRows,
          byKey,
          choice: modelChoice,
          onChoice: (value) => { setModelChoice(value); setEffortChoice('') },
          effort: effortChoice,
          onEffort: setEffortChoice,
        }),
        outcome === null ? null : h('div', {
          className: 'agent-roster-banner agent-roster-banner-error',
          'data-agent-roster-card-form-error': '',
          'data-agent-roster-error': typeof outcome.error?.code === 'string' ? outcome.error.code : '',
          role: 'alert',
        },
        h('span', { className: 'agent-roster-error-label' }, t('card.saveFailed')),
        errorDetail(outcome.error)),
        complete || saving ? null : h('p', { className: 'agent-roster-hint', 'data-agent-roster-card-save-hint': '' }, t('card.incomplete')),
        h('div', { className: 'agent-roster-footer' },
          h('button', {
            type: 'button',
            className: 'agent-roster-button agent-roster-button-confirm',
            'data-agent-roster-card-save': '',
            disabled: !complete || saving,
            onClick: () => { void confirmSave() },
          }, saving ? t('card.saving') : t('card.save')),
          h('button', {
            type: 'button',
            className: 'agent-roster-button',
            'data-agent-roster-card-cancel': '',
            disabled: saving,
            onClick: close,
          }, t('card.cancel'))))
    }

    /**
     * Scoped sheet, appended once per activation and removed with the plugin.
     * Styles follow the HOST's native settings controls, copied and renamed
     * under this plugin's prefix (practices.md: copy markup, CSS, and behavior
     * from the host control; keep only --dsw-alias-* tokens):
     * - field rhythm, label, input, hint — ui-primitives settings-form/
     *   fields.module.css (.field 12px 0 + 6px gap + 0.5px hairline
     *   separators; .label 13px/500/1.5; .input height 34px, padding 0 12px,
     *   0.5px border-l4, radius md, bg layer-3, 13px/1.5, focus border
     *   business-primary, disabled label-tertiary) and ConfigField.module.css
     *   (textarea padding 6px 12px, resize vertical).
     * - buttons — ui-primitives Button.module.css (sm 28px, radius sm, ghost
     *   hover interactive-bg-hover, disabled 0.4) and settings-form/
     *   SettingsForm.module.css (.save primary fill 5px 14px, focus ring).
     * - the model dropdown — ui-model-selection ModelSelect.module.css (CSS
     *   anchor positioning, portaled MenuSurface, provider-grouped rows).
     */
    const STYLES = `
[data-agent-roster] { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
.agent-roster-content { max-height: min(520px, 70vh); overflow: auto; }
.agent-roster-section { display: flex; flex-direction: column; gap: 6px; }
.agent-roster-label { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.agent-roster-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.agent-roster-note { padding: 8px 12px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-3); border-radius: var(--dsw-radius-md); }
.agent-roster-error { color: var(--dsw-alias-label-error); }
.agent-roster-error-detail { font-family: var(--dsw-alias-font-mono, monospace); font-size: 12px; }
.agent-roster-banner { padding: 8px 12px; font-size: 12px; line-height: 1.5; border-radius: var(--dsw-radius-md); }
.agent-roster-banner-success { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-banner-error { display: flex; flex-direction: column; gap: 2px; color: var(--dsw-alias-label-error); background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-error-label { font-weight: 500; }
.agent-roster-templates { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto; }
.agent-roster-template { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border: 0.5px solid transparent; border-radius: var(--dsw-radius-md); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.agent-roster-template:hover { background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-template[aria-selected='true'] { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-active); }
.agent-roster-template-name { font-size: 13px; font-weight: 500; line-height: 1.5; }
.agent-roster-template-desc { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.agent-roster-input { box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); }
.agent-roster-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.agent-roster-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.agent-roster-textarea { height: auto; min-height: 56px; padding: 6px 12px; resize: vertical; }
.agent-roster-effort { display: flex; flex-direction: column; gap: 6px; }
.agent-roster-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.agent-roster-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.agent-roster-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-button:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.agent-roster-button:disabled { opacity: 0.4; cursor: not-allowed; }
.agent-roster-button:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.agent-roster-button-confirm { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.agent-roster-button-confirm:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
/* The Settings > Agent roster page (settings.section body). */
[data-agent-roster-settings] { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); }
/* The roster manager (Settings section part two). */
[data-agent-roster-card] { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); }
.agent-roster-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-roster-card-rows { display: flex; flex-direction: column; }
.agent-roster-card-row { display: flex; flex-direction: column; gap: 4px; padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.agent-roster-card-row:first-child { border-top: none; }
.agent-roster-card-row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-roster-card-row-name { font-size: 13px; font-weight: 500; line-height: 1.5; }
.agent-roster-card-row-desc { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.agent-roster-card-meta { display: flex; align-items: center; gap: 8px; }
.agent-roster-card-chip { font-size: 12px; font-family: var(--dsw-alias-font-mono, monospace); padding: 2px 6px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); }
.agent-roster-card-row-updated { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.agent-roster-card-row-actions { display: flex; gap: 8px; }
.agent-roster-card-form { display: flex; flex-direction: column; }
.agent-roster-role-fields { display: flex; flex-direction: column; }
.agent-roster-role-fields > * + * { border-top: 0.5px solid var(--dsw-alias-border-l2); }
/* ModelMenu — copied from ui-model-selection ModelSelect.module.css and
 * ui-primitives MenuGroup.module.css, renamed under this prefix. CSS anchor
 * positioning: the trigger names an anchor through an inline custom
 * property; the fixed body portal positions against it. */
.agent-roster-menu-root { position: relative; min-width: 0; }
.agent-roster-menu-trigger {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 8px 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  outline: none;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  anchor-name: var(--dsh-roster-anchor);
}
.agent-roster-menu-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-menu-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.agent-roster-menu-trigger:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.agent-roster-menu-trigger-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.agent-roster-menu-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }
.agent-roster-menu-chevron-open { transform: rotate(180deg); }
.agent-roster-menu-surface {
  box-sizing: border-box;
  position: fixed;
  position-anchor: var(--dsh-roster-anchor);
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  left: 12px;
  right: anchor(right);
  bottom: calc(anchor(top) + 8px);
  align-self: safe end;
  justify-self: safe end;
  margin: 0;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  width: fit-content;
  height: fit-content;
  min-width: min(240px, calc(100vw - 24px));
  max-width: min(420px, calc(100vw - 24px));
  max-height: min(360px, calc(100dvh - 96px));
  overflow: hidden;
  padding: 4px;
  border: 0;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.agent-roster-menu-groups { min-height: 0; overflow-x: hidden; overflow-y: auto; }
.agent-roster-menu-option {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: auto;
  min-width: 100%;
  min-height: 34px;
  padding: 5px 7px;
  border: none;
  border-radius: var(--dsw-radius-md);
  outline: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.agent-roster-menu-option:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) { .agent-roster-menu-option:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } }
.agent-roster-menu-option:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.agent-roster-menu-option-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.agent-roster-menu-option-name { overflow: hidden; color: inherit; font-size: 13px; line-height: 18px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.agent-roster-menu-check { display: grid; place-items: center; flex: 0 0 14px; color: var(--dsw-alias-label-primary); }
.agent-roster-menu-check svg { width: 14px; height: 14px; }
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
      inject: ['commandUi', 'locale', 'sessions', 'slots', 'remote'],
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
        // The Settings page section (2026-11-23 UX ruling: role
        // configuration lives in Settings next to models/presets, not on
        // the Plugins-page card). One `settings.section` list entry — the
        // ui-settings-models precedent (client/index.ts:143-152): `name`
        // is the SlotMap key, `id` the section key, `order` the nav
        // position, `label` a locale thunk. With no
        // `plugins.bundle.config` card of our own, the Plugins row shows
        // this section's entry (settings shell contract: an entry appears
        // on the bundle row that registers no configuration).
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'agent-roster', order: 40, locale: NS, label: () => t('settings.nav') },
          RosterSettingsSection,
        )), 'dsh-agent-roster: settings section')
        ctx.effect(() => injectStyles(), 'dsh-agent-roster: styles')
      },
    }
  },
})
