/*
 * Session bridge tests (Task 6).
 *
 * Fakes mirror the real interfaces strictly:
 *  - root ctx: `on(name, fn)` captures listeners (real event is dispatched
 *    serially with payload { agent, source, signal? } — dsh
 *    packages/core/agent/src/index.ts:575, runtime-types.ts:291).
 *  - agent ctx: `effect(fn)` registers the effect; the disposer returned by
 *    the effect body runs on fiber disposal (vendor/cordis/lib/index.js:487,
 *    types fiber.d.ts:58-62).
 *  - client: { get, post, del } per lib/engram-api.js.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerSessionBridge } from '../lib/session-bridge.js'
import { ProjectAmbiguousError } from '../lib/project-resolution.js'

function fakeRootCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
  }
}

function fakeAgent(sessionId) {
  const effects = []
  const disposals = []
  const ctx = {
    // Real cordis runs the effect body synchronously at registration
    // (vendor/cordis/lib/index.js:460-461) and keeps the returned disposer
    // for fiber disposal.
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return () => {}
    },
  }
  const agent = { ctx }
  if (sessionId !== undefined) agent.session = { id: sessionId }
  return { agent, effects, disposals }
}

function fakeClient() {
  const calls = []
  return {
    calls,
    async post(path, body) {
      calls.push({ method: 'post', path, body })
      return { status: 201, body: { id: body.id, status: 'created' } }
    },
    async get(path) {
      calls.push({ method: 'get', path })
      return { status: 200, body: {} }
    },
    async del(path) {
      calls.push({ method: 'del', path })
      return { status: 204, body: {} }
    },
  }
}

const baseDeps = (overrides = {}) => {
  const client = overrides.client ?? fakeClient()
  return {
    client,
    resolveProject: overrides.resolveProject ?? (() => ({ project: 'proj-a', source: 'explicit' })),
    note: overrides.note ?? (() => {}),
    sessionIdOf: overrides.sessionIdOf ?? ((agent) => agent?.session?.id ?? ''),
    ...overrides,
  }
}

test('agent/created fires -> registration is wired via agent.ctx.effect', async () => {
  const rootCtx = fakeRootCtx()
  const bridge = registerSessionBridge(rootCtx, baseDeps())
  const { agent, effects } = fakeAgent('s-123')

  rootCtx.emit('agent/created', { agent, source: 'startup' })

  assert.equal(rootCtx.listeners.get('agent/created').length, 1, 'listener registered on root ctx')
  assert.equal(effects.length, 1, 'one effect registered on agent ctx')
  assert.equal(typeof effects[0], 'function', 'effect body returned a disposer (kept by cordis)')
  bridge.dispose()
})

test('agent/created fires -> POST body verified exactly', async () => {
  const client = fakeClient()
  const rootCtx = fakeRootCtx()
  const bridge = registerSessionBridge(
    rootCtx,
    baseDeps({ client, resolveProject: () => ({ project: 'proj-x', source: 'map' }) })
  )
  const { agent } = fakeAgent('abc')

  rootCtx.emit('agent/created', { agent, source: 'startup' })
  await new Promise((r) => setImmediate(r))

  assert.equal(client.calls.length, 1)
  const call = client.calls[0]
  assert.equal(call.path, '/sessions')
  assert.deepEqual(call.body, {
    id: 'dsh-abc',
    project: 'proj-x',
    ownership_mode: 'project_owned',
    resume: true,
  })
  bridge.dispose()
})

test('agent disposal (effect teardown) -> POST /sessions/{id}/end with empty body', async () => {
  const client = fakeClient()
  const rootCtx = fakeRootCtx()
  const registered = []
  const agentCtx = {
    // Mirror cordis: body runs now; disposer kept for disposal.
    effect(fn) {
      const d = fn()
      registered.push(d)
      return () => {}
    },
  }
  const bridge = registerSessionBridge(rootCtx, baseDeps({ client }))
  rootCtx.emit('agent/created', { agent: { ctx: agentCtx, session: { id: 'abc' } }, source: 'startup' })
  await new Promise((r) => setImmediate(r))
  client.calls.length = 0

  // Dispose like cordis would: run the disposer the effect returned.
  assert.equal(registered.length, 1)
  const maybe = registered[0]()
  if (maybe && typeof maybe.then === 'function') await maybe

  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].path, '/sessions/dsh-abc/end')
  assert.deepEqual(client.calls[0].body, {})
  bridge.dispose()
})

test('bridge dispose() -> ends all registered sessions (contained)', async () => {
  const client = fakeClient()
  const rootCtx = fakeRootCtx()
  const registered = []
  const agentCtx = {
    // Mirror cordis: body runs now; disposer kept for disposal.
    effect(fn) {
      const d = fn()
      registered.push(d)
      return () => {}
    },
  }
  const bridge = registerSessionBridge(rootCtx, baseDeps({ client }))
  rootCtx.emit('agent/created', { agent: { ctx: agentCtx, session: { id: 'z' } }, source: 'startup' })
  await new Promise((r) => setImmediate(r))
  client.calls.length = 0

  await bridge.dispose()
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].path, '/sessions/dsh-z/end')
})

test('registration rejects -> listener does not throw, note called, no POST leak', async () => {
  const client = fakeClient()
  client.post = async () => {
    throw new Error('boom')
  }
  const notes = []
  const rootCtx = fakeRootCtx()
  const bridge = registerSessionBridge(rootCtx, baseDeps({ client, note: (m) => notes.push(m) }))
  const { agent } = fakeAgent('abc')

  // Must not throw synchronously or reject the serial dispatch.
  await rootCtx.emit('agent/created', { agent, source: 'startup' })
  // Run the effect body like the host would on mount.
  await new Promise((r) => setImmediate(r))

  assert.ok(notes.length >= 1, 'note called on registration failure')
  bridge.dispose()
})

test('ensureSession debounce: within TTL -> single POST; after TTL -> renewed POST', async () => {
  const client = fakeClient()
  let now = 0
  const notes = []
  const rootCtx = fakeRootCtx()
  const bridge = registerSessionBridge(
    rootCtx,
    baseDeps({ client, note: (m) => notes.push(m), now: () => now })
  )
  const { agent } = fakeAgent('abc')
  await bridge.ensureSession(agent)
  await bridge.ensureSession(agent)
  await bridge.ensureSession(agent)
  assert.equal(client.calls.length, 1, 'debounced within TTL')

  now = 4 * 60 * 1000 + 1 // past the 4-minute TTL
  await bridge.ensureSession(agent)
  assert.equal(client.calls.length, 2, 'renewed after TTL')
  assert.equal(client.calls[1].body.id, 'dsh-abc')
  bridge.dispose()
})

test('ensureSession rethrows nothing on failure; notes contained failure', async () => {
  const client = fakeClient()
  client.post = async () => {
    throw new Error('down')
  }
  const notes = []
  const rootCtx = fakeRootCtx()
  const bridge = registerSessionBridge(rootCtx, baseDeps({ client, note: (m) => notes.push(m) }))
  const { agent } = fakeAgent('abc')
  await bridge.ensureSession(agent) // must not throw
  assert.ok(notes.length >= 1)
  bridge.dispose()
})

test('unresolved project (ProjectAmbiguousError) -> no POST, note(bridge-unresolved-project), no throw', async () => {
  const client = fakeClient()
  const notes = []
  const rootCtx = fakeRootCtx()
  const bridge = registerSessionBridge(
    rootCtx,
    baseDeps({
      client,
      note: (m) => notes.push(m),
      resolveProject: () => {
        throw new ProjectAmbiguousError(['a', 'b'])
      },
    })
  )
  const { agent } = fakeAgent('abc')

  await rootCtx.emit('agent/created', { agent, source: 'startup' })
  await new Promise((r) => setImmediate(r))
  assert.equal(client.calls.length, 0, 'no POST when project unresolved')
  assert.ok(notes.includes('bridge-unresolved-project'), `got notes: ${notes.join(',')}`)
  bridge.dispose()
})

test('missing session id -> no POST, note (nothing to key a session on)', async () => {
  const client = fakeClient()
  const notes = []
  const rootCtx = fakeRootCtx()
  const bridge = registerSessionBridge(rootCtx, baseDeps({ client, note: (m) => notes.push(m) }))
  const { agent } = fakeAgent(undefined)

  await rootCtx.emit('agent/created', { agent, source: 'startup' })
  await new Promise((r) => setImmediate(r))
  assert.equal(client.calls.length, 0)
  assert.ok(notes.length >= 1)
  bridge.dispose()
})
