// lib/driver.js
/**
 * Session orchestration: inbound messages and card actions in, assistant
 * output and previews out. Owns no transport — the caller wires normalized
 * events to handleInbound/handleCardAction/onSessionEvent.
 *
 * ARCHITECTURE (ADR: gateway-as-browser): this driver never composes Agents
 * itself. It is a client of the SAME host Remote surface the Web GUI speaks
 * (packages/api/session-controller), consumed in-process — one writer (the
 * host), many clients. What that replaces, and why it is correct:
 * - prompt()/create()/selectModel() resume sessions with the session's own
 *   preset and model handling internally (commands.ts resolveAgent) — the
 *   {{model}}-variable and hollow-agent (tool-removal) failure classes this
 *   plugin hit when calling agents.create/resume directly cannot recur.
 * - Cross-process ownership surfaces as the typed RemoteError
 *   `session/writer-held`; in one host process the UI and this gateway share
 *   the same live Agent instance, so no lock contention exists at all.
 * - prompt carries a client-minted requestId and is idempotent; queueing
 *   (mode 'queue') and steering (mode 'steer') are host features.
 *
 * Other host surfaces relied on (verified against the dsh checkout):
 * - Session.deriveMessages(): Message[] and Session.requestHeader()
 *   (packages/core/session/src/index.ts)
 * - ctx.sessionQuery.readSurface(sessionId) → { session, events }
 *   (packages/session-query): cold reads of header + surface events.
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
import { readStatus, readEvents } from './status.js'

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
    /** chatId → running-turn watchdog timer (cleared on turn/end). */
    this.watchdogs = new Map()
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
        case 'doctor': return this.runDoctor(chatId)
        case 'stop': {
          const binding = await this.router.get(chatId)
          if (binding?.activeSessionId === undefined) return void this.sendStatus(chatId)
          // Host Remote: cancel() interrupts the active turn without dropping
          // the pending inbox — replacing direct agent.cancel access.
          try {
            await this.ctx.sessionController.cancel({ sessionId: binding.activeSessionId })
          } catch (error) {
            return void this.lark.sendText(chatId, translateGuardError(error))
          }
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
    // Bare /session (or an unknown subcommand) falls through to the list —
    // the list IS the session command's home screen (new/resume ride on it).
    // `/session 2` reads the page from the subcommand slot too.
    const pageArg = /^\d+$/.test(String(cmd.sub)) ? cmd.sub : cmd.args?.[0]
    return this.sessionList(chatId, binding, Number(pageArg) || 1)
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

  /** Pointer switch + status card, then the last turn's assistant output
   * (cold-read through sessionQuery) so the user recalls what this session
   * was about. No Agent is resumed here: the host resumes lazily on the next
   * prompt, so a mere pointer switch can never fight for the write lease. */
  async resumeSession(chatId, target, title) {
    const guard = guardDecision({ running: await this.isRunning(chatId) })
    if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
    await this.router.setActive(chatId, target.header.id, title)
    await this.sendStatus(chatId)
    const last = await this.lastAssistantTextFromQuery(target.header.id)
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
      // Host Remote modelCatalog(): the same source the Web GUI's model
      // picker reads (provider groups + deployment default) — replaces the
      // per-provider listProviders/listModels fan-out that split the picker
      // across several separate chat messages.
      const catalog = await this.ctx.sessionController.modelCatalog()
      const elements = []
      const actions = []
      for (const group of catalog?.groups ?? []) {
        elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: String(group.id) }] })
        for (const model of group.models ?? []) {
          actions.push({
            tag: 'button', text: { tag: 'plain_text', content: `${String(model.name)} ${String(model.id)}`.slice(0, 20) }, type: 'default',
            value: { actionId: this.makeActionId(), kind: 'model', provider: group.id, model: model.id },
          })
        }
      }
      for (let i = 0; i < actions.length; i += 5) {
        elements.push({ tag: 'action', actions: actions.slice(i, i + 5) })
      }
      if (elements.length === 0) return void this.lark.sendText(chatId, '没有可用模型（/doctor 看看）。')
      return void this.lark.sendJson(chatId, 'interactive', {
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: '选择模型（下一轮生效）' }, template: 'blue' },
        elements,
      })
    }
    // Host semantics: selectModel picks for the NEXT request — safe while a
    // turn is running, so no Switch Guard here (the old guard made model
    // switches impossible whenever the chat had just started a turn).
    const [providerSlashModel] = cmd.args
    const [provider, model] = providerSlashModel.split('/')
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
        // selectModel picks for the NEXT request — deliberately NOT guarded
        // against a running turn (host-safe); a press long after rendering
        // is therefore fine too.
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
    if (event.type === 'turn/start') {
      this.armWatchdog(binding.chatId)
      return
    }
    if (event.type !== 'turn/end') return
    this.clearWatchdog(binding.chatId)
    // Round failures must reach the user (the {{model}} silent-failure lesson):
    // tool activity and reasoning stay in the web UI, errors do not.
    const reason = event.data?.reason ?? event.reason
    if (reason?.kind === 'error') {
      await this.lark.sendText(binding.chatId, `⚠️ 本轮失败：${String(reason.error?.message ?? JSON.stringify(reason)).slice(0, 400)}`)
    }
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

  async openSession(chatId, binding) {
    // Host Remote create(): idempotent adopt-or-create with the session's
    // preset composed and the workspace attached by the host itself
    // (commands.ts create → agents.ensureSession + workspace.attachSession).
    // The caller still GENERATES the session id so feishu sessions are
    // recognizable in the UI sidebar.
    const sessionId = `feishu-${randomUUID()}`
    const value = await this.ctx.sessionController.create({ sessionId, workspaceId: binding.workspaceId })
    const session = this.ctx.agents.get(value.sessionId)?.session
    await this.router.setActive(chatId, value.sessionId, this.sessionTitleSnapshot(session)?.title)
    return value.sessionId
  }

  /**
   * Whether another process holds the session's kernel write lease
   * (session.lock flock — the same primitive the persistence layer uses).
   * DIAGNOSTIC ONLY since the Remote-prompt refactor (/doctor): the write
   * path itself no longer probes — cross-process collisions surface as the
   * typed `session/writer-held` RemoteError from prompt/selectModel and are
   * translated at the edge.
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

  /** Last assistant text of a session, cold-read through the public query
   * surface (sessionQuery.readSurface) — no Agent resume needed. Empty when
   * the session or its surface is unavailable, or it holds no assistant
   * message. */
  async lastAssistantTextFromQuery(sessionId) {
    try {
      const surface = await this.ctx.sessionQuery.readSurface(sessionId)
      const events = surface?.events ?? []
      for (let i = events.length - 1; i >= 0; i--) {
        const record = events[i]
        if ((record?.type ?? record?.event?.type) !== 'assistant/message') continue
        const message = record?.data?.message ?? record?.event?.data?.message
        return (message?.content ?? [])
          .filter(block => block?.type === 'text')
          .map(block => block.text)
          .join('')
      }
      return ''
    } catch {
      return ''
    }
  }

  async deliverTask(message) {
    const binding = await this.router.get(message.chatId)
    if (binding === undefined) {
      return void this.lark.sendText(message.chatId, '先绑定工作区：/ws list 查看，/ws use <名称> 切换。')
    }
    // No auto-creation here: a chat without an active session must be told
    // to pick one (/ws use + /session new|resume|list), never silently
    // dropped into a fresh unattached conversation.
    if (binding.activeSessionId === undefined) {
      return void this.lark.sendText(message.chatId, '还没有活动会话：/session new 新开，或 /session list 从历史中恢复。')
    }
    // Host Remote prompt(): resumes a cold session with its own preset,
    // validates attachments, admits the message. mode 'steer' inserts into
    // the running turn, 'queue' holds it for the next one — the host owns
    // both behaviors. requestId makes retries idempotent (a repeated id is
    // early-returned accepted). NOTE: the feishu origin does not ride the
    // durable message (source is the generic user-rpc identity, same as a
    // browser send) — acceptable: this gateway IS another browser.
    // The Remote signature is (request, signal) and the FIRST line does
    // signal.throwIfAborted() — an in-process caller must still pass one.
    const running = await this.isRunning(message.chatId)
    try {
      await this.ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: binding.activeSessionId,
        mode: running ? 'steer' : 'queue',
        content: [{ type: 'text', text: message.text }],
      }, new AbortController().signal)
    } catch (error) {
      this.logger?.warn?.(`feishu-gateway: prompt rejected: ${String(error?.message ?? error)}`)
      return void this.lark.sendText(message.chatId, translateGuardError(error))
    }
    await this.lark.sendText(message.chatId, running ? '⚡ 已插入当前回合' : '⚡ 工作中…（/stop 可打断）')
  }

  /** Arm the once-per-turn "still running" watchdog (config 0 disables). */
  armWatchdog(chatId) {
    const ms = Number(this.config.watchdogMs)
    if (!Number.isFinite(ms) || ms <= 0) return
    this.clearWatchdog(chatId)
    const startedAt = Date.now()
    this.watchdogs.set(chatId, setTimeout(() => {
      this.watchdogs.delete(chatId)
      const minutes = Math.round((Date.now() - startedAt) / 60_000)
      this.lark.sendText(chatId, `⏱ 本轮已运行约 ${String(minutes)} 分钟仍未结束（可能在等审批，或请求挂起）。可 /stop 打断后重发。`)
        .catch?.(() => {})
    }, ms))
  }

  clearWatchdog(chatId) {
    const timer = this.watchdogs.get(chatId)
    if (timer !== undefined) { clearTimeout(timer); this.watchdogs.delete(chatId) }
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
    if (sessionId === undefined) return void this.lark.sendText(chatId, '还没有活动会话：/session new 或 /session list。')
    // Host Remote selectModel resumes the session when cold; a cross-process
    // owner surfaces as session/writer-held, translated at the edge.
    try {
      await this.ctx.sessionController.selectModel({ sessionId, ...selection })
    } catch (error) {
      return void this.lark.sendText(chatId, translateGuardError(error))
    }
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
    // The session's OWN model first (its logged request header — a resumed
    // session keeps using what it was using), the deployment default second.
    const defaultModel = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
    const model = header?.config?.provider !== undefined && header?.config?.model !== undefined
      ? `${header.config.provider}/${header.config.model}`
      : defaultModel !== undefined ? `${defaultModel.provider}/${defaultModel.model}（默认）` : '默认'
    await this.lark.sendJson(chatId, 'interactive', buildStatusCard({
      workspaceTitle: binding.workspaceTitle,
      workspacePath: binding.workspacePath,
      sessionTitle: titleSnapshot?.title ?? binding.activeSessionTitle ?? '（无会话）',
      sessionId: binding.activeSessionId ?? '（无）',
      model,
      modelPending: false,
      running: agent?.status === 'running',
      policy: await this.sessionPolicy(binding.activeSessionId),
    }))
  }

  /**
   * The session's sandbox + approval policy, read from its durable log's
   * setup events (public surface: sessionQuery.listEvents). Undefined when
   * the session or the events are unavailable — the card just omits the line.
   */
  async sessionPolicy(sessionId) {
    if (sessionId === undefined) return undefined
    try {
      const events = await this.ctx.sessionQuery.listEvents(sessionId)
      let sandbox
      let approval
      for (const record of events) {
        const type = record?.type ?? record?.event?.type
        const data = record?.data ?? record?.event?.data ?? {}
        if (type === 'sandbox/mode') sandbox = data.mode
        if (type === 'approval/policy') approval = data.policy
      }
      if (sandbox === undefined && approval === undefined) return undefined
      return `沙箱 ${String(sandbox ?? '?')} · 审批 ${String(approval ?? '?')}`
    } catch {
      return undefined
    }
  }

  /**
   * /doctor — in-chat self-check over the plugin's own observable state:
   * boot stage (status file), last inbound events, binding, the active
   * session's write lease, and the default model.
   */
  async runDoctor(chatId) {
    const status = readStatus()
    const events = readEvents()
    const binding = await this.router.get(chatId)
    const lines = [`**网关**：${String(status?.stage ?? '未知')}${status?.at ? `（${String(Math.round((Date.now() - Date.parse(status.at)) / 1000))}s 前）` : ''}`]
    const last = events.at(-1)
    lines.push(`**最近事件**：${last === undefined ? '无' : `${String(last.type)} → ${String(last.outcome)}`}`)
    if (binding === undefined) {
      lines.push('**绑定**：未绑定（/ws use <名称>）')
    } else {
      lines.push(`**绑定**：${binding.workspaceTitle} · 会话 ${String(binding.activeSessionId ?? '（无）')}`)
      if (binding.activeSessionId !== undefined) {
        lines.push(`**会话写锁**：${await this.sessionLockHeld(binding.activeSessionId) ? '被其他窗口占用 ⚠️' : '可用'}`)
      }
    }
    const dm = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (dm !== undefined) lines.push(`**默认模型**：${String(dm.provider)}/${String(dm.model)}`)
    await this.lark.sendText(chatId, lines.join('\n'))
  }
}
