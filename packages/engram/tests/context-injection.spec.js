/*
 * Proactive context injection tests (Task 7 + review fix).
 *
 * Fakes mirror the real interfaces strictly:
 *  - root ctx: `on(name, fn)` captures listeners and returns a remover (real
 *    cordis contract); the real `agent/created` payload is
 *    { agent, source, signal? } (dsh packages/core/agent/src/index.ts:575,
 *    runtime-types.ts:291) — listener destructures { agent }.
 *  - agent ctx: `effect(fn)` runs the body synchronously at registration and
 *    keeps the returned disposer for fiber disposal (vendor/cordis/lib/
 *    index.js:460-461, 487). `systemPrompt.section({ name, order, text })`
 *    captures the section; `text` must be a SYNC string provider
 *    (PromptSection.text: `string | ((ctx) => string)`, dsh
 *    packages/core/system-prompt/lib/types/index.d.ts:60).
 *  - client: { get } — GET /context with query { project, compact: 'true',
 *    max_bytes }; the real client returns the parsed JSON body directly on
 *    2xx (lib/engram-api.js:112), whose `context` field is a string.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerContextInjection } from '../lib/context-injection.js'
import { ProjectAmbiguousError } from '../lib/project-resolution.js'

function fakeRootCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      const list = listeners.get(name)
      list.push(fn)
      // Real cordis: the return value of `on` removes the listener.
      return () => {
        const i = list.indexOf(fn)
        if (i !== -1) list.splice(i, 1)
      }
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

/**
 * Fake agent whose ctx.systemPrompt.section captures the registered section.
 * Returns { agent, effects, disposals, sections } — sections[0].text() runs
 * the provider exactly like prompt assembly would (synchronously).
 */
function fakeAgent({ sessionId = 's-1', withSystemPrompt = true } = {}) {
  const effects = []
  const disposals = []
  const sections = []
  const ctx = {
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return () => {}
    },
  }
  if (withSystemPrompt) {
    ctx.systemPrompt = {
      section(def) {
        sections.push(def)
        // Real host keeps this disposer for section removal.
        return () => disposals.push(def.name)
      },
    }
  }
  const agent = { ctx }
  if (sessionId !== undefined) agent.session = { id: sessionId }
  return { agent, effects, disposals, sections }
}

function fakeClient() {
  const calls = []
  return {
    calls,
    async get(path, query) {
      calls.push({ path, query })
      // Real client (lib/engram-api.js:112) returns the parsed JSON body
      // directly on 2xx; errors throw typed EngramError instead.
      return { context: 'CONTEXT-BODY', project: query?.project }
    },
  }
}

const HEADER = '## Project memory (engram)\n'

function baseDeps(overrides = {}) {
  const client = overrides.client ?? fakeClient()
  return {
    client,
    resolveProject:
      overrides.resolveProject ?? (async () => ({ project: 'proj-a', source: 'explicit' })),
    note: overrides.note ?? (() => {}),
    getEnabled: overrides.getEnabled ?? (() => true),
    getMaxBytes: overrides.getMaxBytes ?? (() => 2048),
    ttlMs: overrides.ttlMs ?? 60_000,
    now: overrides.now ?? (() => 0),
    ...overrides,
  }
}

test('enabled + healthy: sync text returns header + fetched context after warm-up flush', async () => {
  const rootCtx = fakeRootCtx()
  const client = fakeClient()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client }))
  const { agent, effects, sections } = fakeAgent()

  rootCtx.emit('agent/created', { agent, source: 'startup' })

  assert.equal(rootCtx.listeners.get('agent/created').length, 1, 'listener on root ctx')
  assert.equal(effects.length, 1, 'effect registered on agent ctx (dual ownership)')
  assert.equal(typeof effects[0], 'function', 'effect body returned a disposer')
  assert.equal(sections.length, 1, 'section registered on agent.ctx.systemPrompt')
  assert.equal(sections[0].name, 'engram:memory')
  assert.equal(sections[0].order, 2330)

  await flush() // let the warm-up refresh land
  const text = sections[0].text()
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].path, '/context')
  assert.deepEqual(client.calls[0].query, { project: 'proj-a', compact: 'true', max_bytes: 2048 })
  assert.equal(typeof text, 'string', 'provider returns a string synchronously')
  assert.ok(text.startsWith(HEADER), 'text starts with the engram header')
  assert.ok(text.includes('CONTEXT-BODY'), 'text contains fetched context')
  plugin()
})

test('sync contract: text() returns a STRING (not a Promise) even on cache miss with refresh in flight', async () => {
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps())
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  // Immediately, before any flush: the warm-up refresh is still in flight.
  const text = sections[0].text()
  assert.equal(typeof text, 'string', 'typeof text() === string')
  assert.ok(!(text instanceof Promise), 'text() must not return a Promise')
  assert.equal(text, '', 'cache miss before refresh lands -> empty (fail-open)')
  plugin()
})

test('background refresh lands: after flush the next text() returns the fetched text', async () => {
  const rootCtx = fakeRootCtx()
  const client = fakeClient()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client }))
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  assert.equal(sections[0].text(), '', 'first read: cache still cold')
  await flush()
  assert.equal(sections[0].text(), HEADER + 'CONTEXT-BODY', 'refresh landed, warm read')
  assert.equal(client.calls.length, 1)
  plugin()
})

test('ambiguous project (resolver throws) -> no client call, note, text stays empty', async () => {
  const client = fakeClient()
  const notes = []
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(
    rootCtx,
    baseDeps({
      client,
      note: (m) => notes.push(m),
      resolveProject: () => {
        throw new ProjectAmbiguousError(['a', 'b'])
      },
    })
  )
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  assert.equal(sections[0].text(), '')
  await flush() // contained refresh attempt
  assert.equal(client.calls.length, 0, 'no client call on unresolved project')
  assert.ok(notes.length >= 1, 'note called')
  plugin()
})

test('client rejects -> fail-open: text stays empty, refresh error contained + note', async () => {
  const client = fakeClient()
  client.get = async () => {
    throw new Error('daemon down')
  }
  const notes = []
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client, note: (m) => notes.push(m) }))
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  assert.equal(sections[0].text(), '', 'sync read never throws')
  await flush()
  assert.ok(notes.length >= 1, 'note called on client failure')
  assert.equal(sections[0].text(), '', 'cache untouched after failed refresh')
  plugin()
})

test('client returns non-object body (missing context field) -> note, cache untouched', async () => {
  const client = fakeClient()
  client.get = async () => 'not-an-object'
  const notes = []
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client, note: (m) => notes.push(m) }))
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  await flush()
  assert.equal(sections[0].text(), '')
  assert.ok(notes.length >= 1)
  plugin()
})

test('disabled -> empty string and ZERO client calls (warm-up also skipped)', async () => {
  const client = fakeClient()
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client, getEnabled: () => false }))
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })
  await flush()

  assert.equal(sections[0].text(), '')
  assert.equal(client.calls.length, 0, 'disabled means zero client calls')
  plugin()
})

test('TTL: within TTL repeated reads -> single fetch; after TTL -> stale read + background refetch, then fresh', async () => {
  const client = fakeClient()
  let now = 0
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(
    rootCtx,
    baseDeps({ client, ttlMs: 60_000, now: () => now })
  )
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })
  await flush()
  assert.equal(client.calls.length, 1, 'warm-up fetch')

  const text = sections[0].text
  assert.equal(text(), HEADER + 'CONTEXT-BODY')
  assert.equal(text(), HEADER + 'CONTEXT-BODY')
  assert.equal(client.calls.length, 1, 'fresh cache within TTL: no refetch')

  now = 60_001 // past the TTL
  assert.equal(text(), HEADER + 'CONTEXT-BODY', 'stale text served while refresh kicks')

  await flush() // the kicked refresh passes the resolver and hits the client
  assert.equal(client.calls.length, 2, 'background refetch kicked (call count +1)')

  await flush()
  assert.equal(text(), HEADER + 'CONTEXT-BODY', 'fresh text after refresh lands')
  assert.equal(client.calls.length, 2, 'now fresh again: no extra call')
  plugin()
})

test('cache is keyed per agent: different agents fetch independently', async () => {
  const client = fakeClient()
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client, now: () => 0 }))
  const a = fakeAgent({ sessionId: 's-a' })
  const b = fakeAgent({ sessionId: 's-b' })
  rootCtx.emit('agent/created', { agent: a.agent, source: 'startup' })
  rootCtx.emit('agent/created', { agent: b.agent, source: 'startup' })
  await flush()

  assert.equal(a.sections[0].text(), HEADER + 'CONTEXT-BODY')
  assert.equal(b.sections[0].text(), HEADER + 'CONTEXT-BODY')
  assert.equal(client.calls.length, 2, 'one fetch per distinct agent')
  plugin()
})

test('warm at registration: one client call after flush even before any text() read', async () => {
  const client = fakeClient()
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client }))
  const { agent } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  assert.equal(client.calls.length, 0, 'refresh is async: not yet at emit time')
  await flush()
  assert.equal(client.calls.length, 1, 'warm-up refresh landed without any read')
  plugin()
})

test('agent ctx without systemPrompt -> skip + note, no throw', async () => {
  const notes = []
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ note: (m) => notes.push(m) }))
  const { agent, sections } = fakeAgent({ withSystemPrompt: false })
  rootCtx.emit('agent/created', { agent, source: 'startup' })
  await flush()

  assert.equal(sections.length, 0, 'no section registered')
  assert.ok(notes.length >= 1, 'skip surfaced via note')
  plugin()
})

test('combined effect disposer: section disposer invoked AND agent dropped from plugin map', async () => {
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps())
  const { agent, effects, disposals } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  assert.equal(effects.length, 1)
  effects[0]() // cordis disposal
  assert.deepEqual(disposals, ['engram:memory'], 'section disposer was invoked')
  plugin()
})

test('registerContextInjection returns a disposer that unregisters the agent/created listener', () => {
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps())
  assert.equal(typeof plugin, 'function', 'bare disposer returned')
  plugin()
  assert.equal(rootCtx.listeners.get('agent/created').length, 0, 'listener removed')
})

// Final-review fix: plugin dispose must invoke the retained combined
// disposers, so a STILL-LIVE agent's prompt section does not outlive the
// plugin. Fake effect returns a real disposer running the inner (section)
// disposer, mirroring cordis's effect-disposal semantics.
test('plugin dispose invokes retained disposers: a live agent\'s section is removed', async () => {
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps())
  const sections = []
  const disposals = []
  const ctx = {
    // Real cordis effect: returns a disposer that runs the body's disposer.
    effect(fn) {
      const inner = fn()
      return () => { if (typeof inner === 'function') inner() }
    },
    systemPrompt: {
      section(def) {
        sections.push(def)
        return () => disposals.push(def.name)
      },
    },
  }
  const agent = { ctx, session: { id: 's-live' } }
  rootCtx.emit('agent/created', { agent, source: 'startup' })
  await flush()

  plugin() // plugin unload while the agent is still alive
  assert.deepEqual(disposals, ['engram:memory'], 'live agent section disposer ran on plugin dispose')
  assert.equal(rootCtx.listeners.get('agent/created').length, 0, 'listener also removed')
})
