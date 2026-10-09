// tests/answerer.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayAnswerer } from '../lib/answerer.js'

function makeAnswerer() {
  const sent = []
  const lark = {
    sendText: async (c, t) => sent.push({ type: 'text', text: t }),
    sendJson: async (c, mt, content) => sent.push({ type: mt, content }),
  }
  let n = 0
  const answerer = new GatewayAnswerer({
    lark, config: {}, logger: console,
    makeActionId: () => `act_${++n}`,
  })
  return { answerer, sent }
}

function feishuRequest(questions) {
  return {
    questions,
    callId: 'call_1',
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
  assert.deepEqual(answer.answers, [{ questionId: 'q1', selectedLabels: ['Yes'] }])
})

test('non-feishu sessions delegate via next()', async () => {
  const { answerer, sent } = makeAnswerer()
  const request = { questions: [{ id: 'q1', question: 'x', options: [] }], callId: 'c', agent: { session: { id: 's9', lastUserSource: () => ({ kind: 'web' }) } } }
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
})

test('approval outcomes map to DSH semantics', async () => {
  const { answerer, sent } = makeAnswerer()
  const request = { prompt: 'rm -rf', agent: { session: { id: 's1', lastUserSource: () => ({ kind: 'feishu', chatId: 'oc_1' }) } } }
  const outcomePromise = answerer.handleApproval(request, async () => 'delegated')
  await Promise.resolve()
  assert.ok(sent.some(s => /允许一次/.test(JSON.stringify(s.content))))
  await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'act_1', kind: 'approval', outcome: 'allow-once' } })
  assert.deepEqual(await outcomePromise, { decision: 'allow-once' })
})

test('unknown action ids are ignored', async () => {
  const { answerer } = makeAnswerer()
  assert.equal(await answerer.handleCardAction({ kind: 'card-action', chatId: 'oc_1', value: { actionId: 'nope', kind: 'answer', choice: 0 } }), undefined)
})
