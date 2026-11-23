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
 * and the spawn modal's happy path. Task 7 completes the modal: the
 * custom-role form with save-as-template, the AI-draft area (fill-only
 * proposals), real model selection over the Host catalog, and the
 * team-gating banner states. Task 8 extracted the shared field/model
 * pieces for the manager UI; the 2026-11-23 UX rework moved that manager
 * from the Plugins-page card into a Settings page section and made the
 * AI-draft toggle + model a Settings-owned configuration.
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
 * - `settings.section` list slot, scope root — one Settings page entry
 *   (`{ id, order, label }` options; ui-settings contract/slots.ts:17-27,
 *   registration precedent ui-settings-models client/index.ts:143-152).
 *   With no `plugins.bundle.config` card of our own, the Plugins page
 *   shows this section's entry on the bundle row (settings shell
 *   contract). The AI-draft configuration (toggle + model) lives here;
 *   drafting itself needs a session, so its surface is the in-session
 *   "+"-menu modal (lib/drafter.js resolves the draft session's cwd from
 *   the requesting session).
 * - `configForms` client service (inject list; airboard client.js:770-774
 *   `ctx.configForms.get(<id>)` precedent) — the Settings block stages the
 *   volatile draft fields through the form's set/mutate (config-form.ts:
 *   109-133), and the modal reads the same snapshot live via subscribe.
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
      'model.inherit.clear': '继承当前会话模型（不用模板默认模型）',
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
      'draft.uses': '将使用 {model} 起草',
      'draft.configure.hint': 'AI 代笔未开启或未配置模型 — 请到 设置 > Agent roster 开启并选择模型。',
      'draft.elsewhere': 'AI 代笔请从会话中的“+”菜单使用（需要会话上下文）。',
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
      'settings.draft.title': 'AI 代笔',
      'settings.draft.toggle': '启用 AI 代笔',
      'settings.draft.model': '草稿模型',
      'settings.draft.model.unset': '未设置',
      'settings.draft.effort.default': '默认',
      'settings.draft.required': '已开启：请选择草稿模型。',
      'settings.draft.explain': '开启后，会话内“+”菜单的自定义角色表单即可 AI 起草；草稿在专用草稿会话中生成，使用此模型。',
      'settings.draft.loading': '设置读取中…',
      'settings.draft.writeRefused': '设置写入被拒绝',
      'settings.draft.writeFailed': '写入失败',
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
      'model.inherit.clear': 'Inherit the current session model (skip the template default)',
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
      'draft.uses': 'Drafts run on {model}',
      'draft.configure.hint': 'AI drafting is off or has no model — enable it in Settings > Agent roster.',
      'draft.elsewhere': 'AI drafting is available from the "+" menu inside a session (it needs a session context).',
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
      'card.model.chip.effort': '{provider} / {model} · {effort}',
      'card.updatedAt': 'Updated {time}',
      'settings.nav': 'Agent roster',
      'settings.draft.title': 'AI draft',
      'settings.draft.toggle': 'Enable AI-assisted drafting',
      'settings.draft.model': 'Draft model',
      'settings.draft.model.unset': 'Not configured',
      'settings.draft.effort.default': 'Default',
      'settings.draft.required': 'Enabled — pick a draft model.',
      'settings.draft.explain': 'When enabled, the custom-role form in a session\'s "+" menu offers AI drafting; drafts run in the dedicated draft session on this model.',
      'settings.draft.loading': 'Loading settings…',
      'settings.draft.writeRefused': 'The settings write was refused',
      'settings.draft.writeFailed': 'Write failed',
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

    /**
     * The plugin's own Config form, staged through the settings mutate path
     * (airboard client.js:770-774 precedent: `ctx.configForms.get(<ns>)`;
     * `configForms` is in the inject list). CRITICAL: the settings
     * namespace is the LOADER ROW id from cordis.patch.yml —
     * `ns: entry.options.id` (dsh packages/settings/settings/src/index.ts:
     * 315,327) — NOT the package name: the 2026-11-23 "Loading settings…"
     * incident came from keying the package name (dsh-agent-roster), whose
     * mirror never becomes ready. Undefined while the host exposes no
     * settings surface — every consumer degrades, never crashes.
     */
    const SETTINGS_NS = 'agent-roster'
    const rosterForm = () => {
      try { return pluginCtx?.get?.('configForms')?.get?.(SETTINGS_NS) } catch { return undefined }
    }

    /**
     * Unwrap one config-form snapshot value: the mirror delivers plain JSON,
     * but defensive wrapper-tolerance matches the host-side readString rule.
     */
    const configValue = (value) => (typeof value?.get === 'function' ? value.get() : value)

    /**
     * Read the Settings-owned AI-draft configuration from the form snapshot.
     * @returns {{ phase: 'loading' | 'ready', enabled?: boolean, modelRef?: { provider: string, model: string, reasoningEffort?: string } | null }}
     */
    const draftSettingsOf = () => {
      const form = rosterForm()
      const snapshot = form?.getSnapshot?.()
      if (snapshot?.status !== 'ready' || snapshot.value === null || typeof snapshot.value !== 'object') {
        return { phase: 'loading' }
      }
      const value = snapshot.value
      const provider = configValue(value.draftModelProvider)
      const modelId = configValue(value.draftModelId)
      const effort = configValue(value.draftReasoningEffort)
      const modelRef = typeof provider === 'string' && provider !== ''
        && typeof modelId === 'string' && modelId !== ''
        ? { provider, model: modelId, ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}) }
        : null
      return { phase: 'ready', enabled: configValue(value.draftEnabled) === true, modelRef }
    }

    /**
     * React hook over draftSettingsOf: re-reads on every form snapshot
     * change (form.subscribe, the ConfigForm mirror contract) so a Settings
     * edit is live in an open modal.
     * @returns {ReturnType<typeof draftSettingsOf>}
     */
    function useDraftSettings() {
      const [settings, setSettings] = React.useState(draftSettingsOf)
      React.useEffect(() => {
        setSettings(draftSettingsOf())
        const form = rosterForm()
        const off = form?.subscribe?.(() => { setSettings(draftSettingsOf()) })
        return () => { off?.() }
      }, [])
      return settings
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
    // Parameter codecs must be STRICT, not src-json: the gateway's mount
    // validation rejects any parameter whose codec mode is not 'strict'
    // (dsh packages/api/gateway/src/client/index.ts validateContribution
    // :283-330 → requireStrictInputs :299-303 → requireStrictCodec :341-346;
    // 'src-json' is legal for RESULTS only — chrome-cdp's zero-parameter
    // status() mount never exercised this). After validation the invoke path
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

    // -------------------------------------------------------------------------
    // Shared building blocks (Task 8 extraction): the modal of Tasks 6-7 and
    // the Plugins-page card of Task 8 render the same role fields, the same
    // ModelRef selector, and run the same client-side draft wait — extracted
    // here once instead of being duplicated per surface.
    // -------------------------------------------------------------------------

    /**
     * The Host model catalog as flat selector rows, loaded once per consumer
     * (modal open / card form mount). The session face may be absent or fail
     * (older host, provider outage): rows degrade to [] — callers offer the
     * default entry only and never block on the catalog (Task 6 review
     * note 4).
     * @returns {{ rows: Array<object> }} the flat rows (`key` is the JSON
     *   [provider, model] pair).
     */
    function useModelRows() {
      const [catalog, setCatalog] = React.useState({ phase: 'loading' })
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
      const openRef = React.useRef(false)
      openRef.current = open

      // Outside pointerdown closes (host closeOutside pattern: pointerdown
      // covers WebKit taps; the portal subtree counts as inside).
      React.useEffect(() => {
        // Environments without a DOM (the test harness renders without one)
        // simply skip the outside-close wiring; the host page always has it.
        if (!open || typeof document === 'undefined') return undefined
        const closeOutside = (event) => {
          if (rootRef.current !== null && event !== undefined && typeof event.target === 'object'
            && event.target !== null && typeof rootRef.current.contains === 'function'
            && rootRef.current.contains(event.target)) return
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
            const effortRows = (chosen?.efforts ?? []).map((item) => ({ key: String(item?.id ?? ''), label: String(item?.name ?? item?.id ?? '') }))
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
     * The shared role fields — name, description, prompt — of the modal's
     * custom-role form (Tasks 6-7) and the card's template add/edit forms
     * (Task 8). Controlled and hook-free; `idPrefix` namespaces the
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
     * The client-side draft wait shared by the modal's AI-draft area and the
     * card's draft entry. `epoch` is the liveness token that lets an
     * abandoned wait discard its late resolution; the mounted draft method
     * declares no transport cancellation (lib/roster-service.js `draft(
     * input)`, no signal parameter), so abort abandons the CLIENT wait only.
     * The Host shares ONE draft session per workspace (ADR-0010), so a new
     * start is refused while one runs.
     * @param {(key: string, params?: object) => string} t - the locale seat.
     * @returns {{ draft: object, drafting: boolean, start: (input: object)
     *   => Promise<void>, abort: () => void }}
     */
    function useDraftFlow(t) {
      const [draft, setDraft] = React.useState({ epoch: 0, phase: 'idle', result: null })
      const drafting = draft.phase === 'drafting'
      const start = async (input) => {
        if (drafting) return
        const briefText = typeof input?.brief === 'string' ? input.brief.trim() : ''
        if (briefText === '') return
        const ns = rosterNs()
        if (ns?.draft === undefined) {
          setDraft((prev) => ({ ...prev, epoch: prev.epoch + 1, phase: 'idle', result: { ok: false, error: { code: 'roster/unavailable', message: t('templates.unavailable') } } }))
          return
        }
        const epoch = draft.epoch + 1
        setDraft({ epoch, phase: 'drafting', result: null })
        try {
          const value = await settle(ns.draft({ ...input, brief: briefText }))
          setDraft((prev) => (prev.epoch === epoch ? { ...prev, phase: 'idle', result: { ok: true, value } } : prev))
        } catch (error) {
          setDraft((prev) => (prev.epoch === epoch ? { ...prev, phase: 'idle', result: { ok: false, error } } : prev))
        }
      }
      const abort = () => {
        if (!drafting) return
        setDraft((prev) => ({ ...prev, epoch: prev.epoch + 1, phase: 'idle', result: { ok: false, aborted: true } }))
      }
      return { draft, drafting, start, abort }
    }

    /** The flat-row key of one stored ModelRef, or null when malformed. */
    const refKey = (ref) => ref !== null && typeof ref === 'object'
      && typeof ref.provider === 'string' && typeof ref.model === 'string'
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
     * derivation inside RosterModal). The draft model is NOT chosen here:
     * the Settings > Agent roster page owns the toggle and the model
     * (2026-11-23 UX ruling) — this area states which model a draft will
     * use and points at Settings while the feature is off or unconfigured.
     * @param {any} props - `sessionId`, `close()`, the locale seat's `t`.
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
      // Model catalog + choices: '' is the inherit default.
      const { rows: modelRows } = useModelRows()
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
      // The Settings-owned AI-draft configuration (toggle + model), read
      // live from the config form — the host re-validates on every draft.
      const draftSettings = useDraftSettings()
      // The shared client-side draft wait (epoch-guarded, abortable).
      const { draft, drafting, start: startDraftFlow, abort: abortDraft } = useDraftFlow(t)

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
        settle(ns.listTemplates()).then(
          (value) => { if (alive) setTemplates({ phase: 'ready', list: Array.isArray(value) ? value : [] }) },
          (error) => { if (alive) setTemplates({ phase: 'failed', error }) },
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
      // The template behind the current selection: its optional defaultModel
      // (SPEC) drives the spawn selector's prefill and the default entry's
      // truthful copy. Null in custom-only states and for templates without
      // one; a malformed stored ref counts as absent (refKey null).
      const selectedTemplate = list.find((tpl) => tpl.id === effectiveId) ?? null
      const templateDefault = selectedTemplate?.defaultModel ?? null
      const templateHasDefault = refKey(templateDefault) !== null
      // Custom-role fields (trimmed; the Host re-validates anyway) gate the
      // confirm exactly like a selectable template does.
      const customNameText = customName.trim()
      const customDescriptionText = customDescription.trim()
      const customPromptText = customPrompt.trim()
      const customComplete = customNameText !== '' && customPromptText !== ''
      const canConfirm = custom ? customComplete : effectiveId !== null

      // Flat catalog rows keyed by JSON [provider, model]; empty when the
      // catalog degraded — the selector then offers the inherit entry only.
      const modelByKey = rowsByKey(modelRows)
      // Lossless spawn rows: the selected template's default rides as a
      // synthetic row when the catalog does not carry it (the settings
      // editor's rowsWithRef machinery), so the prefill maps and an
      // untouched open→confirm round-trip sends the stored ref whole.
      const spawnRows = React.useMemo(() => rowsWithRef(modelRows, templateDefault), [modelRows, templateDefault])
      const spawnByKey = rowsByKey(spawnRows)
      const chosen = modelChoice === '' ? undefined : spawnByKey.get(modelChoice)

      // SPEC — a template's optional defaultModel pre-fills the model
      // selector. The prefill follows the SELECTION (it re-applies whenever
      // another template becomes effective, so the selector always tells
      // the truth about what will spawn); an explicit user choice after a
      // selection wins until the selection changes again. Toggling the
      // custom form does not touch the selection, so whatever the selector
      // shows stays — visible, and therefore truthful — for custom spawns
      // too.
      React.useEffect(() => {
        setModelChoice(templateHasDefault ? refKey(templateDefault) : '')
        setEffortChoice(templateHasDefault && typeof templateDefault.reasoningEffort === 'string' ? templateDefault.reasoningEffort : '')
      }, [effectiveId])

      const modelRef = modelRefOf(chosen, effortChoice)
      // A draft runs only when Settings enabled it AND configured a model
      // (the user's 2026-11-23 ruling: enabling requires picking a model);
      // otherwise the area shows the configure-first hint.
      const draftEligible = draftSettings.phase === 'ready' && draftSettings.enabled === true && draftSettings.modelRef !== null

      /**
       * Start one AI draft over the shared wait (useDraftFlow carries the
       * one-draft-session-per-workspace boundary and the epoch guard): the
       * model is the Settings-configured one (host-side resolution — the
       * modal sends none of its own), and the result is a PROPOSAL that
       * fills the custom form below; nothing is saved without the explicit
       * confirm.
       */
      const startDraft = () => { startDraftFlow({ sessionId, brief, model: null }) }

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
      // routes through onClose) is gated while a spawn, draft, or team
      // action is in flight: closing would drop the in-flight result,
      // invite a duplicate spawn into the shared tree, or strand a team
      // write's refresh (Task 6 review note 1; team-busy per the whole-
      // branch review).
      const guardedClose = () => { if (!spawning && !drafting && !teamBusy) close() }

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
          disabled: spawning || drafting || teamBusy,
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
        // The shared ModelRef editor (Task 8 extraction): for a template
        // with a defaultModel the default entry's copy names what reverting
        // really does — null is an EXPLICIT CLEAR of that default
        // (lib/spawn.js:210-216 precedence); without one (or in custom
        // mode) it stays the plain inherit copy. The optional effort input
        // appears only beside an explicit choice of a model that advertises
        // efforts.
        h(ModelRefEditor, {
          section: 'model',
          id: 'agent-roster-model',
          marker: 'data-agent-roster-model',
          noneMarker: 'inherit',
          label: t('model.label'),
          defaultLabel: !custom && templateHasDefault ? t('model.inherit.clear') : t('model.inherit'),
          effortLabel: t('model.effort.label'),
          effortDefaultLabel: t('model.effort.default'),
          rows: spawnRows,
          byKey: spawnByKey,
          choice: modelChoice,
          onChoice: (value) => { setModelChoice(value); setEffortChoice('') },
          effort: effortChoice,
          onEffort: setEffortChoice,
        }),
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
                // Which model a draft will use — the Settings-configured
                // one; never a per-draft choice (2026-11-23 UX ruling).
                h('span', {
                  className: 'agent-roster-note',
                  'data-agent-roster-draft-model-line': draftEligible ? 'ready' : 'configure',
                }, draftEligible
                  ? t('draft.uses', { model: draftSettings.modelRef.model })
                  : t('draft.configure.hint')),
                h('button', {
                  type: 'button',
                  className: 'agent-roster-button',
                  'data-agent-roster-draft': '',
                  disabled: !draftEligible || brief.trim() === '' || drafting,
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
            // The shared role fields (Task 8 extraction — the card's
            // add/edit forms render the same components).
            h(RoleFields, {
              t,
              idPrefix: 'agent-roster',
              name: customName,
              description: customDescription,
              prompt: customPrompt,
              onName: setCustomName,
              onDescription: setCustomDescription,
              onPrompt: setCustomPrompt,
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

    // -------------------------------------------------------------------------
    // Task 8 — the Plugins-page settings card (roster manager).
    // -------------------------------------------------------------------------

    /**
     * The roster manager body: the template list with per-row edit/delete
     * and the add button, or one open editor form. Rendered inside the
     * Settings section below the AI-draft block. Every write goes through
     * the module-level rosterNs() lookup; failures render bilingual
     * reasons and the list re-reads after each successful write.
     */
    /**
     * The Settings > Agent roster page body (2026-11-23 UX ruling): part
     * one is the AI-draft configuration (toggle + the draft model this
     * profile's drafts run on — enabling REQUIRES a model, the modal never
     * picks one per-draft); part two is the roster manager below it.
     * `configForms` is in the inject list (airboard precedent); a missing
     * form degrades the block to its loading note, never a crash.
     */
    function DraftSettingsBlock({ t }) {
      const settings = useDraftSettings()
      const { rows } = useModelRows()
      const [writeError, setWriteError] = React.useState(null)
      const currentKey = settings.phase === 'ready' && settings.modelRef !== null
        ? refKey(settings.modelRef)
        : null
      const currentRow = currentKey === null ? undefined : rowsByKey(rows).get(currentKey)

      /** Stage one write; a refused write surfaces its bilingual reason. */
      const write = async (operation) => {
        const form = rosterForm()
        try {
          const accepted = await operation(form)
          if (accepted !== true) setWriteError({ code: 'roster/settings-write-refused', message: t('settings.draft.writeRefused') })
          else setWriteError(null)
        } catch (error) {
          setWriteError(error)
        }
      }

      const toggleDraft = () => {
        if (settings.phase !== 'ready') return
        void write((form) => form.set('draftEnabled', settings.enabled !== true))
      }
      const chooseModel = (event) => {
        const value = event.target.value
        if (value === '') {
          void write((form) => form.mutate([
            { op: 'set', path: ['draftModelProvider'], value: '' },
            { op: 'set', path: ['draftModelId'], value: '' },
            { op: 'set', path: ['draftReasoningEffort'], value: '' },
          ]))
          return
        }
        const row = rowsByKey(rows).get(value)
        if (row === undefined) return
        void write((form) => form.mutate([
          { op: 'set', path: ['draftModelProvider'], value: row.provider },
          { op: 'set', path: ['draftModelId'], value: row.model },
          { op: 'set', path: ['draftReasoningEffort'], value: '' },
        ]))
      }
      const chooseEffort = (event) => {
        const value = event.target.value
        void write((form) => form.set('draftReasoningEffort', value))
      }

      const efforts = currentRow?.efforts ?? []
      const currentEffort = settings.phase === 'ready' && settings.modelRef !== null
          && typeof settings.modelRef.reasoningEffort === 'string'
        ? settings.modelRef.reasoningEffort
        : ''

      return h('div', { className: 'agent-roster-settings-draft', 'data-agent-roster-settings-draft': '' },
        h('div', { className: 'agent-roster-card-head' },
          h('span', { className: 'agent-roster-label' }, t('settings.draft.title'))),
        settings.phase !== 'ready'
          ? h('div', { className: 'agent-roster-note', 'data-agent-roster-note': 'loading' }, t('settings.draft.loading'))
          : h('div', { className: 'agent-roster-settings-draft-row' },
            h('label', { className: 'agent-roster-custom-toggle-row' },
              h('input', {
                type: 'checkbox',
                role: 'switch',
                'aria-checked': settings.enabled === true ? 'true' : 'false',
                'data-agent-roster-draft-toggle': '',
                checked: settings.enabled === true,
                onChange: toggleDraft,
              }),
              h('span', {}, t('settings.draft.toggle'))),
            h('label', { className: 'agent-roster-label', htmlFor: 'agent-roster-draft-model-setting' }, t('settings.draft.model')),
            h(ModelMenu, {
              marker: 'data-agent-roster-draft-model-setting',
              markerValue: currentKey ?? 'unset',
              value: currentKey ?? '',
              noneLabel: t('settings.draft.model.unset'),
              groups: catalogGroups(rows),
              onPick: (key) => { chooseModel({ target: { value: key } }) },
              ariaLabel: t('settings.draft.model'),
              triggerClass: 'agent-roster-menu-trigger-form',
            }),
            h(ModelMenu, {
              marker: 'data-agent-roster-draft-effort-setting',
              markerValue: currentEffort,
              value: currentEffort,
              noneLabel: t('settings.draft.effort.default'),
              groups: null,
              rows: efforts.map((effort) => ({ key: effort.id, label: effort.name ?? effort.id })),
              onPick: (key) => { chooseEffort({ target: { value: key } }) },
              disabled: efforts.length === 0,
              ariaLabel: t('settings.draft.model'),
              triggerClass: 'agent-roster-menu-trigger-form',
            }),
            settings.enabled === true && settings.modelRef === null
              ? h('div', { className: 'agent-roster-note agent-roster-error', 'data-agent-roster-draft-required': '' }, t('settings.draft.required'))
              : null,
            writeError !== null
              ? h('div', { className: 'agent-roster-note agent-roster-error', 'data-agent-roster-error': typeof writeError?.code === 'string' ? writeError.code : '' },
                h('span', { className: 'agent-roster-error-label' }, t('settings.draft.writeFailed')),
                errorDetail(writeError))
              : null),
        h('div', { className: 'agent-roster-note' }, t('settings.draft.explain')))
    }

    /**
     * The settings.section entry: renders through the Settings page's
     * `settings.section.view` factory with `{ id, close }` owner props
     * (ui-settings contract/slots.ts:17-27) — no `view` gate and no session
     * identity. The body is the AI-draft block plus the roster manager.
     * @param {any} props - the section view props; the bound locale `t`
     *   comes from the registration's `locale` option.
     */
    function RosterSettingsSection(props) {
      const { t } = props
      return h('div', { className: 'agent-roster-settings', 'data-agent-roster-settings': '' },
        h(DraftSettingsBlock, { t }),
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
     * The card's add/edit form: the add-mode AI-draft entry above the shared
     * RoleFields and the shared ModelRefEditor (default = no default model).
     * Saves go through saveTemplate — `id` on edit, none on add — with the
     * full explicit field set (patch semantics not relied upon, so clearing
     * a field actually clears it); a failure stays in-form with its
     * bilingual reason, a success closes the form and refreshes the list.
     * @param {any} props - `mode` ('add' | 'edit'), `template` (edit only),
     *   `t`, `sessionId` (usually absent — gates the draft entry),
     *   `close()`, `saved()`.
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

      // The add form carries no AI-draft entry: drafting needs a session
      // for the draft session's cwd, so the + menu in a session is the
      // drafting surface (2026-11-23 UX ruling) — this hint says so.
      const draftHint = mode !== 'add' ? null : h('div', {
        className: 'agent-roster-note',
        'data-agent-roster-card-draft-hint': '',
      }, t('draft.elsewhere'))

      return h('div', { className: 'agent-roster-card-form', 'data-agent-roster-card-form': '' },
        h('div', { className: 'agent-roster-card-head' },
          h('span', { className: 'agent-roster-label' }, mode === 'edit' ? t('card.edit') : t('card.add'))),
        draftHint,
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

    /** Scoped sheet, appended once per activation and removed with the plugin. */
    // Styles follow the HOST's native settings controls, copied and
    // renamed under this plugin's prefix (practices.md: copy markup, CSS,
    // and behavior from the host control; keep only --dsw-alias-* tokens):
    // - field rhythm, label, input, hint  — ui-primitives
    //   settings-form/fields.module.css (.field 12px 0 + 6px gap + hairline
    //   separators; .label 13px/500/1.5; .input height 34px, padding 0 12px,
    //   0.5px border-l4, radius md, bg layer-3, 13px/1.5, focus border
    //   business-primary, disabled label-tertiary) and ConfigField.module.css
    //   (textarea padding 6px 12px, resize vertical).
    // - buttons — ui-primitives Button.module.css (sm 28px, radius sm,
    //   ghost hover interactive-bg-hover, disabled 0.4) and
    //   settings-form/SettingsForm.module.css (.save primary fill 5px 14px,
    //   focus ring).
    // Styles follow the HOST's native settings controls, copied and renamed
    // under this plugin's prefix (practices.md: copy markup, CSS, and
    // behavior from the host control; keep only --dsw-alias-* tokens):
    // - field rhythm/label/input/hint — ui-primitives settings-form/
    //   fields.module.css (.field 12px 0 + 6px gap + 0.5px hairline
    //   separators; .label 13px/500/1.5; .input height 34px, padding
    //   0 12px, 0.5px border-l4, radius md, bg layer-3, focus border
    //   business-primary, disabled label-tertiary) and ConfigField.module.css
    //   (textarea padding 6px 12px, resize vertical).
    // - buttons — ui-primitives Button.module.css (sm 28px, radius sm, ghost
    //   hover interactive-bg-hover, disabled 0.4) and settings-form/
    //   SettingsForm.module.css (.save primary fill, focus ring).
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
.agent-roster-team { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); border-radius: var(--dsw-radius-md); }
.agent-roster-team-error { color: var(--dsw-alias-label-error); }
.agent-roster-team-actions { display: flex; gap: 8px; }
.agent-roster-templates { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto; }
.agent-roster-template { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border: 0.5px solid transparent; border-radius: var(--dsw-radius-md); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.agent-roster-template:hover { background: var(--dsw-alias-interactive-bg-hover); }
.agent-roster-template[aria-selected='true'] { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-active); }
.agent-roster-template-name { font-size: 13px; font-weight: 500; line-height: 1.5; }
.agent-roster-template-desc { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.agent-roster-input { box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); }
.agent-roster-input:focus-visible, .agent-roster-select:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.agent-roster-input:disabled, .agent-roster-select:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.agent-roster-textarea { height: auto; min-height: 56px; padding: 6px 12px; resize: vertical; }
.agent-roster-select { box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); }
.agent-roster-effort { display: flex; flex-direction: column; gap: 6px; }
.agent-roster-toggle, .agent-roster-custom-toggle-row { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }
.agent-roster-custom-form { display: flex; flex-direction: column; gap: 6px; padding: 12px 0 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.agent-roster-draft-area { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.agent-roster-draft-controls { display: flex; align-items: center; gap: 8px; }
.agent-roster-draft-controls .agent-roster-select { flex: 1; width: auto; }
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
[data-agent-roster-settings-draft] { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.agent-roster-settings-draft-row { display: flex; flex-direction: column; gap: 6px; }
[data-agent-roster-settings] .agent-roster-settings-draft-row .agent-roster-select { width: auto; }
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
      inject: ['commandUi', 'configForms', 'locale', 'slots', 'remote'],
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
