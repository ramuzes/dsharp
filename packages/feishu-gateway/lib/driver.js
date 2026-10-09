// lib/driver.js
/**
 * Session orchestration: inbound messages and card actions in, assistant
 * output and previews out. Owns no transport — the caller wires normalized
 * events to handleInbound/handleCardAction/onSessionEvent.
 */
import { parseCommand, guardDecision, translateGuardError, HELP_TEXT } from './commands.js'
import { formatAndSendText, buildStatusCard, renderChangesCard, renderDiffMessage, buildPostContent } from './formatter.js'

const FEISHU_SOURCE = 'feishu'

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
          agent?.interrupt?.()
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
    if (cmd.sub === 'resume') {
      const history = await this.router.history(chatId)
      if (history.length === 0) return void this.lark.sendText(chatId, '没有可恢复的历史会话。')
      const actions = history.slice(0, 10).map((e, i) => ({
        tag: 'button', text: { tag: 'plain_text', content: e.title ?? e.sessionId }, type: 'default',
        value: { actionId: this.makeActionId(), kind: 'resume', sessionId: e.sessionId, title: e.title },
      }))
      return void this.lark.sendJson(chatId, 'interactive', {
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: '恢复哪个会话？' }, template: 'blue' },
        elements: [{ tag: 'action', actions }],
      })
    }
    return void this.lark.sendText(chatId, '用法：/session new | resume')
  }

  async runModel(cmd, message) {
    const { chatId } = message
    const binding = await this.router.get(chatId)
    if (binding === undefined) return void this.lark.sendText(chatId, '先 /ws use 绑定一个工作区。')
    if (cmd.args.length === 0) {
      const guard = guardDecision({ running: await this.isRunning(chatId) })
      if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
      const providers = await this.ctx.llm.listModels()
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
        const diff = await this.ctx.workspaceChanges.diff(binding?.activeSessionId, 0, 0)
        return void this.lark.sendJson(chatId, 'post', renderDiffMessage(value.path, diff?.diff ?? String(diff)))
      }
      if (value.kind === 'resume') {
        const guard = guardDecision({ running: await this.isRunning(chatId) })
        if (!guard.allowed) return void this.lark.sendText(chatId, guard.reason)
        await this.ctx.agents.resume({ resumeSessionId: value.sessionId })
        await this.router.setActive(chatId, value.sessionId, value.title)
        return void this.sendStatus(chatId)
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
    const agent = this.ctx.agents.get(session.id)
    const text = agent?.session?.lastAssistantText?.() ?? ''
    if (text !== '') await formatAndSendText(this.lark, binding.chatId, text, { chunkLimit: this.config.messageChunkLimit })
    const summary = this.ctx.workspaceChanges.summary?.(session.id, event.seq)
    if (summary !== undefined && summary.files?.length > 0) {
      await this.lark.sendJson(binding.chatId, 'interactive', renderChangesCard(summary, () => this.makeActionId()))
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
    // SPEC: 插件创建的会话用 source kind 'feishu' 标记 — carry the origin in
    // create meta and mirror it on the session so answerer routing can read it.
    const { agent } = await this.ctx.agents.create({
      meta: { cwd: binding.workspacePath, source: { kind: FEISHU_SOURCE, chatId } },
    })
    agent.session.feishuSource = { chatId }
    this.ctx.workspaceRegistry.attachSession?.(binding.workspaceId, agent.session.id)
    await this.router.setActive(chatId, agent.session.id, agent.session.title?.())
    return agent
  }

  async deliverTask(message) {
    const binding = await this.router.get(message.chatId)
    if (binding === undefined) {
      return void this.lark.sendText(message.chatId, '先绑定工作区：/ws list 查看，/ws use <名称> 切换。')
    }
    const source = { kind: FEISHU_SOURCE, chatId: message.chatId, senderOpenId: message.senderOpenId, messageId: message.messageId }
    let agent = binding.activeSessionId !== undefined ? this.ctx.agents.get(binding.activeSessionId) : undefined
    if (agent === undefined) {
      agent = await this.openSession(message.chatId, binding)
    } else if (agent.status === 'running') {
      agent.steer?.(message.text, source)
      return
    }
    agent.followup(message.text, source)
  }

  async selectModel(chatId, sessionId, selection) {
    await this.ctx.apiSessions.selectModel({ sessionId, selection })
  }

  async sendStatus(chatId) {
    const binding = await this.router.get(chatId)
    if (binding === undefined) return void this.lark.sendText(chatId, '尚未绑定工作区。/ws use <名称>')
    const agent = binding.activeSessionId !== undefined ? this.ctx.agents.get(binding.activeSessionId) : undefined
    await this.lark.sendJson(chatId, 'interactive', buildStatusCard({
      workspaceTitle: binding.workspaceTitle,
      workspacePath: binding.workspacePath,
      sessionTitle: agent?.session?.title?.() ?? binding.activeSessionTitle ?? '（无会话）',
      sessionId: binding.activeSessionId ?? '（无）',
      model: agent?.session?.currentModel?.() ?? '默认',
      modelPending: agent?.session?.pendingModel?.() === true,
      running: agent?.status === 'running',
    }))
  }
}
