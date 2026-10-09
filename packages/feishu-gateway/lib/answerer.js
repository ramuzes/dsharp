/**
 * The gateway as a Cordis waterfall Answerer: structured questions and
 * approval requests from feishu-origin sessions round-trip as interactive
 * cards; everything else is delegated with next().
 */
import { buildQuestionCard, buildApprovalCard } from './formatter.js'

/**
 * Card outcome vocabulary the approval card emits (formatter values) mapped to
 * the DSH ApprovalOutcome union ('allowed-once' | 'rejected' | 'cancelled' |
 * 'unavailable', verified against dsh user-approval/src/index.ts). DSH has no
 * session/always grants, so every allow variant maps to 'allowed-once'.
 */
const CARD_TO_DSH = {
  'allow-once': 'allowed-once',
  'allow-session': 'allowed-once',
  'allow-always': 'allowed-once',
  'deny': 'rejected',
}

/** Card outcome values handleCardAction accepts on approval entries. */
const OUTCOMES = new Set(Object.keys(CARD_TO_DSH))

/** Default cap on the pending map; dead entries are evicted oldest-first. */
const MAX_PENDING = 200

/**
 * The chat a request's session belongs to, or undefined when it is not ours.
 *
 * The load-bearing path is our own durable state: the BindingRouter maps
 * activeSessionId → chatId (the host exposes no session.lastUserSource()).
 * The lastUserSource read stays as a secondary signal for sessions that
 * predate the binding lookup.
 */
function feishuChatOf(request, resolveChat) {
  const chatId = resolveChat?.(request.agent?.session?.id)
  if (typeof chatId === 'string') return chatId
  const source = request.agent?.session?.lastUserSource?.()
  if (source?.kind === 'feishu' && typeof source.chatId === 'string') return source.chatId
  return undefined
}

export class GatewayAnswerer {
  /** @param {{ lark: any, config?: any, logger?: any, makeActionId: () => string, maxPending?: number, resolveChat?: (sessionId: string) => string | undefined }} options */
  constructor({ lark, config = {}, logger, makeActionId, maxPending = MAX_PENDING, resolveChat }) {
    this.lark = lark
    this.config = config
    this.logger = logger
    this.makeActionId = makeActionId
    this.maxPending = maxPending
    this.resolveChat = resolveChat
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
    const chatId = feishuChatOf(request, this.resolveChat)
    if (chatId === undefined) return next()
    // v1 handles the first question only; later questions follow after answer.
    const question = request.questions?.[0]
    if (question === undefined) return next()
    const actionId = this.makeActionId()
    const answer = await this.roundTrip(chatId, actionId, 'question', request,
      buildQuestionCard(question, actionId))
    if (answer.timedOut) return next()
    const choice = answer.value.choice
    const label = question.options?.[choice]?.label ?? ''
    // DSH AskUserQuestionAnswerItem: { id, selected: string[] }
    return { answers: [{ id: question.id, selected: [label] }] }
  }

  /** approval waterfall: route feishu sessions to an allow/deny card, else next(). */
  async handleApproval(request, next) {
    const chatId = feishuChatOf(request, this.resolveChat)
    if (chatId === undefined) return next()
    const actionId = this.makeActionId()
    const outcome = await this.roundTrip(chatId, actionId, 'approval', request,
      buildApprovalCard(String(request.prompt ?? request.reason ?? '权限请求'), actionId))
    if (outcome.timedOut) return next()
    // The approval waterfall answerer returns the ApprovalOutcome string
    // itself; a non-string return would be normalized to 'unavailable'.
    return CARD_TO_DSH[outcome.value.outcome] ?? 'unavailable'
  }

  /** Drop oldest dead entries once the pending map reaches the cap. */
  evictDeadPending() {
    if (this.pending.size < this.maxPending) return
    for (const key of this.pending.keys()) {
      if (this.pending.size < this.maxPending) break
      if (this.pending.get(key).dead) this.pending.delete(key)
    }
  }

  /** Send the card and await the matching card action (or timeout). */
  roundTrip(chatId, actionId, kind, request, card) {
    return new Promise(resolve => {
      const entry = { resolve, kind, request, dead: false, cleanup: () => {} }
      this.evictDeadPending()
      this.pending.set(actionId, entry)
      // The request event carries an AbortSignal (AskUserQuestionRequestEvent
      // and the approval request both have signal?: AbortSignal): when the
      // timed window / turn is cancelled, mark the entry dead so eviction and
      // late-answer routing run. One subscription covers both kinds.
      const signal = request?.signal
      if (signal !== undefined) {
        const onAbort = () => this.killPending(actionId)
        entry.cleanup = () => {
          if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      this.lark.sendJson(chatId, 'interactive', card).catch(error => {
        this.logger?.warn?.(`feishu-gateway: card send failed: ${String(error)}`)
        entry.cleanup()
        this.pending.delete(actionId)
        resolve({ timedOut: true })
      })
    })
  }

  /** Mark a pending entry dead (the timed window closed / signal aborted). */
  killPending(actionId) {
    const entry = this.pending.get(actionId)
    if (entry === undefined) return // already resolved and deleted — safe no-op
    entry.cleanup?.()
    if (entry.dead) return
    entry.dead = true
    entry.resolve({ timedOut: true })
    // keep the entry so a late click can still route to userQuestions.answer;
    // callId lives at request.wait.callId in the real event shape
    entry.late = { callId: entry.request.wait?.callId ?? entry.request.callId, agent: entry.request.agent }
  }

  /** Resolve one card action against the pending map (or late-answer path). */
  async handleCardAction(action) {
    const value = action.value ?? {}
    if (value.actionId === undefined) return undefined
    const entry = this.pending.get(value.actionId)
    if (entry === undefined) return undefined
    if (entry.dead) {
      // late answer: the waterfall already closed. v1 late-answers only
      // single-question cards — userQuestions.answer throws on partial
      // batches ("must name each question exactly once"), so a multi-question
      // late click is dropped with a friendly chat message instead.
      const singleQuestion = entry.kind === 'question' && entry.request.questions?.length === 1
      if (entry.kind === 'question' && !singleQuestion) {
        this.logger?.debug?.(`feishu-gateway: dropping late multi-question card click for ${String(value.actionId)} — v1 supports single-question late answers only`)
        await this.lark.sendText(action.chatId, '这张提问卡片已过期，多问题卡片暂不支持迟到作答；请重新发送消息发起提问。').catch(error => {
          this.logger?.warn?.(`feishu-gateway: late-click notice send failed: ${String(error)}`)
        })
      } else if (singleQuestion && entry.late !== undefined && entry.late.callId !== undefined && this.userQuestions !== undefined) {
        const question = entry.request.questions?.[0]
        const label = question?.options?.[value.choice]?.label ?? ''
        await this.userQuestions.answer(entry.late.agent, entry.late.callId, {
          answers: [{ id: question?.id ?? value.questionId, selected: [label] }],
        })
      } else {
        this.logger?.debug?.(`feishu-gateway: dropping late card click (${entry.kind}) for ${String(value.actionId)} — window already closed`)
      }
      this.pending.delete(value.actionId)
      return undefined
    }
    // Approval clicks outside the card vocabulary are ignored (logged), so a
    // stale card cannot inject a rogue outcome; the entry stays answerable.
    if (entry.kind === 'approval' && !OUTCOMES.has(value.outcome)) {
      this.logger?.debug?.(`feishu-gateway: ignoring approval outcome ${JSON.stringify(value.outcome)} for ${String(value.actionId)} — not in card vocabulary`)
      return undefined
    }
    this.pending.delete(value.actionId)
    entry.cleanup?.()
    entry.resolve({ value, timedOut: false })
    return undefined
  }
}
