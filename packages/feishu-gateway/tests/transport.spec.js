// tests/transport.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInboundEvent, MessageDedup, ActionDedup, startGatewayTransport } from '../lib/transport.js'

const messageEvent = {
  event: {
    sender: { sender_id: { open_id: 'ou_alice' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi there' }) },
  },
}

test('normalizes im.message.receive_v1, parsing content JSON', () => {
  const n = normalizeInboundEvent('im.message.receive_v1', messageEvent)
  assert.deepEqual(n, { kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_alice', text: 'hi there' })
})

test('non-text message types normalize with placeholder text', () => {
  const ev = { event: { sender: { sender_id: { open_id: 'ou_a' } }, message: { message_id: 'om_2', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: 'k' }) } } }
  const n = normalizeInboundEvent('im.message.receive_v1', ev)
  assert.equal(n.kind, 'message')
  assert.match(n.text, /\[Unsupported message type: image\]/)
})

test('unknown events and group chats normalize to null', () => {
  assert.equal(normalizeInboundEvent('contact.user.updated_v3', {}), null)
  const group = { event: { ...messageEvent.event, message: { ...messageEvent.event.message, chat_type: 'group' } } }
  assert.equal(normalizeInboundEvent('im.message.receive_v1', group), null)
})

test('card.action.trigger normalizes with actionId and value', () => {
  const data = { event: { operator: { open_id: 'ou_a' }, action: { value: { qid: 'q1', choice: 0 }, tag: 'button' }, context: { open_message_id: 'om_c', open_chat_id: 'oc_1' } } }
  const n = normalizeInboundEvent('card.action.trigger', data)
  assert.deepEqual(n, { kind: 'card-action', actionId: 'q1', value: { qid: 'q1', choice: 0 }, messageId: 'om_c', chatId: 'oc_1', operatorOpenId: 'ou_a' })
})

test('MessageDedup: same message_id seen twice reports duplicate', () => {
  const d = new MessageDedup({ ttlMs: 60_000 })
  assert.equal(d.seen('om_1'), false)
  assert.equal(d.seen('om_1'), true)
})

test('ActionDedup: double click inside window is dropped', () => {
  const d = new ActionDedup({ windowMs: 60_000 })
  assert.equal(d.take('a1'), true)
  assert.equal(d.take('a1'), false)
})

test('ActionDedup prunes expired entries so the map does not grow unboundedly', () => {
  let nowMs = 1_000
  const clock = () => nowMs
  const d = new ActionDedup({ windowMs: 5, now: clock })
  assert.equal(d.take('a'), true)
  assert.equal(d.at.size, 1)
  nowMs = 6 // within window: still held, still blocks
  assert.equal(d.take('a'), false)
  assert.equal(d.at.size, 1)
  nowMs = 1_006 // strictly past windowMs: entry is pruned on next take
  assert.equal(d.take('b'), true)
  assert.equal(d.at.has('a'), false)
  assert.equal(d.at.size, 1)
})

test('card actions with same actionId but different messageIds are both dispatched', async () => {
  let dispatcherHandlers
  const stop = await startGatewayTransport({
    config: { appId: 'a', appSecret: 's', domain: 'd' },
    handlers: { onMessage: () => {}, onCardAction: n => { dispatched.push(n) } },
    wsClientFactory: async (config, handlers) => { dispatcherHandlers = handlers; return () => {} },
  })
  const dispatched = []
  const cardEvent = (messageId, operator) => ({
    event: { operator: { open_id: operator }, action: { value: { actionId: 'q1' } }, context: { open_message_id: messageId, open_chat_id: 'oc_1' } },
  })
  await dispatcherHandlers['card.action.trigger'](cardEvent('om_1', 'ou_a'))
  await dispatcherHandlers['card.action.trigger'](cardEvent('om_2', 'ou_b'))
  assert.equal(dispatched.length, 2)
  assert.deepEqual(dispatched.map(n => n.messageId), ['om_1', 'om_2'])
  // Same messageId+actionId inside the window is still deduped.
  await dispatcherHandlers['card.action.trigger'](cardEvent('om_1', 'ou_a'))
  assert.equal(dispatched.length, 2)
  await stop()
})
