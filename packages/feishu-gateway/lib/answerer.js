/**
 * The gateway as a Cordis waterfall Answerer: structured questions and
 * approval requests from feishu-origin sessions round-trip as interactive
 * cards; everything else is delegated with next().
 */
import { buildQuestionCard, buildApprovalCard } from './formatter.js'

/** The answer shape DSH's userQuestions.ask() expects. */
const OUTCOMES = new Set(['allow-once', 'allow-session', 'allow-always', 'deny'])

/** True when the requesting agent's session belongs to this gateway. */
function isFeishuSession(request) {
  const source = request.agent?.session?.lastUserSource?.()
  return source?.kind === 'feishu' && typeof source.chatId === 'string'
}

export class GatewayAnswerer {
  /** @param {{ lark: any, config?: any, logger?: any, makeActionId: () => string }} options */
  constructor({ lark, config = {}, logger, makeActionId }) {
    this.lark = lark
    this.config = config
    this.logger = logger
    this.makeActionId = makeActionId
    /** @type {Map<string, { resolve: Function, kind: string, request: any }>} */
    this.pending = new Map()
    /** @type {any} */
    this.userQuestions = undefined
  }

  /** Test/apply seam for the ctx.userQuestions service. */
  setUserQuestionsService(service) { this.userQuestions = service }

  /** Register the two global waterfall listeners; returns a disposer. */
  attach(ctx) {
    const offQuestion = ctx.on('user-questions/request', (request, next) => this.handleUserQuestions(request, next), { global: true })
    const offApproval = ctx.on('approval/request', (request, next) => this.handleApproval(request, next), { global: true })
    return () => { offQuestion(); offApproval() }
  }

  /** user-questions waterfall: route feishu sessions to cards, else next(). */
  async handleUserQuestions(request, next) {
    if (!isFeishuSession(request)) return next()
    const chatId = request.agent.session.lastUserSource().chatId
    // v1 handles the first question only; later questions follow after answer.
    const question = request.questions?.[0]
    if (question === undefined) return next()
    const actionId = this.makeActionId()
    const answer = await this.roundTrip(chatId, actionId, 'question', request,
      buildQuestionCard(question, actionId))
    if (answer.timedOut) return next()
    const choice = answer.value.choice
    const label = question.options?.[choice]?.label ?? ''
    return { answers: [{ questionId: question.id, selectedLabels: [label] }] }
  }

  /** approval waterfall: route feishu sessions to an allow/deny card, else next(). */
  async handleApproval(request, next) {
    if (!isFeishuSession(request)) return next()
    const chatId = request.agent.session.lastUserSource().chatId
    const actionId = this.makeActionId()
    const outcome = await this.roundTrip(chatId, actionId, 'approval', request,
      buildApprovalCard(String(request.prompt ?? request.reason ?? '权限请求'), actionId))
    if (outcome.timedOut) return next()
    return { decision: outcome.value.outcome }
  }

  /** Send the card and await the matching card action (or timeout). */
  roundTrip(chatId, actionId, kind, request, card) {
    return new Promise(resolve => {
      const entry = { resolve, kind, request, dead: false }
      this.pending.set(actionId, entry)
      this.lark.sendJson(chatId, 'interactive', card).catch(error => {
        this.logger?.warn?.(`feishu-gateway: card send failed: ${String(error)}`)
        this.pending.delete(actionId)
        resolve({ timedOut: true })
      })
    })
  }

  /** Test seam marking a pending entry dead (the timed window closed). */
  killPending(actionId) {
    const entry = this.pending.get(actionId)
    if (entry !== undefined) {
      entry.dead = true
      entry.resolve({ timedOut: true })
      // keep the entry so a late click can still route to userQuestions.answer
      entry.late = { callId: entry.request.callId, agent: entry.request.agent }
    }
  }

  /** Resolve one card action against the pending map (or late-answer path). */
  async handleCardAction(action) {
    const value = action.value ?? {}
    if (value.actionId === undefined) return undefined
    const entry = this.pending.get(value.actionId)
    if (entry === undefined) return undefined
    if (entry.dead) {
      // late answer: the waterfall already closed — route via userQuestions.answer
      if (entry.kind === 'question' && entry.late !== undefined && this.userQuestions !== undefined) {
        const question = entry.request.questions?.[0]
        const label = question?.options?.[value.choice]?.label ?? ''
        await this.userQuestions.answer(entry.late.agent, entry.late.callId, {
          answers: [{ questionId: value.questionId, selectedLabels: [label] }],
        })
      }
      this.pending.delete(value.actionId)
      return undefined
    }
    this.pending.delete(value.actionId)
    entry.resolve({ value, timedOut: false })
    return undefined
  }
}
