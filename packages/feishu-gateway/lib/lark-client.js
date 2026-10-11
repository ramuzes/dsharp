/**
 * Outbound Feishu messaging over the official SDK client, serialized per chat
 * (Feishu caps one bot at 5 QPS to the same chat) and always carrying the
 * optional uuid idempotency parameter.
 */

/** Read a Config field the Loader may hand as a volatile wrapper or plain value. */
export function readConfigString(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'string' ? raw : ''
}

/** Outbound uuid counter + random suffix; ids stay far under Feishu's 50-char cap. */
let autoUuidSeq = 0
function nextUuid() {
  return `fg-${(++autoUuidSeq).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class LarkClient {
  /** @param {{ sdkClient: any, logger?: any, sendGapMs?: number }} options */
  constructor({ sdkClient, logger, sendGapMs = 250 }) {
    this.sdk = sdkClient
    this.logger = logger
    this.sendGapMs = sendGapMs
    /** @type {Map<string, Promise<void>>} per-chat send chains */
    this.queues = new Map()
  }

  /** Run one send serialized per chat, with a small gap between sends. */
  enqueue(chatId, run) {
    const prev = this.queues.get(chatId) ?? Promise.resolve()
    const next = prev.then(run, run)
    const drained = next.then(
      () => { if (this.queues.get(chatId) === drained) this.queues.delete(chatId) },
      () => {},
    )
    this.queues.set(chatId, drained)
    return next
  }

  async create(chatId, msgType, contentObj, uuid) {
    const idempotencyKey = uuid ?? nextUuid()
    await this.enqueue(chatId, async () => {
      if (this.sendGapMs > 0) await new Promise(r => setTimeout(r, this.sendGapMs))
      await this.guarded(`create → ${String(chatId)}`, () => this.sdk.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(contentObj), uuid: idempotencyKey },
      }))
    })
  }

  /**
   * HARDENING: a failed outbound REST call logs (console + status) instead
   * of rejecting — the gateway must keep serving later messages, and no
   * send error may propagate into host-owned call stacks.
   */
  async guarded(label, run) {
    try {
      const response = await run()
      if (response?.code !== undefined && response.code !== 0) {
        this.logger?.error?.(`feishu-gateway: send ${label} refused: code ${String(response.code)} ${String(response.msg ?? '')}`)
      }
    } catch (error) {
      this.logger?.error?.(`feishu-gateway: send ${label} failed: ${String(error)}`)
    }
  }

  /** Send a plain text message. */
  async sendText(chatId, text, uuid) { return this.create(chatId, 'text', { text }, uuid) }

  /** Send a msg_type with a JSON content object (post / interactive / …). */
  async sendJson(chatId, msgType, contentObj, uuid) { return this.create(chatId, msgType, contentObj, uuid) }

  /** Reply to one message id. */
  async reply(messageId, msgType, contentObj, uuid) {
    const idempotencyKey = uuid ?? nextUuid()
    await this.enqueue(`reply:${messageId}`, async () => {
      if (this.sendGapMs > 0) await new Promise(r => setTimeout(r, this.sendGapMs))
      await this.guarded(`reply → ${String(messageId)}`, () => this.sdk.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: msgType, content: JSON.stringify(contentObj), uuid: idempotencyKey },
      }))
    })
  }
}
