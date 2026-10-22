// tests/router.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { BindingRouter } from '../lib/router.js'

function memoryPersist() {
  let state = undefined
  return { load: async () => state, save: async s => { state = s } }
}

test('bind then setActive round-trips through persistence', async () => {
  const persist = memoryPersist()
  const router = new BindingRouter({ persist })
  await router.load()
  await router.bind('oc_1', { workspaceId: 'w1', workspaceTitle: 'demo', workspacePath: '/tmp/demo' })
  await router.setActive('oc_1', 's1', 'first session')
  const router2 = new BindingRouter({ persist })
  await router2.load()
  const b = await router2.get('oc_1')
  assert.equal(b.activeSessionId, 's1')
  assert.equal(b.workspaceTitle, 'demo')
})

test('setActive pushes the previous session into history (deduped, capped)', async () => {
  const router = new BindingRouter({ persist: memoryPersist() })
  await router.load()
  await router.bind('oc_1', { workspaceId: 'w1', workspaceTitle: 't', workspacePath: 'p' })
  for (let i = 0; i < 12; i++) await router.setActive('oc_1', `s${i}`, `session ${i}`)
  const b = await router.get('oc_1')
  assert.equal(b.activeSessionId, 's11')
  assert.equal(b.sessionHistory.length, 10)
  assert.equal(b.sessionHistory[0].sessionId, 's10') // most recent first
  // switching back to s9 moves it out of history into active without dupes
  await router.setActive('oc_1', 's9', 'session 9')
  const b2 = await router.get('oc_1')
  assert.equal(b2.activeSessionId, 's9')
  assert.ok(!b2.sessionHistory.some(e => e.sessionId === 's9'))
})

test('get on unknown chat is undefined', async () => {
  const router = new BindingRouter({ persist: memoryPersist() })
  await router.load()
  assert.equal(await router.get('oc_x'), undefined)
})

test('chatForSession resolves the chat whose active session matches', async () => {
  const router = new BindingRouter({ persist: memoryPersist() })
  await router.load()
  await router.bind('oc_1', { workspaceId: 'w1', workspaceTitle: 'demo', workspacePath: '/tmp/demo' })
  await router.bind('oc_2', { workspaceId: 'w1', workspaceTitle: 'demo', workspacePath: '/tmp/demo' })
  await router.setActive('oc_2', 's9', 'x')
  assert.equal(router.chatForSession('s9'), 'oc_2')
  assert.equal(router.chatForSession('sX'), undefined, 'unbound session id resolves to undefined')
})

test('clearActive releases the pointer, parks the session in history, keeps the workspace', async () => {
  const router = new BindingRouter({ persist: memoryPersist() })
  await router.load()
  await router.bind('oc_1', { workspaceId: 'w1', workspaceTitle: 'demo', workspacePath: '/tmp/demo' })
  await router.setActive('oc_1', 's1', 'first')
  await router.clearActive('oc_1')
  const b = await router.get('oc_1')
  assert.equal(b.activeSessionId, undefined, 'pointer released')
  assert.equal(b.activeSessionTitle, undefined)
  assert.equal(b.workspaceId, 'w1', 'workspace binding untouched')
  assert.deepEqual(b.sessionHistory.map(e => e.sessionId), ['s1'], 'released session parked for /session resume')
  // chatForSession stops routing answerer cards to the released chat.
  assert.equal(router.chatForSession('s1'), undefined)
  // Idempotent on an already-released chat; unknown chat throws like setActive.
  await router.clearActive('oc_1')
  assert.equal((await router.get('oc_1')).sessionHistory.length, 1)
  await assert.rejects(() => router.clearActive('oc_unknown'), /no binding/)
})
