// tests/answerer.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayAnswerer } from '../lib/answerer.js'

function makeAnswerer({ maxPending } = {}) {
  const sent = []
  const debug = []
  const lark = {
    sendText: async (c, t) => sent.push({ type: 'text', text: t }),
    sendJson: async (c, mt, content) => sent.push({ type: mt, content }),
  }
  let n = 0
  const answerer = new GatewayAnswerer({
    lark, config: {}, logger: { debug: m => debug.push(m), warn: () => {} },
    makeActionId: () => `act_${++n}`,
    ...(maxPending === undefined ? {} : { maxPending }),
  })
  return { answerer, sent, debug }
}

function feishuRequest(questions) {
  return {
    questions,
    wait: { callId: 'call_1', timed: true },
    agent: { session: { id: 's1', lastUserSource: () => ({ kind: 'feishu', chatId: 'oc_1' }) } },
  }
}

test('routes feishu-origin questions to a card and resolves on click', async () => {
  const { answerer, sent } = makeAnswerer()
  let resolvedByNext = false
  const answerPromise = answerer.handleUserQuestions(feishuRequest([{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }]), async () => { resolvedByNext = true })
  await Promise.resolve()
  assert.equal(resolvedByNext, false, 'did not delegate to next')
  assert.ok(sent.some(s => s.type === 'interactive' && /Proceed\?/.test(JSON.stringify(s.content))))
  // user clicks Yes (choice 0)
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'answer', questionId: 'q1', choice: 0 } })
  const answer = await answerPromise
  // DSH AskUserQuestionAnswerItem field names: { id, selected }
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['Yes'] }])
})

test('non-feishu sessions delegate via next()', async () => {
  const { answerer, sent } = makeAnswerer()
  const request = { questions: [{ id: 'q1', question: 'x', options: [] }], agent: { session: { id: 's9', lastUserSource: () => ({ kind: 'web' }) } } }
  const result = await answerer.handleUserQuestions(request, async () => 'delegated')
  assert.equal(result, 'delegated')
  assert.equal(sent.length, 0)
})

test('late answer after window close goes through userQuestions.answer', async () => {
  const { answerer } = makeAnswerer()
  const answered = []
  answerer.setUserQuestionsService({ answer: async (agent, callId, ans) => answered.push({ callId, ans }) })
  const request = feishuRequest([{ id: 'q1', question: 'x', options: [{ label: 'A' }] }])
  // window already closed: the waterfall promise rejected with timeout earlier;
  // simulate by marking the pending entry dead
  const p = answerer.handleUserQuestions(request, async () => { throw new Error('timeout') })
  await Promise.resolve()
  answerer.killPending('act_1') // test seam: the timed window expired
  await assert.rejects(p)
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'answer', questionId: 'q1', choice: 0 } })
  assert.equal(answered.length, 1)
  assert.equal(answered[0].callId, 'call_1')
  // the late-answer batch must also use DSH field names: { id, selected }
  assert.deepEqual(answered[0].ans.answers, [{ id: 'q1', selected: ['A'] }])
})

test('approval card values map to DSH ApprovalOutcome vocabulary', async () => {
  const { answerer, sent } = makeAnswerer()
  const request = { prompt: 'rm -rf', agent: { session: { id: 's1', lastUserSource: () => ({ kind: 'feishu', chatId: 'oc_1' }) } } }
  const outcomePromise = answerer.handleApproval(request, async () => 'delegated')
  await Promise.resolve()
  assert.ok(sent.some(s => /允许一次/.test(JSON.stringify(s.content))))
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'approval', outcome: 'allow-once' } })
  // The approval waterfall answerer returns the ApprovalOutcome string itself.
  assert.equal(await outcomePromise, 'allowed-once')
})

test('approval clicks outside the card vocabulary are ignored with a debug log', async () => {
  const { answerer, debug } = makeAnswerer()
  const request = { prompt: 'rm -rf', agent: { session: { id: 's1', lastUserSource: () => ({ kind: 'feishu', chatId: 'oc_1' }) } } }
  const outcomePromise = answerer.handleApproval(request, async () => 'delegated')
  await Promise.resolve()
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'approval', outcome: 'bogus' } })
  assert.equal(debug.length, 1, 'bogus approval outcome logged at debug')
  // still pending: the entry was not consumed by the invalid click
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'approval', outcome: 'deny' } })
  assert.equal(await outcomePromise, 'rejected')
})

test('late approval click is dropped with a debug log', async () => {
  const { answerer, debug } = makeAnswerer()
  const request = { prompt: 'rm -rf', agent: { session: { id: 's1', lastUserSource: () => ({ kind: 'feishu', chatId: 'oc_1' }) } } }
  const p = answerer.handleApproval(request, async () => 'delegated')
  await Promise.resolve()
  answerer.killPending('act_1')
  await p // resolves timedOut -> next() -> 'delegated'
  assert.equal(answerer.pending.has('act_1'), true, 'dead entry kept for late-click logging')
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'approval', outcome: 'allow-once' } })
  assert.equal(debug.length, 1, 'late approval click logged at debug')
  assert.equal(answerer.pending.has('act_1'), false, 'late click evicts the entry')
})

test('pending map evicts oldest dead entries at the cap', async () => {
  const { answerer } = makeAnswerer({ maxPending: 2 })
  const p1 = answerer.roundTrip('oc_1', 'act_1', 'question', feishuRequest([{ id: 'q1', question: 'a', options: [{ label: 'A' }] }]), {})
  const p2 = answerer.roundTrip('oc_1', 'act_2', 'question', feishuRequest([{ id: 'q2', question: 'b', options: [{ label: 'B' }] }]), {})
  await Promise.resolve()
  answerer.killPending('act_1')
  answerer.killPending('act_2')
  await p1; await p2
  assert.equal(answerer.pending.size, 2)
  // third round-trip: at cap, the oldest dead entry (act_1) must be evicted
  const p3 = answerer.roundTrip('oc_1', 'act_3', 'question', feishuRequest([{ id: 'q3', question: 'c', options: [{ label: 'C' }] }]), {})
  await Promise.resolve()
  assert.equal(answerer.pending.has('act_1'), false, 'oldest dead entry evicted')
  assert.equal(answerer.pending.has('act_2'), true)
  assert.equal(answerer.pending.has('act_3'), true)
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_3', kind: 'answer', questionId: 'q3', choice: 0 } })
})

test('unknown action ids are ignored', async () => {
  const { answerer } = makeAnswerer()
  assert.equal(await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'nope', kind: 'answer', choice: 0 } }), undefined)
})
