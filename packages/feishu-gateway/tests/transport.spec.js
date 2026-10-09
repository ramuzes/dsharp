// tests/transport.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInboundEvent, MessageDedup, ActionDedup } from '../lib/transport.js'

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
