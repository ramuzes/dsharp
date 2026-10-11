// lib/transport.js
/**
 * Inbound Feishu long-connection transport: normalize SDK event payloads to
 * gateway shapes, deduplicate at-least-once redeliveries (message_id) and
 * card double-clicks, and dispatch to handlers.
 */

/**
 * Normalize one SDK event into a gateway shape, or null when the gateway does
 * not handle it (unknown event type, non-p2p chat — v1 is p2p only).
 */
export function normalizeInboundEvent(eventName, data) {
  if (eventName === 'im.message.receive_v1') {
    // The SDK's EventDispatcher.parse() FLATTENS schema-2.0 events: the
    // handler receives `message`/`sender` at the TOP level, not under
    // `data.event` (vendor SDK invoke→parse; keep the nested shape for
    // direct raw payloads as a compat fallback).
    const message = data?.message ?? data?.event?.message
    if (message?.chat_type !== 'p2p') return null
    let content = {}
    try { content = JSON.parse(message.content ?? '{}') } catch { content = {} }
    const text = message.message_type === 'text'
      ? String(content.text ?? '')
      : `[Unsupported message type: ${message.message_type}]`
    const sender = data?.sender ?? data?.event?.sender
    return {
      kind: 'message',
      chatId: String(message.chat_id ?? ''),
      messageId: String(message.message_id ?? ''),
      senderOpenId: String(sender?.sender_id?.open_id ?? ''),
      text,
    }
  }
  if (eventName === 'card.action.trigger') {
    // Same flattening: action/context/operator may sit at the top level.
    const event = data?.action !== undefined ? data : (data?.event ?? {})
    const value = event.action?.value
    // The action card emits its id under a key such as `actionId` or `qid`;
    // fall back to the first entry so any single-pair value object works.
    let actionId = ''
    if (typeof value === 'object' && value !== null) {
      actionId = String(value.actionId ?? value.qid ?? Object.values(value)[0] ?? '')
    }
    if (actionId === '') return null
    return {
      kind: 'card-action',
      actionId,
      value,
      messageId: String(event.context?.open_message_id ?? ''),
      chatId: String(event.context?.open_chat_id ?? ''),
      operatorOpenId: String(event.operator?.open_id ?? ''),
    }
  }
  return null
}

/** message_id deduplication with TTL (official guidance: dedupe on message_id). */
export class MessageDedup {
  /** @param {{ ttlMs?: number }} [options] */
  constructor({ ttlMs = 86_400_000 } = {}) {
    this.ttlMs = ttlMs
    /** @type {Map<string, number>} */
    this.at = new Map()
  }

  /** Record id; true when it was already recorded (a duplicate). */
  seen(id) {
    const now = Date.now()
    this.prune(now)
    if (this.at.has(id)) return true
    this.at.set(id, now)
    return false
  }

  prune(now = Date.now()) {
    for (const [id, at] of this.at) {
      if (now - at > this.ttlMs) this.at.delete(id)
    }
  }
}

/** Card-action dedup window against double clicks. */
export class ActionDedup {
  /** @param {{ windowMs?: number, now?: () => number }} [options] */
  constructor({ windowMs = 15 * 60_000, now = Date.now } = {}) {
    this.windowMs = windowMs
    this.now = now
    /** @type {Map<string, number>} */
    this.at = new Map()
  }

  /** true when this actionId may proceed (first press inside the window). */
  take(actionId) {
    const now = this.now()
    for (const [id, at] of this.at) {
      if (now - at > this.windowMs) this.at.delete(id)
    }
    const prev = this.at.get(actionId)
    if (prev !== undefined && now - prev < this.windowMs) return false
    this.at.set(actionId, now)
    return true
  }
}

/**
 * Start the SDK WebSocket long connection and dispatch normalized events.
 * Returns a disposer that stops the client (best effort — the SDK exposes no
 * stop(); we drop handlers so late frames are ignored).
 *
 * @param {{ config: { appId: string, appSecret: string, domain: string }, handlers: { onMessage: (n: any) => Promise<void> | void, onCardAction: (n: any) => Promise<void> | void }, logger?: any, wsClientFactory?: (config: any, dispatcher: any) => Promise<() => void>, loadSdk?: () => Promise<any> }} args
 * @returns {Promise<() => void>}
 */
export async function startGatewayTransport({ config, handlers, logger, wsClientFactory, loadSdk = () => import('@larksuiteoapi/node-sdk'), eventLog, onState }) {
  const messages = new MessageDedup()
  const actions = new ActionDedup()
  let live = true
  // Inbound telemetry: every arriving event is recorded with its outcome so
  // "no reaction" splits into "never arrived" (console subscription) vs
  // "filtered here" — see ~/.dsh/feishu-gateway-events.json / scripts/doctor.mjs.
  const note = (entry) => { try { eventLog?.log(entry) } catch { /* best effort */ } }

  const dispatcherHandlers = {
    'im.message.receive_v1': async data => {
      const n = normalizeInboundEvent('im.message.receive_v1', data)
      // Decide once (the dedup calls consume), then record, then dispatch.
      const duplicate = n !== null && messages.seen(n.messageId)
      const outcome = n === null ? 'filtered:not-p2p-or-unparsable'
        : duplicate ? 'filtered:duplicate'
          : 'handled'
      note({ type: 'im.message.receive_v1', chatType: data?.message?.chat_type ?? data?.event?.message?.chat_type, messageId: n?.messageId, outcome })
      if (n === null || !live || duplicate) return
      try { await handlers.onMessage(n) } catch (error) {
        note({ type: 'im.message.receive_v1', messageId: n.messageId, outcome: `handler-error: ${String(error).slice(0, 300)}` })
        logger?.warn?.(`feishu-gateway: message handler failed: ${String(error)}`)
      }
    },
    'card.action.trigger': async data => {
      const n = normalizeInboundEvent('card.action.trigger', data)
      // Key by message+action: the same actionId on two cards (or two
      // operators) within the window must not collide.
      const blocked = n !== null && !actions.take(`${n.messageId}:${n.actionId}`)
      const outcome = n === null ? 'filtered:no-action-id'
        : blocked ? 'filtered:duplicate'
          : 'handled'
      note({ type: 'card.action.trigger', actionId: n?.actionId, outcome })
      if (n === null || !live || blocked) return
      try { await handlers.onCardAction(n) } catch (error) {
        note({ type: 'card.action.trigger', actionId: n.actionId, outcome: `handler-error: ${String(error).slice(0, 300)}` })
        logger?.warn?.(`feishu-gateway: card action handler failed: ${String(error)}`)
      }
    },
  }

  const start = wsClientFactory ?? ((cfg, dispatcherHandlers) => defaultWsClientFactory(cfg, dispatcherHandlers, loadSdk, onState))
  const stop = await start(config, dispatcherHandlers)
  return () => { live = false; try { stop?.() } catch { /* best effort */ } }
}

/**
 * Default factory using the official SDK. The SDK module is obtained via the
 * injected `loadSdk` (default: dynamic import) so tests and later tasks can
 * substitute a fake SDK without touching the real package; the dispatcher
 * shape is `EventDispatcher({}).register(map)`.
 */
async function defaultWsClientFactory(config, dispatcherHandlers, loadSdk, onState) {
  const Lark = await loadSdk()
  const wsClient = new Lark.WSClient({
    appId: config.appId, appSecret: config.appSecret, domain: config.domain, loggerLevel: Lark.LoggerLevel.info,
    // Lifecycle callbacks (IConstructorParams, SDK >= 1.74): report the real
    // connection state — start() resolving only proves the first attempt.
    ...(onState === undefined ? {} : {
      onReady: () => { onState('connected') },
      onError: (error) => { onState('transport-error', String(error)) },
    }),
  })
  await wsClient.start({ eventDispatcher: new Lark.EventDispatcher({}).register(dispatcherHandlers) })
  // The SDK exposes close() (not documented in older samples): use it for a
  // real disconnect instead of only dropping handlers.
  return () => { try { wsClient.close?.({ force: true }) } catch { /* best effort */ } }
}
