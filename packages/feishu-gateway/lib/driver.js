// lib/driver.js
/**
 * Session orchestration: inbound messages and card actions in, assistant
 * output and previews out. Owns no transport — the caller wires normalized
 * events to handleInbound/handleCardAction/onSessionEvent.
 *
 * Host API surface this module relies on (verified against the dsh checkout):
 * - Agent.followup(input: UserMessage) / Agent.steer(input: UserMessage)
 *   (packages/core/agent-loop/src/agent.ts)
 * - Agent.cancel(cause: AgentCancelCause) with cause { kind: 'user' }
 *   (packages/core/agent-loop/src/agent.ts)
 * - Session.deriveMessages(): Message[] and Session.requestHeader()
 *   (packages/core/session/src/index.ts)
 * - ctx.sessionTitle.get(session) → { title } snapshot
 *   (packages/session/session-title/src/index.ts)
 * - ctx.workspaceChanges.summary(sessionId, seq) /
 *   .diff(sessionId, seq, index) (packages/deliverables/workspace-changes/src/types.ts)
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { open as openFile, readdir } from 'node:fs/promises'
import { parseCommand, guardDecision, translateGuardError, HELP_TEXT } from './commands.js'
import { formatAndSendText, buildStatusCard, renderChangesCard, renderDiffMessage, renderDiffBody, buildPostContent } from './formatter.js'

const FEISHU_SOURCE = 'feishu'

/**
 * The real createUserMessage from '@deepseek-ai/dsh-llm' when the host peer
 * package resolves (it does inside dsh; webhook src/session.ts uses it). The
 * local fallback replicates its exact output shape: a frozen message with a
 * fresh uuid identity, role 'user', content blocks, and the source object.
 */
let hostCreateUserMessage = undefined
import('@deepseek-ai/dsh-llm')
  .then(m => { if (typeof m?.createUserMessage === 'function') hostCreateUserMessage = m.createUserMessage })
  .catch(() => { /* standalone/test context: the local fallback below is used */ })

/** Build the UserMessage object followup/steer expect (webhook template shape). */
function makeUserMessage(text, source) {
  const content = [{ type: 'text', text }]
  if (hostCreateUserMessage !== undefined) return hostCreateUserMessage({ content, source })
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ ...content[0] }]),
    source,
  })
}

/**
 * The final assistant text of a turn, read from the REAL session surface:
 * deriveMessages() returns the model-visible Message[] in order, so the last
 * assistant message's text blocks are the turn's answer. `event` (turn/end)
 * carries only { turn, reason } — no message payload — so the session is the
 * source. Graceful '' when the surface is unavailable or holds no assistant
 * message.
 */
export function lastAssistantText(session, _event) {
  const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : undefined
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    return (message.content ?? [])
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}

export class GatewayDriver {
  /** @param {{ ctx: any, lark: any, router: any, config: any, logger?: any, makeActionId?: () => string, answererCallback?: Function, listBindings?: () => Iterable<any> }} options */
  constructor({ ctx, lark, router, config, logger, makeActionId = (() => { let n = 0; return () => `act_${++n}` })(), answererCallback, listBindings }) {
    this.ctx = ctx
    this.lark = lark
    this.router = router
    this.config = config
    this.logger = logger
    this.makeActionId = makeActionId
    this.answererCallback = answererCallback ?? (() => {})
    this.listBindings = listBindings
  }

  // --- inbound ---

  async handleInbound(message) {
    // Normalizer output funnels through here: card actions route to their own handler.
    if (message.kind === 'card-action') return this.handleCardAction(message)
    if (message.kind !== 'message') return
    const cmd = parseCommand(message.text, this.config.commandPrefix)
    if (cmd !== null) return this.runCommand(cmd, message)
    return this.deliverTask(message)
  }

  async runCommand(cmd, message) {
    const { chatId } = message
    try {
      switch (cmd.name) {
        case 'help': return void this.lark.sendText(chatId, HELP_TEXT)
        case 'status': return void this.sendStatus(chatId)
        case 'stop': {
          const agent = await this.activeAgent(chatId)
          // Real cancellation API (agent-loop src/agent.ts): cancel(cause, options).
          // interrupt() stays only as a fallback guard for agents without it.
          if (agent === undefined) return void this.sendStatus(chatId)
          if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
          else agent?.interrupt?.()
          return void this.sendStatus(chatId)
        }
        case 'ws': return this.runWs(cmd, message)
        case 'session': return this.runSession(cmd, message)
        case 'model': return this.runModel(cmd, message)
        default: return void this.lark.sendText(chatId, `未知命令，试试：\n${HELP_TEXT}`)
      }
    } catch (error) {
      this.logger?.warn?.(`feishu-gateway: command failed: ${String(error)}`)
      return void this.lark.sendText(chatId, translateGuardError(error))
    }
  }

  async runWs(cmd, message) {
    const { chatId } = message
    if (cmd.sub === 'list') {
      const list = this.ctx.workspaceRegistry.list().map(w => `- **${w.title}**（\`${w.path}\`）`).join('\n')
      return void this.lark.sendJson(chatId, 'post', buildPostContent(`工作区：\n${list}`))
    }
    if (cmd.sub === 'use') {
      // Pointer switch only: no guard, any running session keeps running.
      const title = cmd.args[0]
      const ws = this.ctx.workspaceRegistry.list().find(w => w.title === title || w.id === title)
      if (ws === undefined) return void this.lark.sendText(chatId, `没有叫「${title ?? ''}」的工作区，/ws list 看看。`)
      await this.router.bind(chatId, { workspaceId: ws.id, workspaceTitle: ws.title, workspacePath: ws.path })
      return void this.sendStatus(chatId)
    }
    if (cmd.sub === 'new') {
      const path = cmd.args[0]
      if (path === undefined) return void this.lark.sendText(chatId, '用法：/ws new <绝对路径> [标题]')
      const guard = guardDecision({ running: await this.isRunning(chatId) })
      if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
      const ws = await this.ctx.workspaceRegistry.create(path, cmd.args[1])
      await this.router.bind(chatId, { workspaceId: ws.id, workspaceTitle: ws.title, workspacePath: ws.path })
      return void this.sendStatus(chatId)
    }
    return void this.lark.sendText(chatId, `用法：/ws list | use <名称> | new <路径> [标题]`)
  }

  async runSession(cmd, message) {
    const { chatId } = message
    const binding = await this.router.get(chatId)
    if (binding === undefined) return void this.lark.sendText(chatId, '先 /ws use 绑定一个工作区。')
    if (cmd.sub === 'new') {
      const guard = guardDecision({ running: await this.isRunning(chatId) })
      if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
      await this.openSession(chatId, binding)
      return void this.sendStatus(chatId)
    }
    if (cmd.sub === 'list') return this.sessionList(chatId, binding, Number(cmd.args[0]) || 1)
    if (cmd.sub === 'resume') {
      // Direct form /session resume <id|id前缀|最新优先序号>: resume without
      // the picker card. Bare /session resume still shows the picker.
      if (cmd.args.length > 0) {
        const target = await this.resolveSessionArg(cmd.args[0], binding)
        if (target === undefined) return void this.lark.sendText(chatId, '没有匹配的会话：可传完整/前缀 sessionId，或 /session list 里的序号。')
        return this.resumeSession(chatId, target)
      }
      const history = await this.router.history(chatId)
      if (history.length === 0) return void this.lark.sendText(chatId, '没有可恢复的历史会话；/session list 看工作区全部会话。')
      const actions = history.slice(0, 10).map(e => ({
        tag: 'button', text: { tag: 'plain_text', content: e.title ?? e.sessionId }, type: 'default',
        value: { actionId: this.makeActionId(), kind: 'resume', sessionId: e.sessionId, title: e.title },
      }))
      return void this.lark.sendJson(chatId, 'interactive', {
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: '恢复哪个会话？' }, template: 'blue' },
        elements: [{ tag: 'action', actions }],
      })
    }
    return void this.lark.sendText(chatId, '用法：/session new | list [页码] | resume [sessionId|序号]')
  }

  /** Sessions of the bound workspace, most recently ACTIVE first. The
   * workspace registry's sessionIds is the authoritative owner list
   * (canonical-cwd filtered); sessionController.list() supplies each
   * session's updatedAt — log activity combined with lastPromptAt, the same
   * "recent" ordering the GUI sidebar uses (createdAt ordering felt wrong:
   * an old session you just used stayed buried). */
  async workspaceSessions(binding) {
    const workspace = this.ctx.workspaceRegistry.list().find(w => w.id === binding.workspaceId)
    const ids = new Set(workspace?.sessionIds ?? [])
    let summaries = []
    try {
      // Real API returns SessionListValue { items: SessionSummary[] } — a
      // bare-array assumption made summaries.map throw and (through the
      // loader's error path) killed the whole host.
      const value = await this.ctx.sessionController.list({})
      summaries = Array.isArray(value) ? value : (value?.items ?? [])
    } catch { /* degrade to query headers below */ }
    const byId = new Map(summaries.map(s => [s.sessionId, s]))
    const records = summaries.length > 0 ? [] : await this.ctx.sessionQuery.listSessions().catch(() => [])
    const recordById = new Map(records.map(r => [r.header.id, r]))
    return [...ids].map(id => ({
      header: { id, createdAt: byId.get(id)?.updatedAt ?? recordById.get(id)?.header.createdAt },
      updatedAt: byId.get(id)?.updatedAt,
      live: byId.get(id)?.agentAvailable === true || recordById.get(id)?.live === true,
    })).sort((a, b) => (b.updatedAt ?? b.header.createdAt ?? 0) - (a.updatedAt ?? a.header.createdAt ?? 0))
  }

  /** One-line relative time for list rows (北京时间, 手机上可扫读). */
  static relativeTime(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return ''
    const diff = Date.now() - ts
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
    return new Date(ts).toLocaleDateString('zh-CN')
  }

  /** lark_md-safe single-line text (no markdown metachars, no newlines). */
  static listSafe(text, max = 40) {
    return String(text ?? '').replace(/[\`*_~\[\]()#@!>\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  }

  /** Render one page (10/page) of the workspace's sessions as a list card:
   * div rows carry title + relative time, short number buttons select (ids
   * stay hidden), prev/next buttons page without typing. */
  async sessionList(chatId, binding, page) {
    const sessions = await this.workspaceSessions(binding)
    if (sessions.length === 0) return void this.lark.sendText(chatId, '该工作区还没有会话；发消息或 /session new 开一个。')
    const PAGE = 10
    const pages = Math.ceil(sessions.length / PAGE)
    page = Math.min(Math.max(1, page), pages)
    const slice = sessions.slice((page - 1) * PAGE, page * PAGE)
    // Batch title read covers NON-live sessions too (the title folds from
    // each session's own log: sessionQuery.readTitleSnapshots observes live
    // or persisted sessions alike — that is where the GUI sidebar's archived
    // titles come from). The live snapshot stays as a fresher fallback.
    const titles = new Map()
    try {
      const observations = await this.ctx.sessionQuery.readTitleSnapshots?.(slice.map(r => r.header.id))
      for (const o of observations ?? []) {
        if (o?.status === 'fulfilled' && o.value?.title?.title !== undefined) titles.set(o.value.session.id, o.value.title.title)
      }
    } catch { /* titles are an enhancement, never a blocker */ }
    const rows = slice.map((r, i) => {
      const agentSession = this.ctx.agents.get(r.header.id)?.session
      const title = GatewayDriver.listSafe(titles.get(r.header.id) ?? this.sessionTitleSnapshot(agentSession)?.title) || '（无标题会话）'
      const when = GatewayDriver.relativeTime(r.updatedAt ?? r.header.createdAt)
      const marks = `${r.header.id === binding.activeSessionId ? ' **[当前]**' : ''}${r.live ? ' ⏺' : ''}`
      return { tag: 'div', text: { tag: 'lark_md', content: `**${String((page - 1) * PAGE + i + 1)}.** ${title}${when === '' ? '' : ` · ${when}`}${marks}` } }
    })
    const pick = slice.map((r, i) => ({
      tag: 'button', text: { tag: 'plain_text', content: String(i + 1) }, type: 'default',
      value: { actionId: this.makeActionId(), kind: 'resume', sessionId: r.header.id, title: '' },
    }))
    const nav = []
    if (page > 1) nav.push({ tag: 'button', text: { tag: 'plain_text', content: '上一页' }, type: 'default', value: { actionId: this.makeActionId(), kind: 'session-page', page: page - 1 } })
    if (page < pages) nav.push({ tag: 'button', text: { tag: 'plain_text', content: '下一页' }, type: 'default', value: { actionId: this.makeActionId(), kind: 'session-page', page: page + 1 } })
    return void this.lark.sendJson(chatId, 'interactive', {
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: `${binding.workspaceTitle} · 会话 ${String(page)}/${String(pages)}（共 ${String(sessions.length)}）` }, template: 'blue' },
      elements: [
        ...rows,
        { tag: 'hr' },
        { tag: 'action', actions: pick.slice(0, 5) },
        ...(pick.length > 5 ? [{ tag: 'action', actions: pick.slice(5) }] : []),
        ...(nav.length > 0 ? [{ tag: 'action', actions: nav }] : []),
        { tag: 'note', elements: [{ tag: 'plain_text', content: '⏺ 进行中 · 按编号恢复 · 也可 /session resume <序号|sessionId前缀>' }] },
      ],
    })
  }

  /** Resolve a /session resume argument: exact id, id prefix, or 1-based newest-first index. */
  async resolveSessionArg(arg, binding) {
    const sessions = await this.workspaceSessions(binding)
    const exact = sessions.find(r => r.header.id === arg)
    if (exact !== undefined) return exact
    const index = Number(arg)
    if (Number.isInteger(index) && index >= 1 && index <= sessions.length) return sessions[index - 1]
    const prefixed = sessions.filter(r => String(r.header.id).startsWith(arg))
    return prefixed.length === 1 ? prefixed[0] : undefined
  }

  /** Guarded resume + pointer switch + status card, then the last turn's
   * assistant output so the user recalls what this session was about. */
  async resumeSession(chatId, target, title) {
    const guard = guardDecision({ running: await this.isRunning(chatId) })
    if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
    const resumed = await this.resumeAgent(target.header.id)
    if (resumed.error !== undefined) return void this.lark.sendText(chatId, resumed.error)
    const { agent } = resumed
    await this.router.setActive(chatId, target.header.id, title ?? this.sessionTitleSnapshot(agent?.session)?.title)
    await this.sendStatus(chatId)
    const last = lastAssistantText(agent?.session)
    if (last !== '') {
      const recall = `📎 上一轮输出：\n${last.slice(0, 600)}${last.length > 600 ? '…' : ''}`
      await formatAndSendText(this.lark, chatId, recall, { chunkLimit: this.config.messageChunkLimit })
    }
  }

  async runModel(cmd, message) {
    const { chatId } = message
    const binding = await this.router.get(chatId)
    if (binding === undefined) return void this.lark.sendText(chatId, '先 /ws use 绑定一个工作区。')
    if (cmd.args.length === 0) {
      const guard = guardDecision({ running: await this.isRunning(chatId) })
      if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
      // Real API: listProviders() then listModels(provider) per route — a
      // bare listModels() called registration(undefined) and threw
      // 'no adapter registered for provider "undefined"'.
      const providers = []
      for (const p of this.ctx.llm.listProviders()) {
        const models = await this.ctx.llm.listModels(p.id)
        providers.push({ provider: p.id, models: models.map(m => ({ id: m.id })) })
      }
      const actions = []
      for (const p of providers) {
        for (const m of p.models.slice(0, 20)) {
          actions.push({
            tag: 'button', text: { tag: 'plain_text', content: `${p.provider}/${m.id}` }, type: 'default',
            value: { actionId: this.makeActionId(), kind: 'model', provider: p.provider, model: m.id },
          })
        }
      }
      for (let i = 0; i < actions.length; i += 5) {
        await this.lark.sendJson(chatId, 'interactive', {
          config: { update_multi: true },
          header: { title: { tag: 'plain_text', content: '选择模型' }, template: 'blue' },
          elements: [{ tag: 'action', actions: actions.slice(i, i + 5) }],
        })
      }
      return
    }
    // Direct selection `/model provider/model` is also a mutation: guard it
    // like the other model-change paths (ADR 0002: 模型变更仅空闲时允许).
    const [providerSlashModel] = cmd.args
    const [provider, model] = providerSlashModel.split('/')
    const guard = guardDecision({ running: await this.isRunning(chatId) })
    if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
    await this.selectModel(chatId, binding.activeSessionId, { provider, model })
    return void this.sendStatus(chatId)
  }

  // --- card actions ---

  async handleCardAction(action) {
    if (action.kind !== undefined && action.kind !== 'card-action') return
    const value = action.value ?? {}
    const { chatId } = action
    try {
      if (value.kind === 'diff') {
        const binding = await this.router.get(chatId)
        const sessionId = binding?.activeSessionId
        if (sessionId === undefined) return void this.lark.sendText(chatId, '当前没有活动会话。')
        // Real host surface: diff(sessionId, seq, index) — the card carried the
        // workspace/changes event seq and the file's index in the summary.
        const result = await this.ctx.workspaceChanges.diff(sessionId, value.seq ?? 0, value.index ?? 0)
        if (result?.kind === 'binary') return void this.lark.sendText(chatId, `「${value.path}」是二进制文件，无法展示文本 diff。`)
        if (result?.kind === 'oversized') return void this.lark.sendText(chatId, `「${value.path}」过大，diff 已省略。`)
        return void this.lark.sendJson(chatId, 'post', renderDiffMessage(value.path, renderDiffBody(result)))
      }
      if (value.kind === 'resume') {
        // Same guarded path as /session resume <arg>, by id from the card.
        const target = { header: { id: value.sessionId } }
        return void this.resumeSession(chatId, target, value.title)
      }
      if (value.kind === 'session-page') {
        const binding = await this.router.get(chatId)
        if (binding === undefined) return void this.lark.sendText(chatId, '先 /ws use 绑定一个工作区。')
        return void this.sessionList(chatId, binding, Number(value.page) || 1)
      }
      if (value.kind === 'model') {
        // Re-guard at press time: the card may be pressed long after it was
        // rendered, and a run may have started since (TOCTOU).
        const guard = guardDecision({ running: await this.isRunning(chatId) })
        if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
        const binding = await this.router.get(chatId)
        await this.selectModel(chatId, binding.activeSessionId, { provider: value.provider, model: value.model })
        return void this.sendStatus(chatId)
      }
      // answer kinds belong to the answerer
      await this.answererCallback(action)
    } catch (error) {
      this.logger?.warn?.(`feishu-gateway: card action failed: ${String(error)}`)
      return void this.lark.sendText(chatId, translateGuardError(error))
    }
  }

  // --- session events ---

  async onSessionEvent(session, event) {
    const binding = [...await this.allBindings()].find(b => b.activeSessionId === session.id)
    if (binding === undefined) return
    if (event.type !== 'turn/end') return
    const text = lastAssistantText(session, event)
    if (text !== '') await formatAndSendText(this.lark, binding.chatId, text, { chunkLimit: this.config.messageChunkLimit })
    const summary = this.ctx.workspaceChanges.summary?.(session.id, event.seq)
    if (summary !== undefined && summary.files?.length > 0) {
      await this.lark.sendJson(binding.chatId, 'interactive', renderChangesCard(summary, () => this.makeActionId(), event.seq))
    }
  }

  // --- helpers ---

  /** All bindings, for matching session events back to chats. */
  async allBindings() {
    return [...(this.listBindings ? this.listBindings() : this.router.bindings.values())]
  }

  async activeAgent(chatId) {
    const binding = await this.router.get(chatId)
    if (binding?.activeSessionId === undefined) return undefined
    return this.ctx.agents.get(binding.activeSessionId)
  }

  async isRunning(chatId) {
    const agent = await this.activeAgent(chatId)
    return agent?.status === 'running'
  }

  /**
   * Compose the agent's scoped world the way session-controller does it
   * (api/session-controller/src/agent.ts composeAgent): resolve the preset
   * and mount it inside the setup callback — the preset carries the tools,
   * prompt, and plugin composition. Without it the resumed agent is a hollow
   * shell: every historical tool gets a durable tool-removal event written
   * into the session log (the 36-tool loss). Public services only:
   * ctx.agentPresets.resolve/mount and the session header's durable
   * agentPreset field.
   * @param {string | undefined} presetId - the session's own preset on
   *   resume; undefined resolves the deployment default (new sessions).
   */
  async composeSetup(presetId) {
    const presets = this.ctx.get?.('agentPresets')
    if (presets === undefined) return { agentPreset: undefined, setup: undefined }
    const resolved = await presets.resolve(presetId)
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => { await presets.mount(agentCtx, resolved.id) },
    }
  }

  /** The session's durable preset, read through the public query surface. */
  async sessionPreset(sessionId) {
    try {
      const surface = await this.ctx.sessionQuery.readSurface(sessionId)
      return surface?.session?.agentPreset
    } catch {
      return undefined
    }
  }

  async openSession(chatId, binding) {
    // Real API (webhook template pattern): the caller GENERATES the session
    // id and passes sessionId — agents.create builds the Agent's id from it,
    // and omitting it produced "agent id \"undefined\" does not match session
    // id \"session-N\"" (the session store auto-assigns its own counter id).
    // meta carries only schema-valid fields; the feishu origin rides the
    // UserMessage source instead (see makeUserMessage / FEISHU_SOURCE).
    const sessionId = `feishu-${randomUUID()}`
    // Webhook pattern: pass the default model in agentOptions — the
    // {{model}}/{{provider}} prompt variables read agent.options.model, and
    // agents without one fail every turn with 'prompt variable "{{model}}"
    // has no value'.
    const selected = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
    const { agentPreset, setup } = await this.composeSetup()
    const { agent } = await this.ctx.agents.create({
      sessionId,
      // The durable agentPreset is what a later resume reads back — record it
      // exactly like session-controller's create does.
      meta: { cwd: binding.workspacePath, ...(agentPreset === undefined ? {} : { agentPreset }) },
      ...(selected === undefined ? {} : { agentOptions: { provider: selected.provider, model: selected.model } }),
      ...(setup === undefined ? {} : { setup }),
    })
    // Workspace attachment is a method on the registry ENTITY (webhook
    // pattern: workspace.attachSession(id)) — the registry service itself
    // has none, so the old optional call was a silent no-op and feishu
    // sessions showed up Ungrouped/Untitled in the UI.
    const workspace = this.ctx.workspaceRegistry.list().find(w => w.id === binding.workspaceId)
    await workspace?.attachSession?.(agent.session.id)
    await this.router.setActive(chatId, agent.session.id, this.sessionTitleSnapshot(agent.session)?.title)
    return agent
  }

  /**
   * Whether another process holds the session's kernel write lease
   * (session.lock flock — the same primitive the persistence layer uses).
   * A cross-host ownership probe: a session open in another dsh window/host
   * cannot be resumed here, and letting agents.resume discover that throws
   * SessionAlreadyOwnedError deep inside the host (whose rejection path
   * kills the process). Probing first turns the collision into a reply.
   */
  async sessionLockHeld(sessionId) {
    if (this.probeLock !== undefined) return this.probeLock(sessionId)
    let flock
    try { flock = await import('@deepseek-ai/node-addon-system/flock') } catch { return false }
    try {
      const roots = await readdir(join(homedir(), '.dsh', 'sessions'), { withFileTypes: true })
      for (const root of roots) {
        if (root.isDirectory() !== true) continue
        const handle = await openFile(join(homedir(), '.dsh', 'sessions', root.name, sessionId, 'session.lock'), 'r')
          .catch(() => undefined)
        if (handle === undefined) continue
        try {
          await flock.tryLockExclusive(handle.fd)
          return false // free: probe lock released when the handle closes
        } catch {
          return true // EAGAIN: someone else owns the write lease
        } finally {
          await handle.close().catch(() => {})
        }
      }
      return false
    } catch {
      return false
    }
  }

  /** Guarded resume: lock probe first, friendly translation on collision. */
  async resumeAgent(sessionId) {
    if (await this.sessionLockHeld(sessionId)) {
      return { error: '该会话正被另一个窗口/进程占用（例如在 dsh UI 里打开着）。请在那边关闭它，或 /session list 换一个会话。' }
    }
    try {
      // Same rule as openSession: resumed agents need agentOptions.model too
      // ({{model}} reads agent.options.model); without it every turn dies
      // with 'prompt variable "{{model}}" has no value'.
      const selected = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
      // Resume with the session's OWN preset (session-controller's
      // assertPresetUnchanged rule): a different composition would replay
      // history the model can no longer act on.
      const { setup } = await this.composeSetup(await this.sessionPreset(sessionId))
      const { agent } = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(selected === undefined ? {} : { agentOptions: { provider: selected.provider, model: selected.model } }),
        ...(setup === undefined ? {} : { setup }),
      })
      return { agent }
    } catch (error) {
      const text = `${error?.constructor?.name ?? ''} ${String(error?.message ?? error)}`
      if (text.includes('AlreadyOwned') || text.includes('already owned')) {
        return { error: '该会话正被另一个窗口/进程占用。请在那边关闭它，或 /session list 换一个会话。' }
      }
      throw error
    }
  }

  async deliverTask(message) {
    const binding = await this.router.get(message.chatId)
    if (binding === undefined) {
      return void this.lark.sendText(message.chatId, '先绑定工作区：/ws list 查看，/ws use <名称> 切换。')
    }
    const source = { kind: FEISHU_SOURCE, chatId: message.chatId, senderOpenId: message.senderOpenId, messageId: message.messageId }
    // No auto-creation here: a chat without an active session must be told
    // to pick one (/ws use + /session new|resume|list), never silently
    // dropped into a fresh unattached conversation.
    if (binding.activeSessionId === undefined) {
      return void this.lark.sendText(message.chatId, '还没有活动会话：/session new 新开，或 /session list 从历史中恢复。')
    }
    let agent = this.ctx.agents.get(binding.activeSessionId)
    if (agent === undefined) {
      // The bound session is not live (host restarted): resume it in place —
      // do NOT wander off into a new session.
      const resumed = await this.resumeAgent(binding.activeSessionId)
      if (resumed.error !== undefined) return void this.lark.sendText(message.chatId, resumed.error)
      agent = resumed.agent
    }
    if (agent.status === 'running') {
      agent.steer?.(makeUserMessage(message.text, source))
      return
    }
    agent.followup(makeUserMessage(message.text, source))
  }

  /**
   * Latest folded title snapshot, or undefined. Optional service by name
   * (property access throws without inject), and the service itself throws
   * on a session without a live log — never let a status read crash the host.
   */
  sessionTitleSnapshot(session) {
    if (session === undefined || session === null) return undefined
    try {
      const service = this.ctx.get?.('sessionTitle')
      return typeof service?.get === 'function' ? service.get(session) : undefined
    } catch {
      return undefined
    }
  }

  async selectModel(chatId, sessionId, selection) {
    // Real API: ctx.sessionController.selectModel takes the ModelSelection
    // fields flat on the request (packages/api/session-controller), not a
    // nested `selection` object.
    await this.ctx.sessionController.selectModel({ sessionId, ...selection })
  }

  async sendStatus(chatId) {
    const binding = await this.router.get(chatId)
    if (binding === undefined) return void this.lark.sendText(chatId, '尚未绑定工作区。/ws use <名称>')
    const agent = binding.activeSessionId !== undefined ? this.ctx.agents.get(binding.activeSessionId) : undefined
    const session = agent?.session
    // Real surfaces only: ctx.sessionTitle.get(session) for the title and the
    // session's logged request header (Session.requestHeader()) for the model.
    // No session.title()/currentModel()/pendingModel() exists on the host.
    const titleSnapshot = this.sessionTitleSnapshot(session)
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const model = header?.config?.provider !== undefined && header?.config?.model !== undefined
      ? `${header.config.provider}/${header.config.model}`
      : '默认'
    await this.lark.sendJson(chatId, 'interactive', buildStatusCard({
      workspaceTitle: binding.workspaceTitle,
      workspacePath: binding.workspacePath,
      sessionTitle: titleSnapshot?.title ?? binding.activeSessionTitle ?? '（无会话）',
      sessionId: binding.activeSessionId ?? '（无）',
      model,
      modelPending: false,
      running: agent?.status === 'running',
    }))
  }
}
