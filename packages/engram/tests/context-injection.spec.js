/*
 * Proactive context injection tests (Task 7).
 *
 * Fakes mirror the real interfaces strictly:
 *  - root ctx: `on(name, fn)` captures listeners; the real `agent/created`
 *    payload is { agent, source, signal? } (dsh packages/core/agent/src/
 *    index.ts:575, runtime-types.ts:291) — listener destructures { agent }.
 *  - agent ctx: `effect(fn)` runs the body synchronously at registration and
 *    keeps the returned disposer for fiber disposal (vendor/cordis/lib/
 *    index.js:460-461, 487). `systemPrompt.section({ name, order, text })`
 *    mirrors dsh's prompt-section registration (the section's `text` is a
 *    zero-arg provider — dsh packages/core/system-prompt/src receives only
 *    PromptSection.text, no session identity).
 *  - client: { get } — GET /context with query { project, compact: 'true',
 *    max_bytes }; real 200 body is JSON with a `context` string field.
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

/**
 * Fake agent whose ctx.systemPrompt.section captures the registered section.
 * Returns { agent, effects, disposals, section } — call section.text() to
 * run the provider like prompt assembly would.
 */
function fakeAgent({ sessionId = 's-1', cwd = '/w/proj', withSystemPrompt = true } = {}) {
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
        return () => disposals.push(def.name)
      },
    }
  }
  const agent = { ctx }
  if (sessionId !== undefined) agent.session = { id: sessionId, cwd }
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

test('enabled + healthy: section registered via agent.ctx.effect; text = header + fetched context', async () => {
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

  const text = await sections[0].text()
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].path, '/context')
  assert.deepEqual(client.calls[0].query, { project: 'proj-a', compact: 'true', max_bytes: 2048 })
  assert.ok(text.startsWith(HEADER), 'text starts with the engram header')
  assert.ok(text.includes('CONTEXT-BODY'), 'text contains fetched context')
  plugin()
})

test('ambiguous project (resolver throws) -> provider returns empty string + note, zero client calls', async () => {
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

  const text = await sections[0].text()
  assert.equal(text, '', 'fail-open: empty text contributes nothing')
  assert.equal(client.calls.length, 0, 'no client call on unresolved project')
  assert.ok(notes.length >= 1, 'note called')
  plugin()
})

test('client rejects -> empty string, no throw into prompt assembly (fail-open) + note', async () => {
  const client = fakeClient()
  client.get = async () => {
    throw new Error('daemon down')
  }
  const notes = []
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client, note: (m) => notes.push(m) }))
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  const text = await sections[0].text()
  assert.equal(text, '')
  assert.ok(notes.length >= 1, 'note called on client failure')
  plugin()
})

test('client returns non-JSON / missing context field -> empty string + note', async () => {
  const client = fakeClient()
  client.get = async () => 'not-an-object'
  const notes = []
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client, note: (m) => notes.push(m) }))
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  const text = await sections[0].text()
  assert.equal(text, '')
  assert.ok(notes.length >= 1)
  plugin()
})

test('disabled -> empty string and ZERO client calls', async () => {
  const client = fakeClient()
  const rootCtx = fakeRootCtx()
  let enabled = false
  const plugin = registerContextInjection(rootCtx, baseDeps({ client, getEnabled: () => enabled }))
  const { agent, sections } = fakeAgent()
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  const text = await sections[0].text()
  assert.equal(text, '')
  assert.equal(client.calls.length, 0, 'disabled means zero client calls')
  plugin()
})

test('TTL cache per (session, cwd): two provider calls within TTL -> 1 client call; after TTL -> 2', async () => {
  const client = fakeClient()
  let now = 0
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(
    rootCtx,
    baseDeps({ client, ttlMs: 60_000, now: () => now })
  )
  const { agent, sections } = fakeAgent()

  rootCtx.emit('agent/created', { agent, source: 'startup' })
  const text = sections[0].text

  await text()
  await text()
  assert.equal(client.calls.length, 1, 'cached within TTL')
  assert.equal(await text(), HEADER + 'CONTEXT-BODY', 'cached text is stable')

  now = 60_001 // past the TTL
  await text()
  assert.equal(client.calls.length, 2, 'refetched after TTL')
  plugin()
})

test('cache is keyed per (session, cwd): different sessions fetch independently', async () => {
  const client = fakeClient()
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ client, now: () => 0 }))
  const a = fakeAgent({ sessionId: 's-a' })
  const b = fakeAgent({ sessionId: 's-b' })
  rootCtx.emit('agent/created', { agent: a.agent, source: 'startup' })
  rootCtx.emit('agent/created', { agent: b.agent, source: 'startup' })

  await a.sections[0].text()
  await b.sections[0].text()
  assert.equal(client.calls.length, 2, 'one fetch per distinct (session, cwd)')
  plugin()
})

test('agent ctx without systemPrompt -> skip + note, no throw', async () => {
  const notes = []
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps({ note: (m) => notes.push(m) }))
  const { agent, sections } = fakeAgent({ withSystemPrompt: false })
  rootCtx.emit('agent/created', { agent, source: 'startup' })

  assert.equal(sections.length, 0, 'no section registered')
  assert.ok(notes.length >= 1, 'skip surfaced via note')
  plugin()
})

test('registerContextInjection returns a disposer that unregisters the agent/created listener', () => {
  const rootCtx = fakeRootCtx()
  const plugin = registerContextInjection(rootCtx, baseDeps())
  assert.equal(typeof plugin, 'function', 'disposer returned')
  plugin()
  assert.equal(rootCtx.listeners.get('agent/created').length, 0, 'listener removed')
})
