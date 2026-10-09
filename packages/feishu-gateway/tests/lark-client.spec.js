import test from 'node:test'
import assert from 'node:assert/strict'
import { LarkClient } from '../lib/lark-client.js'

function fakeSdk() {
  const calls = []
  return {
    calls,
    im: { v1: { message: {
      async create(req) { calls.push({ op: 'create', req }); return { data: { message_id: `om_${calls.length}` } } },
      async reply(req) { calls.push({ op: 'reply', req }); return { data: { message_id: `om_r${calls.length}` } } },
    } } },
  }
}

test('sendText sends text msg with uuid and chat_id', async () => {
  const sdk = fakeSdk()
  const client = new LarkClient({ sdkClient: sdk, sendGapMs: 0 })
  await client.sendText('oc_1', 'hello', 'u1')
  const { op, req } = sdk.calls[0]
  assert.equal(op, 'create')
  assert.equal(req.params.receive_id_type, 'chat_id')
  assert.equal(req.data.receive_id, 'oc_1')
  assert.equal(req.data.msg_type, 'text')
  assert.deepEqual(JSON.parse(req.data.content), { text: 'hello' })
  assert.equal(req.data.uuid, 'u1')
})

test('sendJson serializes content object', async () => {
  const sdk = fakeSdk()
  const client = new LarkClient({ sdkClient: sdk, sendGapMs: 0 })
  await client.sendJson('oc_1', 'post', { zh_cn: { title: 't' } }, 'u2')
  assert.equal(sdk.calls[0].req.data.msg_type, 'post')
  assert.equal(JSON.parse(sdk.calls[0].req.data.content).zh_cn.title, 't')
})

test('sends without an explicit uuid auto-generate one (non-empty, ≤50 chars, unique)', async () => {
  const sdk = fakeSdk()
  const client = new LarkClient({ sdkClient: sdk, sendGapMs: 0 })
  await client.sendText('oc_1', 'a')
  await client.sendText('oc_1', 'b')
  await client.reply('om_1', 'text', { text: 'c' })
  const uuids = sdk.calls.map(c => c.req.data.uuid)
  for (const u of uuids) {
    assert.ok(typeof u === 'string' && u.length > 0, `uuid present: ${String(u)}`)
    assert.ok(u.length <= 50, `uuid within 50 chars: ${u}`)
  }
  assert.equal(new Set(uuids).size, 3, 'every generated uuid is unique')
})

test('explicit uuid wins over auto-generation', async () => {
  const sdk = fakeSdk()
  const client = new LarkClient({ sdkClient: sdk, sendGapMs: 0 })
  await client.sendText('oc_1', 'a', 'caller-uuid')
  assert.equal(sdk.calls[0].req.data.uuid, 'caller-uuid')
})

test('sends to the same chat are serialized', async () => {
  const sdk = fakeSdk()
  const order = []
  let gate = Promise.resolve()
  sdk.im.v1.message.create = async req => {
    const prev = gate
    let release
    gate = new Promise(r => { release = r })
    await prev
    order.push(req.data.uuid)
    release()
    return { data: { message_id: 'om_x' } }
  }
  const client = new LarkClient({ sdkClient: sdk, sendGapMs: 0 })
  await Promise.all([client.sendText('oc_1', 'a', 'a'), client.sendText('oc_1', 'b', 'b')])
  assert.deepEqual(order, ['a', 'b'])
})
