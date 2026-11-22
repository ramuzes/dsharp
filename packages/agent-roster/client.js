/**
 * dsh-agent-roster — browser half.
 *
 * One self-contained script in the client module system's factory format: it
 * calls window.__ModuleLoader__.load() with the package name and a factory
 * that lazily requires its modules (React and the baseline ui-primitives are
 * module-table identities, so nothing is bundled) and returns a cordis
 * plugin object (packages/airboard/client.js:18-27 shape).
 *
 * Task 6 landed the scaffold: locale dictionaries, the `agentRoster` remote
 * namespace mount (all six Host methods, Tasks 2–4), one "+"-menu command,
 * and the spawn modal's happy path. Task 7 (this file's current scope)
 * completes the modal: the custom-role form with save-as-template, the
 * AI-draft area (fill-only proposals), real model selection over the Host
 * catalog, and the team-gating banner states. The settings card is Task 8.
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
 *   only gates the `onClose` it hands over (in-flight spawn/draft).
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
 * - Session-scoped slot standard props — `useProjection`: the slot machinery
 *   composes the standard props into every session-scope seat (ui-renderer
 *   scoped-slots.tsx:521,602 standardProps keyed hooks; ui-session
 *   client/index.ts:148-157 SessionStandardProps), and `useProjection` is
 *   the per-key projection hook (UseProjection, session-controller
 *   src/client/sessions/projection-store.ts:38-45; undefined = capability
 *   absent). `modelSelection` is a registered projection key whose `next`
 *   is the live selection (core/agent types.ts:78-101 — null while the
 *   Agent's initial options supply the route). Read the ui-agent-team
 *   TeamModeToggle.tsx:39-41 way: a PROP the seat receives, never a remote.
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
      'confirm.hint.template': '请先选择一个角色模板',
      'memberName.label': '成员名称',
      'memberName.placeholder': '留空使用模板名称',
      'memberName.hint': '成员在其会话树中的名字；留空时由模板名称派生',
      'model.label': '模型',
      'model.inherit': '继承当前会话模型',
      'model.effort.label': '推理力度（可选）',
      'model.effort.default': '模型默认',
      'task.label': '首个任务（可选）',
      'task.placeholder': '交给这位成员的第一个任务',
      'custom.toggle': '自定义角色（不用模板）',
      'custom.incomplete': '填写自定义角色的名称与提示词后才能创建成员',
      'custom.name.label': '角色名称',
      'custom.name.placeholder': '例如：Market Scout',
      'custom.description.label': '角色描述（可选）',
      'custom.description.placeholder': '一句话说明这个角色负责什么',
      'custom.prompt.label': '角色提示词',
      'custom.prompt.placeholder': '写给这位成员的完整系统提示词',
      'custom.saveTemplate': '保存为角色模板',
      'draft.label': 'AI 起草',
      'draft.placeholder': '用一两句话描述想要的角色，模型将起草名称、描述与提示词',
      'draft.model': '起草模型',
      'draft.model.inherit': '沿用草稿会话自身的模型',
      'draft.action': '起草',
      'draft.inflight': '起草中…',
      'draft.abort': '停止等待',
      'draft.aborted': '已停止等待：草稿会话中的生成可能仍在进行',
      'draft.unparsed': '模型回复未能解析为结构化草稿，原文已填入提示词，请手动整理',
      'draft.failed': '起草失败',
      'team.guidance': '无法在此判断团队模式状态：可从根会话的模型菜单管理团队模式，或确认 agent-team 插件已启用',
      'team.enable.explain': '团队模式让本次会话树中的成员互相协作。为这棵会话树启用团队模式：',
      'team.enable.action': '启用团队模式',
      'team.enable.enabling': '启用中…',
      'team.nonroot': '这是成员会话：团队模式由根会话的模型菜单开关管理，请前往根会话操作',
      'team.rows.explain': '团队模式需要 agent-team 插件，而它们当前处于停用状态。',
      'team.rows.action': '启用 agent-team 插件',
      'team.rows.confirm': '再次点击以确认启用两行插件',
      'team.rows.enabling': '启用中…',
      'team.actionFailed': '团队操作失败',
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
      'confirm.hint.template': 'Pick a role template first',
      'memberName.label': 'Member name',
      'memberName.placeholder': 'Leave blank to use the template name',
      'memberName.hint': "The member's name in its session tree; blank derives from the template name",
      'model.label': 'Model',
      'model.inherit': 'Inherit the current session model',
      'model.effort.label': 'Reasoning effort (optional)',
      'model.effort.default': 'Model default',
      'task.label': 'First task (optional)',
      'task.placeholder': 'The first task to hand this member',
      'custom.toggle': 'Custom role (no template)',
      'custom.incomplete': "Fill in the custom role's name and prompt to create the member",
      'custom.name.label': 'Role name',
      'custom.name.placeholder': 'e.g. Market Scout',
      'custom.description.label': 'Role description (optional)',
      'custom.description.placeholder': 'One line on what this role is for',
      'custom.prompt.label': 'Role prompt',
      'custom.prompt.placeholder': 'The full standing prompt written for this member',
      'custom.saveTemplate': 'Save as a role template',
      'draft.label': 'AI draft',
      'draft.placeholder': 'Describe the role you want in a sentence or two; the model drafts the name, description, and prompt',
      'draft.model': 'Draft model',
      'draft.model.inherit': "Keep the draft session's own model",
      'draft.action': 'Draft',
      'draft.inflight': 'Drafting…',
      'draft.abort': 'Stop waiting',
      'draft.aborted': 'Stopped waiting: the draft session may still be generating',
      'draft.unparsed': 'The reply did not parse into a structured draft; the raw text was placed in the prompt — edit it manually',
      'draft.failed': 'Draft failed',
      'team.guidance': "Team-mode status cannot be determined here. Manage Team mode from the root session's model menu, or make sure the agent-team plugins are enabled",
      'team.enable.explain': 'Team mode lets the members of this session tree collaborate. Enable it for this tree:',
      'team.enable.action': 'Enable Team mode',
      'team.enable.enabling': 'Enabling…',
      'team.nonroot': "This is a member session: Team mode is toggled from the root session's model menu — switch to the root conversation to change it",
      'team.rows.explain': 'Team mode needs the agent-team plugins, and their rows are currently disabled.',
      'team.rows.action': 'Enable the agent-team plugins',
      'team.rows.confirm': 'Click again to confirm enabling both rows',
      'team.rows.enabling': 'Enabling…',
      'team.actionFailed': 'Team action failed',
      'action.confirm': 'Create member',
      'action.confirming': 'Creating…',
      'action.cancel': 'Cancel',
      'spawn.success': 'Member {name} created',
      'spawn.failed': 'Spawn failed',
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
     * Optional lookup of one client Remote namespace (`remote.agentRoster`
     * and the generated faces `remote.session`, `remote.agentTeams`,
     * `remote.pluginInventory`, `remote.pluginManager`): try-guarded
     * ctx.get — undefined when the face is absent on this host.
     */
    const optRemote = (name) => {
      try { return pluginCtx?.get?.(name) } catch { return undefined }
    }

    /** Optional roster namespace lookup; undefined until $mount lands. */
    const rosterNs = () => optRemote('remote.agentRoster')

    /** Unwrap a RemoteResult ({ok, value}) or pass a raw object through. */
    function unwrap(result) {
      if (result !== null && typeof result === 'object' && 'ok' in result) return result.ok ? result.value : undefined
      return result
    }

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
     * The agent-team plugin rows of an inventory snapshot: entries whose
     * entryId or moduleName names the two team plugins. Deployments
     * configure ids `agent-team` / `tool-agent-team` with package names
     * `@deepseek-ai/dsh-agent-team` / `@deepseek-ai/dsh-tool-agent-team`
     * (snapshots/sdk/team-session-mode/cordis.yml); both naming faces are
     * accepted because either may be customized per deployment.
     * @param {Array<{ entryId?: string, moduleName?: string, enabled?: boolean }>} entries
     * @returns {Array<{ entryId: string, enabled: boolean }>}
     */
    const TEAM_ROW_IDS = ['agent-team', 'tool-agent-team']
    const TEAM_ROW_MODULES = ['@deepseek-ai/dsh-agent-team', '@deepseek-ai/dsh-tool-agent-team']
    function teamRowsIn(entries) {
      return entries
        .filter((entry) => TEAM_ROW_IDS.includes(entry?.entryId) || TEAM_ROW_MODULES.includes(entry?.moduleName))
        .map((entry) => ({ entryId: entry.entryId, enabled: entry.enabled === true }))
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
     * the open modal. Body order is the Task 6 contract — team-status banner
     * area, template list, member name, model selector, first task,
     * custom-role toggle + form (AI-draft area, name/description/prompt,
     * save-as-template) — over the shared Modal chrome.
     *
     * Task 7 behaviors: closing (Escape, mask, cancel — everything the
     * Modal primitive routes through onClose) is gated while a spawn or
     * draft is in flight, so an in-flight result is never silently dropped
     * and no duplicate spawn can race it; the model selector is populated
     * from the Host catalog with a "current session model" inherit default
     * (explicit choice sends a ModelRef, the default sends null); the
     * AI-draft area is a fill-only proposal (nothing is saved without the
     * explicit confirm, and an unparsed draft is visibly flagged); the
     * banner area carries the team-gating states (see the teamBanner
     * derivation inside RosterModal). The draft-model picker prefills from
     * the live session selection (`useProjection('modelSelection').next`)
     * with a truthful null-path default.
     * @param {any} props - `sessionId`, `close()`, the locale seat's `t`,
     *   and the slot machinery's standard `useProjection` prop.
     */
    function RosterModal(props) {
      const { sessionId, close, t, useProjection } = props
      // The session's live model selection, read through the slot
      // machinery's standard `useProjection` prop (header citations) — NOT
      // a remote. Called unconditionally through a stable fallback: the
      // real prop is a hook (per-key uSES binding, projection-store.ts:
      // 33-45), so a conditional call would break hook order in
      // production; hosts whose seat props predate the standard resolve to
      // the absent fallback. `next` is null while the Agent's initial
      // options supply the route — the prefill then falls back.
      const projectionOf = useProjection ?? ((key) => undefined)
      const modelSelection = projectionOf('modelSelection')
      const liveNext = modelSelection?.next ?? null
      const [templates, setTemplates] = React.useState({ phase: 'loading' })
      const [selectedId, setSelectedId] = React.useState(null)
      const [memberName, setMemberName] = React.useState('')
      const [task, setTask] = React.useState('')
      const [custom, setCustom] = React.useState(false)
      const [outcome, setOutcome] = React.useState(null)
      const [spawning, setSpawning] = React.useState(false)
      // Model catalog + choices: '' is the inherit default.
      const [catalog, setCatalog] = React.useState({ phase: 'loading' })
      const [modelChoice, setModelChoice] = React.useState('')
      const [effortChoice, setEffortChoice] = React.useState('')
      // Team gating: status + the agent-team rows of the plugin inventory.
      const [team, setTeam] = React.useState({ phase: 'loading' })
      const [inventory, setInventory] = React.useState({ phase: 'loading', rows: [] })
      const [teamBusy, setTeamBusy] = React.useState(false)
      const [teamError, setTeamError] = React.useState(null)
      const [rowsConfirming, setRowsConfirming] = React.useState(false)
      // Custom-role form + AI-draft area.
      const [customName, setCustomName] = React.useState('')
      const [customDescription, setCustomDescription] = React.useState('')
      const [customPrompt, setCustomPrompt] = React.useState('')
      const [saveAsTemplate, setSaveAsTemplate] = React.useState(false)
      const [brief, setBrief] = React.useState('')
      // null = unset (the live-selection prefill applies); '' = the labeled
      // default chosen explicitly; otherwise the chosen row's key.
      const [draftChoice, setDraftChoice] = React.useState(null)
      // One draft state object: `epoch` is the liveness token that lets an
      // abandoned wait discard its late resolution (no useRef — the fake
      // React of the test harness supports the hook subset above only).
      const [draft, setDraft] = React.useState({ epoch: 0, phase: 'idle', result: null })
      const drafting = draft.phase === 'drafting'

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

      // Load the model catalog once per open. The session face may be absent
      // or fail (older host, provider outage): the selector degrades to the
      // inherit-only entry and never blocks spawn (Task 6 review note 4).
      React.useEffect(() => {
        const face = optRemote('remote.session')
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

      /** Read (and re-read after banner actions) the session tree's team status. */
      const loadTeam = React.useCallback(() => {
        const ns = rosterNs()
        if (ns?.teamStatus === undefined) {
          setTeam({ phase: 'unavailable' })
          return undefined
        }
        return settle(ns.teamStatus({ sessionId })).then(
          (value) => { setTeam({ phase: 'ready', value: value ?? {} }) },
          (error) => { setTeam({ phase: 'failed', error }) },
        )
      }, [sessionId])
      React.useEffect(() => { loadTeam() }, [loadTeam])

      /** Read (and re-read) the agent-team rows of the plugin inventory. */
      const loadInventory = React.useCallback(() => {
        const face = optRemote('remote.pluginInventory')
        if (face?.list === undefined) {
          setInventory({ phase: 'unavailable', rows: [] })
          return undefined
        }
        return settle(face.list()).then(
          (value) => {
            const entries = Array.isArray(value?.entries) ? value.entries : []
            setInventory({ phase: 'ready', rows: teamRowsIn(entries) })
          },
          () => { setInventory({ phase: 'unavailable', rows: [] }) },
        )
      }, [])
      React.useEffect(() => { loadInventory() }, [loadInventory])

      // A draft result fills the custom form ONCE per result: the effect keys
      // on the result object's identity, so an abandoned wait (whose epoch
      // bump leaves state untouched) never fills anything, while a re-draft
      // deliberately overwrites manual edits.
      React.useEffect(() => {
        if (draft.result?.ok !== true) return
        const value = draft.result.value ?? {}
        setCustomName(typeof value.name === 'string' ? value.name : '')
        setCustomDescription(typeof value.description === 'string' ? value.description : '')
        setCustomPrompt(typeof value.prompt === 'string' ? value.prompt : '')
      }, [draft.result])

      const list = templates.phase === 'ready' ? templates.list : []
      // The first row is the default selection until the user picks another.
      const effectiveId = (selectedId !== null && list.some((tpl) => tpl.id === selectedId)
        ? selectedId
        : list[0]?.id) ?? null
      // Custom-role fields (trimmed; the Host re-validates anyway) gate the
      // confirm exactly like a selectable template does.
      const customNameText = customName.trim()
      const customDescriptionText = customDescription.trim()
      const customPromptText = customPrompt.trim()
      const customComplete = customNameText !== '' && customPromptText !== ''
      const canConfirm = custom ? customComplete : effectiveId !== null

      // Flat catalog rows keyed by JSON [provider, model]; empty when the
      // catalog degraded — the selector then offers the inherit entry only.
      const modelRows = React.useMemo(() => {
        if (catalog.phase !== 'ready') return []
        const rows = []
        for (const group of catalog.value.groups ?? []) {
          if (group === null || typeof group !== 'object' || typeof group.id !== 'string') continue
          for (const model of group.models ?? []) {
            if (typeof model?.id !== 'string') continue
            rows.push({
              key: JSON.stringify([group.id, model.id]),
              provider: group.id,
              model: model.id,
              name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
              groupName: typeof group.name === 'string' && group.name !== '' ? group.name : group.id,
              efforts: Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : [],
            })
          }
        }
        return rows
      }, [catalog])
      const modelByKey = new Map(modelRows.map((row) => [row.key, row]))
      const chosen = modelChoice === '' ? undefined : modelByKey.get(modelChoice)
      // Draft-picker prefill: while the user has not chosen, the picker
      // starts from the session's LIVE model when the catalog maps it.
      // Server-side, `model: null` is NOT "the current session's model"
      // for a draft — runDraft skips selectModel on null, keeping the
      // per-cwd draft session's own sticky selection (lib/drafter.js:
      // 305-316), so the labeled default must say what null really does
      // and the live selection must be sent explicitly. Unmapped, absent,
      // or null `next` — and any explicit user choice — uses the labeled
      // default instead. (The SPAWN selector's null is different and
      // correct: it omits agentOptions so the child inherits the parent's
      // route — lib/spawn.js model precedence.)
      const liveKey = liveNext !== null && typeof liveNext.provider === 'string' && typeof liveNext.model === 'string'
        ? JSON.stringify([liveNext.provider, liveNext.model])
        : null
      const effectiveDraftChoice = draftChoice ?? (liveKey !== null && modelByKey.has(liveKey) ? liveKey : '')
      const chosenDraft = effectiveDraftChoice === '' ? undefined : modelByKey.get(effectiveDraftChoice)

      /**
       * The spawn/draft model reference of one catalog row: an explicit
       * choice sends {provider, model[, reasoningEffort]}; the inherit
       * default (no row) sends null — the Host omits agentOptions so the
       * child inherits the parent's route (lib/spawn.js model precedence).
       */
      const modelRefOf = (row, effort) => row === undefined ? null : {
        provider: row.provider,
        model: row.model,
        ...(effort !== '' ? { reasoningEffort: effort } : {}),
      }
      const modelRef = modelRefOf(chosen, effortChoice)
      const draftModelRef = modelRefOf(chosenDraft, '')

      /** Provider-grouped <optgroup> rows over the flat catalog rows. */
      const catalogOptgroups = () => {
        const groups = []
        for (const row of modelRows) {
          let group = groups.find((entry) => entry.name === row.groupName)
          if (group === undefined) { group = { name: row.groupName, rows: [] }; groups.push(group) }
          group.rows.push(row)
        }
        return groups.map((group) => h('optgroup', { key: group.name, label: group.name },
          group.rows.map((row) => h('option', { key: row.key, value: row.key }, row.name))))
      }

      /**
       * Start one AI draft. The Host shares ONE draft session per workspace
       * (ADR-0010), so the button is disabled while one runs; the epoch
       * token lets abortDraft discard a late resolution. The mounted draft
       * method declares no transport cancellation (lib/roster-service.js —
       * `draft(input)`, no signal parameter), so an abort abandons the
       * CLIENT wait only: the draft session may still finish server-side.
       */
      const startDraft = async () => {
        if (drafting) return
        const briefText = brief.trim()
        if (briefText === '') return
        const ns = rosterNs()
        if (ns?.draft === undefined) {
          setDraft((prev) => ({ ...prev, epoch: prev.epoch + 1, phase: 'idle', result: { ok: false, error: { code: 'roster/unavailable', message: t('templates.unavailable') } } }))
          return
        }
        const epoch = draft.epoch + 1
        setDraft({ epoch, phase: 'drafting', result: null })
        try {
          const value = await settle(ns.draft({ sessionId, brief: briefText, model: draftModelRef }))
          setDraft((prev) => (prev.epoch === epoch ? { ...prev, phase: 'idle', result: { ok: true, value } } : prev))
        } catch (error) {
          setDraft((prev) => (prev.epoch === epoch ? { ...prev, phase: 'idle', result: { ok: false, error } } : prev))
        }
      }

      /** Stop waiting on the running draft (see startDraft for the boundary). */
      const abortDraft = () => {
        if (!drafting) return
        setDraft((prev) => ({ ...prev, epoch: prev.epoch + 1, phase: 'idle', result: { ok: false, aborted: true } }))
      }

      /** Enable Team mode for this session tree, then refresh the status. */
      const enableTeamMode = async () => {
        if (teamBusy) return
        const face = optRemote('remote.agentTeams')
        if (face?.setEnabled === undefined) return
        setTeamBusy(true)
        setTeamError(null)
        try {
          await settle(face.setEnabled(sessionId, true))
          await Promise.all([loadTeam(), loadInventory()])
        } catch (error) {
          setTeamError(error)
        } finally {
          setTeamBusy(false)
        }
      }

      /**
       * Confirm-then-enable the disabled agent-team rows: the first click
       * arms the confirmation (the label switches to the confirm copy), the
       * second enables every disabled team row found in the inventory and
       * refreshes both status reads.
       */
      const enableTeamRows = async () => {
        if (!rowsConfirming) {
          setRowsConfirming(true)
          return
        }
        if (teamBusy) return
        const face = optRemote('remote.pluginManager')
        if (face?.setPluginEnabled === undefined) {
          setRowsConfirming(false)
          return
        }
        setTeamBusy(true)
        setTeamError(null)
        try {
          for (const row of inventory.rows) {
            await settle(face.setPluginEnabled(row.entryId, true))
          }
          setRowsConfirming(false)
          await Promise.all([loadTeam(), loadInventory()])
        } catch (error) {
          setTeamError(error)
          setRowsConfirming(false)
        } finally {
          setTeamBusy(false)
        }
      }

      /**
       * The team-status banner for the current state, or null when healthy.
       * Precedence (brief's gating states): a loading read renders nothing;
       * an unavailable/failed read — or an action surface the client needs
       * but this host does not mount — renders guidance text only;
       * `teamMode` is healthy silence; `!isRoot` explains that the toggle
       * lives in the root session's model menu; otherwise disabled
       * agent-team rows (detected from the plugin inventory) offer
       * confirm-then-enable, and `canEnable` offers the setEnabled button.
       */
      const guidanceBanner = () => h('div', { className: 'agent-roster-team', 'data-agent-roster-team': 'guidance' },
        h('span', {}, t('team.guidance')),
        team.phase === 'failed' ? errorDetail(team.error) : null)
      const teamBanner = (() => {
        if (team.phase === 'loading') return null
        if (team.phase !== 'ready') return guidanceBanner()
        const status = team.value
        if (status.teamMode === true) return null
        if (status.isRoot !== true) {
          return h('div', { className: 'agent-roster-team', 'data-agent-roster-team': 'nonroot' },
            h('span', {}, t('team.nonroot')))
        }
        if (inventory.phase === 'ready' && inventory.rows.length > 0 && inventory.rows.every((row) => row.enabled !== true)) {
          if (optRemote('remote.pluginManager')?.setPluginEnabled === undefined) return guidanceBanner()
          return h('div', { className: 'agent-roster-team', 'data-agent-roster-team': 'rows' },
            h('span', {}, t('team.rows.explain')),
            h('div', { className: 'agent-roster-team-actions' },
              h('button', {
                type: 'button',
                className: 'agent-roster-button',
                'data-agent-roster-team-rows': '',
                disabled: teamBusy,
                onClick: () => { void enableTeamRows() },
              }, teamBusy ? t('team.rows.enabling') : rowsConfirming ? t('team.rows.confirm') : t('team.rows.action'))))
        }
        if (status.canEnable === true) {
          if (optRemote('remote.agentTeams')?.setEnabled === undefined) return guidanceBanner()
          return h('div', { className: 'agent-roster-team', 'data-agent-roster-team': 'enable' },
            h('span', {}, t('team.enable.explain')),
            h('div', { className: 'agent-roster-team-actions' },
              h('button', {
                type: 'button',
                className: 'agent-roster-button',
                'data-agent-roster-team-enable': '',
                disabled: teamBusy,
                onClick: () => { void enableTeamMode() },
              }, teamBusy ? t('team.enable.enabling') : t('team.enable.action'))))
        }
        return guidanceBanner()
      })()

      /**
       * Confirm: spawn the member and land the outcome banner. In custom
       * mode the save-as-template box persists the role FIRST — a save
       * failure (e.g. roster/name-taken) surfaces while it is still fixable
       * in-form instead of after the member already exists.
       */
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
        const source = custom
          ? { custom: { name: customNameText, description: customDescriptionText, prompt: customPromptText } }
          : { templateId: effectiveId }
        try {
          if (custom && saveAsTemplate) {
            if (ns.saveTemplate === undefined) {
              throw { code: 'roster/unavailable', message: t('templates.unavailable') }
            }
            await settle(ns.saveTemplate({
              name: customNameText,
              description: customDescriptionText,
              prompt: customPromptText,
              defaultModel: modelRef,
            }))
          }
          const result = await settle(ns.spawnMember({
            sessionId,
            ...source,
            ...(memberName.trim() === '' ? {} : { memberName: memberName.trim() }),
            model: modelRef,
            ...(task.trim() === '' ? {} : { task: task.trim() }),
          }))
          setOutcome({ ok: true, name: result?.name })
        } catch (error) {
          setOutcome({ ok: false, error })
        } finally {
          setSpawning(false)
        }
      }

      // Close (Escape, mask, header X — everything the Modal primitive
      // routes through onClose) is gated while a spawn or draft is in
      // flight: closing would drop the in-flight result and invite a
      // duplicate spawn into the shared tree (Task 6 review note 1).
      const guardedClose = () => { if (!spawning && !drafting) close() }

      // A hint rides along whenever confirm is disabled but not merely
      // busy (Task 6 review note 2).
      const confirmHintText = spawning
        ? null
        : custom
          ? (customComplete ? null : t('custom.incomplete'))
          : effectiveId === null ? t('confirm.hint.template') : null

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
          disabled: spawning || drafting,
          onClick: guardedClose,
        }, t('action.cancel')))

      return h(Modal, {
        open: true,
        onClose: guardedClose,
        title: t('modal.title'),
        closeLabel: t('modal.close'),
        description: t('modal.description'),
        footer,
        contentClassName: 'agent-roster-content',
      },
      h('div', { className: 'agent-roster-root', 'data-agent-roster': '' },
        h('section', { className: 'agent-roster-section', 'data-agent-roster-section': 'banner', 'aria-live': 'polite' },
          teamBanner,
          teamError === null ? null : h('div', {
            className: 'agent-roster-team agent-roster-team-error',
            'data-agent-roster-team': 'error',
            role: 'alert',
          },
          h('span', { className: 'agent-roster-error-label' }, t('team.actionFailed')),
          errorDetail(teamError)),
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
                'aria-selected': !custom && tpl.id === effectiveId ? 'true' : 'false',
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
          h('select', {
            id: 'agent-roster-model',
            className: 'agent-roster-select',
            'data-agent-roster-model': modelChoice === '' ? 'inherit' : modelChoice,
            value: modelChoice,
            onChange: (event) => { setModelChoice(event.target.value); setEffortChoice('') },
          },
            h('option', { value: '' }, t('model.inherit')),
            ...catalogOptgroups()),
          // The optional reasoning-effort input appears only beside an
          // explicit choice of a model that advertises efforts.
          chosen !== undefined && chosen.efforts.length > 0
            ? h('div', { className: 'agent-roster-effort' },
              h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-effort' }, t('model.effort.label')),
              h('select', {
                id: 'agent-roster-effort',
                className: 'agent-roster-select',
                'data-agent-roster-effort': '',
                value: effortChoice,
                onChange: (event) => { setEffortChoice(event.target.value) },
              },
                h('option', { value: '' }, t('model.effort.default')),
                chosen.efforts.map((effort) => h('option', { key: effort?.id, value: effort?.id }, String(effort?.name ?? effort?.id)))))
            : null),
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
          custom ? h('div', { className: 'agent-roster-custom-form', 'data-agent-roster-custom-form': '' },
            // AI-draft area: the brief plus the draft-model picker and the
            // Draft button. Results are PROPOSALS — they fill the fields
            // below and nothing is saved without the explicit confirm.
            h('div', { className: 'agent-roster-draft-area', 'data-agent-roster-draft-area': '' },
              h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-brief' }, t('draft.label')),
              h('textarea', {
                id: 'agent-roster-brief',
                className: 'agent-roster-input agent-roster-textarea',
                'data-agent-roster-brief': '',
                rows: 2,
                value: brief,
                placeholder: t('draft.placeholder'),
                disabled: drafting,
                onChange: (event) => { setBrief(event.target.value) },
              }),
              h('div', { className: 'agent-roster-draft-controls' },
                h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-draft-model' }, t('draft.model')),
                h('select', {
                  id: 'agent-roster-draft-model',
                  className: 'agent-roster-select',
                  'data-agent-roster-draft-model': effectiveDraftChoice === '' ? 'inherit' : effectiveDraftChoice,
                  value: effectiveDraftChoice,
                  disabled: drafting,
                  onChange: (event) => { setDraftChoice(event.target.value) },
                },
                  h('option', { value: '' }, t('draft.model.inherit')),
                  ...catalogOptgroups()),
                h('button', {
                  type: 'button',
                  className: 'agent-roster-button',
                  'data-agent-roster-draft': '',
                  disabled: brief.trim() === '' || drafting,
                  onClick: () => { void startDraft() },
                }, drafting ? t('draft.inflight') : t('draft.action')),
                drafting
                  ? h('button', {
                    type: 'button',
                    className: 'agent-roster-button',
                    'data-agent-roster-draft-abort': '',
                    onClick: abortDraft,
                  }, t('draft.abort'))
                  : null),
              draft.result?.ok === true && draft.result.value?.parsed !== true
                ? h('div', { className: 'agent-roster-note agent-roster-error', 'data-agent-roster-note': 'draft-unparsed' }, t('draft.unparsed'))
                : null,
              draft.result?.aborted === true
                ? h('div', { className: 'agent-roster-note', 'data-agent-roster-note': 'draft-aborted' }, t('draft.aborted'))
                : null,
              draft.result?.ok === false && draft.result.aborted !== true
                ? h('div', {
                  className: 'agent-roster-note agent-roster-error',
                  'data-agent-roster-draft-error': '',
                  'data-agent-roster-error': typeof draft.result.error?.code === 'string' ? draft.result.error.code : '',
                },
                h('span', { className: 'agent-roster-error-label' }, t('draft.failed')),
                errorDetail(draft.result.error))
                : null),
            h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-custom-name' }, t('custom.name.label')),
            h('input', {
              id: 'agent-roster-custom-name',
              type: 'text',
              className: 'agent-roster-input',
              'data-agent-roster-custom-name': '',
              value: customName,
              placeholder: t('custom.name.placeholder'),
              autoComplete: 'off',
              onChange: (event) => { setCustomName(event.target.value) },
            }),
            h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-custom-description' }, t('custom.description.label')),
            h('input', {
              id: 'agent-roster-custom-description',
              type: 'text',
              className: 'agent-roster-input',
              'data-agent-roster-custom-description': '',
              value: customDescription,
              placeholder: t('custom.description.placeholder'),
              autoComplete: 'off',
              onChange: (event) => { setCustomDescription(event.target.value) },
            }),
            h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-custom-prompt' }, t('custom.prompt.label')),
            h('textarea', {
              id: 'agent-roster-custom-prompt',
              className: 'agent-roster-input agent-roster-textarea',
              'data-agent-roster-custom-prompt': '',
              rows: 5,
              value: customPrompt,
              placeholder: t('custom.prompt.placeholder'),
              onChange: (event) => { setCustomPrompt(event.target.value) },
            }),
            h('label', { className: 'agent-roster-toggle' },
              h('input', {
                type: 'checkbox',
                'data-agent-roster-save-template': '',
                checked: saveAsTemplate,
                onChange: (event) => { setSaveAsTemplate(event.target.checked) },
              }),
              h('span', {}, t('custom.saveTemplate')))) : null,
          confirmHintText === null ? null : h('p', { className: 'agent-roster-hint', 'data-agent-roster-confirm-hint': '' }, confirmHintText))))
    }

    /**
     * The overlay seat: one entry per session in conversation.input.overlay.
     * It owns the open bit; the command's run(session) flips it through the
     * opener its mount effect registers (the ui-message-feedback dialog
     * placement pattern — the Modal portals from here, the overlay supplies
     * the per-session scope).
     * @param {any} props - the seat's composed props: the slot machinery's
     *   standard `useProjection` (session scope), the inject face's
     *   `sessionId`, and the locale seat's `t`.
     */
    function RosterModalSeat(props) {
      const { sessionId, t, useProjection } = props
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        const opener = () => { setOpen(true) }
        modalOpeners.set(sessionId, opener)
        return () => { if (modalOpeners.get(sessionId) === opener) modalOpeners.delete(sessionId) }
      }, [sessionId])
      return open ? h(RosterModal, { sessionId, close: () => { setOpen(false) }, t, useProjection }) : null
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
.agent-roster-team { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); border-radius: var(--dsw-radius-sm); }
.agent-roster-team-error { color: var(--dsw-alias-state-warn-primary); }
.agent-roster-team-actions { display: flex; gap: 8px; }
.agent-roster-templates { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto; }
.agent-roster-template { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; border: 1px solid transparent; border-radius: var(--dsw-radius-sm); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.agent-roster-template:hover { background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-template[aria-selected='true'] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-active); }
.agent-roster-template-name { font-size: 13px; font-weight: 600; }
.agent-roster-template-desc { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.agent-roster-input { box-sizing: border-box; width: 100%; font: inherit; font-size: 13px; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); padding: 6px 8px; }
.agent-roster-input:disabled { opacity: 0.6; }
.agent-roster-textarea { resize: vertical; min-height: 56px; }
.agent-roster-select { box-sizing: border-box; width: 100%; font: inherit; font-size: 12px; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); padding: 5px 6px; }
.agent-roster-select:disabled { opacity: 0.6; }
.agent-roster-effort { display: flex; flex-direction: column; gap: 4px; }
.agent-roster-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.agent-roster-custom-form { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); }
.agent-roster-draft-area { display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; border-bottom: 1px dashed var(--dsw-alias-border-l2); }
.agent-roster-draft-controls { display: flex; align-items: center; gap: 8px; }
.agent-roster-draft-controls .agent-roster-select { flex: 1; width: auto; }
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
