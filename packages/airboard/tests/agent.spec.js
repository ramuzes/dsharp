/**
 * Agent-surface contract tests: the upstream JSON client's error mapping, the
 * five tools' behavior over a strict fake client, and the apply() wiring
 * (tools + prompt section registered independently of the web server, token
 * hot-swap through credentials/reference-updated).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createAirboardClient, AirboardError } from '../lib/agent-api.js'
import { registerAgentTools, AIRBOARD_PROMPT_TEXT } from '../lib/agent-tools.js'

// --- client -----------------------------------------------------------------

/** Strict fetch double: mirrors real fetch (ok/status/json(), URL input). */
function fakeFetch({ status = 200, body = {}, network } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (network !== undefined) throw network
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
  impl.calls = calls
  return impl
}

test('client sends bearer token, query params, and JSON bodies', async () => {
  const fetchImpl = fakeFetch({ body: { ok: true } })
  const client = createAirboardClient({ baseUrl: 'http://ab.example/', tokenProvider: () => 'abt_x', fetchImpl })
  await client.get('/api/search', { q: '龙虎', limit: 10 })
  await client.post('/api/projects/K/resources', { kind: 'ADR', title: 't', markdown: 'm' })
  const [get, post] = fetchImpl.calls
  assert.equal(get.url, 'http://ab.example/api/search?q=%E9%BE%99%E8%99%8E&limit=10', 'query serialized, empty values dropped')
  assert.equal(get.init.headers.authorization, 'Bearer abt_x')
  assert.equal(get.init.method, 'GET')
  assert.equal(post.init.method, 'POST')
  assert.equal(post.init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(post.init.body), { kind: 'ADR', title: 't', markdown: 'm' })
})

test('client omits the auth header when no token is configured', async () => {
  const fetchImpl = fakeFetch({ body: [] })
  const client = createAirboardClient({ baseUrl: 'http://ab.example', fetchImpl })
  await client.get('/api/projects')
  assert.equal(fetchImpl.calls[0].init.headers.authorization, undefined)
})

test('client maps upstream errors and network faults to AirboardError', async () => {
  const client = createAirboardClient({
    baseUrl: 'http://ab.example',
    fetchImpl: fakeFetch({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'outside token scope' } } }),
  })
  await assert.rejects(() => client.get('/api/projects'), e => {
    assert.ok(e instanceof AirboardError)
    assert.equal(e.code, 'airboard/upstream-error')
    assert.equal(e.status, 403)
    assert.match(e.message, /outside token scope/)
    return true
  })
  const dead = createAirboardClient({ baseUrl: 'http://ab.example', fetchImpl: fakeFetch({ network: new Error('ECONNREFUSED') }) })
  await assert.rejects(() => dead.get('/api/projects'), e => {
    assert.equal(e.code, 'airboard/unreachable')
    return true
  })
})

// --- tools ------------------------------------------------------------------

/** A context double capturing tools + prompt sections; executes stay sync. */
function makeCtx() {
  const registered = { tools: new Map(), sections: [], disposes: [] }
  return {
    registered,
    tools: { register: (tool) => { registered.tools.set(tool.name, tool); return () => registered.tools.delete(tool.name) } },
    systemPrompt: { section: (s) => { registered.sections.push(s); return () => {} } },
  }
}

/** A strict client double: records calls, answers from a handler map. */
function makeClient(handler) {
  const calls = []
  return {
    calls,
    get: async (path, query, signal) => { calls.push({ method: 'GET', path, query, signal }); return handler.get(path, query) },
    post: async (path, body, signal) => { calls.push({ method: 'POST', path, body, signal }); return handler.post(path, body) },
    patch: async (path, body, signal) => { calls.push({ method: 'PATCH', path, body, signal }); return handler.patch(path, body) },
  }
}

const RUN = { signal: undefined }

test('registration: five tools, one prompt section, disposer removes all', () => {
  const ctx = makeCtx()
  const off = registerAgentTools(ctx, makeClient({ get: () => [], post: () => ({}), patch: () => ({}) }))
  assert.deepEqual([...ctx.registered.tools.keys()].sort(),
    ['airboard_create_resource', 'airboard_list_projects', 'airboard_read_resource', 'airboard_search', 'airboard_update_resource'])
  const section = ctx.registered.sections[0]
  assert.equal(section.name, 'tool:airboard')
  assert.equal(section.text, AIRBOARD_PROMPT_TEXT)
  assert.ok(section.order > 2300 && section.order < 2400, 'slotted after session-query, before goal')
  off()
  assert.equal(ctx.registered.tools.size, 0)
})

test('airboard_search passes bounded filters and stringifies slim hits', async () => {
  const client = makeClient({ get: (path, query) => { assert.equal(path, '/api/search'); return query } })
  const ctx = makeCtx()
  registerAgentTools(ctx, client)
  const out = await ctx.registered.tools.get('airboard_search').execute({ q: 'topn filter', kind: 'ADR', limit: 999, offset: -5 }, RUN)
  const parsed = JSON.parse(out)
  assert.equal(parsed.limit, 50, 'limit clamped to the cap')
  assert.equal(parsed.offset, 0, 'negative offset normalized')
  assert.equal(parsed.kind, 'ADR')
})

test('airboard_read_resource renders title, id, status, and full markdown', async () => {
  const client = makeClient({ get: path => ({ id: 'ADR-1', title: 'TopN filter', status: 'active', content_markdown: '# body' }) })
  const ctx = makeCtx()
  registerAgentTools(ctx, client)
  const out = await ctx.registered.tools.get('airboard_read_resource').execute({ project_key: 'QUEMINI', id: 'ADR-1' }, RUN)
  assert.match(out, /TopN filter \[ADR-1 · active\]/)
  assert.match(out, /# body/)
  assert.equal(client.calls[0].path, '/api/projects/QUEMINI/resources/ADR-1')
})

test('create and update use the documented write contract; update maps markdown → content_markdown', async () => {
  const client = makeClient({
    post: (path, body) => ({ id: 'SPEC-7', status: 'draft' }),
    patch: (path, body) => ({ id: 'SPEC-7', status: 'active' }),
  })
  const ctx = makeCtx()
  registerAgentTools(ctx, client)
  const created = await ctx.registered.tools.get('airboard_create_resource')
    .execute({ project_key: 'QUEMINI', kind: 'SPEC', title: 'T', markdown: 'M' }, RUN)
  assert.match(created, /Created SPEC-7 \(status draft\)/)
  assert.deepEqual(client.calls[0].body, { kind: 'SPEC', title: 'T', markdown: 'M' })

  const updated = await ctx.registered.tools.get('airboard_update_resource')
    .execute({ project_key: 'QUEMINI', id: 'SPEC-7', markdown: 'M2', status: 'active' }, RUN)
  assert.match(updated, /Updated SPEC-7 \(status active\)/)
  assert.deepEqual(client.calls[1].body, { content_markdown: 'M2', status: 'active' }, 'markdown mapped, untouched fields omitted')

  const noop = await ctx.registered.tools.get('airboard_update_resource').execute({ project_key: 'P', id: 'X-1' }, RUN)
  assert.match(noop, /Nothing to update/)
  assert.equal(client.calls.length, 2, 'no upstream call without fields')
})

test('tool failures render as text naming the error code — never rethrow', async () => {
  const client = makeClient({ get: () => { throw new AirboardError('airboard/upstream-error', 'HTTP 403: scoped token', 403) } })
  const ctx = makeCtx()
  registerAgentTools(ctx, client)
  const out = await ctx.registered.tools.get('airboard_list_projects').execute({}, RUN)
  assert.match(out, /airboard\/upstream-error HTTP 403/)
  assert.match(out, /scoped token/)
})

// --- wiring -----------------------------------------------------------------

test('apply registers agent tools WITHOUT a web server and hot-swaps the token', async () => {
  const { apply } = await import('../index.js')
  let stored = 'abt_first'
  const events = []
  const strictScopes = []
  let injectCallback = undefined
  const ctx = {
    tools: { register: t => { events.push(['tool', t.name]); return () => {} } },
    systemPrompt: { section: s => { events.push(['section', s.name]); return () => {} } },
    on: (name, fn) => { events.push(['on', name]); return () => {} },
    inject(deps, fn) {
      events.push(['inject', ...deps])
      if (deps.includes('credentials') && !deps.includes('webServer')) {
        // Strict scope: ONLY the injected services exist — cordis throws on
        // property access for anything else (the live-mount lesson).
        const scope = { on: ctx.on }
        for (const dep of deps) scope[dep] = ctx[dep]
        strictScopes.push(scope)
        injectCallback = fn
      }
      return () => {}
    },
    credentials: { resolve: async ref => (ref === 'AIRBOARD_TOKEN' ? { value: stored } : undefined) },
  }
  apply(ctx, { baseUrl: 'http://ab.example', tokenEnv: 'AIRBOARD_TOKEN' })
  assert.ok(events.some(e => e[0] === 'inject' && e.slice(1).includes('credentials') && !e.includes('webServer')), 'credentials inject without webServer exists')
  assert.ok(injectCallback, 'agent-tools inject captured')
  const agentScope = strictScopes.at(-1)
  assert.ok(agentScope.tools !== undefined && agentScope.systemPrompt !== undefined, 'inject list carries the services registerAgentTools touches')
  await injectCallback(agentScope)
  assert.ok(events.some(e => e[0] === 'tool' && e[1] === 'airboard_search'), 'tools registered without webServer')
  assert.ok(events.some(e => e[0] === 'section' && e[1] === 'tool:airboard'))
})
