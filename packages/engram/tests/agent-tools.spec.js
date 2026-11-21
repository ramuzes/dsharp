// Tests for the agent-facing engram tools + prompt section. The fake ctx
// exposes only the `tools` and `systemPrompt` services (house style: a fake
// inject scope that exposes just what the registering callback injects), and
// the fake client/resolver mirror the real lib signatures exactly.
import test from 'node:test'
import assert from 'node:assert/strict'

import { EngramError } from '../lib/engram-api.js'
import {
  ProjectAmbiguousError,
  ProjectExplicitRequiredError,
} from '../lib/project-resolution.js'
import { registerAgentTools, ENGRAM_PROMPT_TEXT } from '../lib/agent-tools.js'

/** Fake ctx with only tools + systemPrompt. */
function makeCtx() {
  const registered = []
  const sections = []
  return {
    registered,
    sections,
    tools: {
      register: (tool) => {
        registered.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section: (s) => {
        sections.push(s)
        return () => {}
      },
    },
  }
}

/** Fake engram client recording get/post calls. */
function makeClient({ get, post } = {}) {
  const calls = { get: [], post: [] }
  return {
    calls,
    get: async (path, query, signal) => {
      calls.get.push({ path, query, signal })
      if (get) return get(path, query, signal)
      return {}
    },
    post: async (path, body, signal) => {
      calls.post.push({ path, body, signal })
      if (post) return post(path, body, signal)
      return { ok: true }
    },
    del: async () => ({}),
  }
}

const EXEC = { callId: 'call-1', agent: { session: { id: 'sess-1' } }, signal: undefined }

/** deps with fakes; resolveProject is overridable per test. */
function makeDeps(client, resolveProject, ensureSession) {
  return {
    client,
    resolveProject: resolveProject ?? (async () => ({ project: 'proj-x', source: 'map' })),
    ensureReady: async () => {},
    ensureSession: ensureSession ?? (async () => {}),
    sessionIdOf: (agent) => agent?.session?.id ?? '',
  }
}

const toolOf = (ctx, name) => ctx.registered.find((t) => t.name === name)

test('registers exactly the 7 tools plus the tool:engram prompt section', () => {
  const ctx = makeCtx()
  const dispose = registerAgentTools(ctx, makeDeps(makeClient()))
  assert.equal(ctx.registered.length, 7)
  assert.deepEqual(
    ctx.registered.map((t) => t.name).sort(),
    ['engram_cloud_status', 'engram_context', 'engram_projects', 'engram_save', 'engram_search', 'engram_stats', 'engram_timeline'],
  )
  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].name, 'tool:engram')
  assert.equal(ctx.sections[0].order, 2370)
  assert.equal(typeof dispose, 'function')
})

// Valid sample args per read-only tool: the defineTool-wrapped classifier
// soft-validates its args and returns false for invalid ones (real dsh-tools
// strictness — the host classifies with the call's real arguments).
const CONCURRENCY_ARGS = {
  engram_search: { q: 'x' },
  engram_context: {},
  engram_timeline: { observation_id: 'o1' },
  engram_stats: {},
  engram_projects: {},
  engram_cloud_status: {},
}

test('read-only tools declare isConcurrencySafe; engram_save does not', () => {
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(makeClient()))
  for (const name of ['engram_search', 'engram_context', 'engram_timeline', 'engram_stats', 'engram_projects', 'engram_cloud_status']) {
    assert.equal(toolOf(ctx, name).isConcurrencySafe(CONCURRENCY_ARGS[name]), true, name)
  }
  assert.ok(!('isConcurrencySafe' in toolOf(ctx, 'engram_save')))
})

test('ENGRAM_PROMPT_TEXT carries the save-worthiness policy keywords', () => {
  for (const kw of ['decisions', 'preferences', 'constraints', 'conclusions', 'transient', 're-derivable', 'secrets', 'search before saving']) {
    assert.ok(ENGRAM_PROMPT_TEXT.includes(kw), `missing keyword: ${kw}`)
  }
})

test('engram_save description embeds the policy (contains durable and not)', () => {
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(makeClient()))
  const desc = toolOf(ctx, 'engram_save').description
  assert.ok(desc.includes('durable'))
  assert.ok(desc.includes('not'))
})

test('save happy path: operation_id is exec.callId and project is resolved', async () => {
  const client = makeClient()
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(client))
  const result = await toolOf(ctx, 'engram_save').execute(
    { title: 'T', content: 'C', type: 'decision' }, EXEC)
  assert.equal(client.calls.post.length, 1)
  const { path, body, signal } = client.calls.post[0]
  assert.equal(path, '/observations')
  assert.equal(body.session_id, 'sess-1')
  assert.equal(body.title, 'T')
  assert.equal(body.content, 'C')
  assert.equal(body.type, 'decision')
  assert.equal(body.project, 'proj-x')
  assert.equal(body.operation_id, 'call-1')
  assert.equal(signal, EXEC.signal)
  assert.ok(typeof result === 'string')
})

test('ambiguous project error: text lists available names and mentions the project parameter', async () => {
  const client = makeClient()
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(client, async () => {
    throw new ProjectAmbiguousError(['alpha', 'beta'])
  }))
  const result = await toolOf(ctx, 'engram_search').execute({ q: 'x' }, EXEC)
  assert.ok(result.includes('alpha'))
  assert.ok(result.includes('beta'))
  assert.ok(result.includes('project'))
  assert.equal(client.calls.get.length, 0)
})

test('explicit-required error: text points at configuration', async () => {
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(makeClient(), async () => {
    throw new ProjectExplicitRequiredError()
  }))
  const result = await toolOf(ctx, 'engram_search').execute({ q: 'x' }, EXEC)
  assert.ok(result.includes('engram/project-explicit-required'))
  assert.ok(result.includes('config'))
})

test('EngramError maps to code + server error text', async () => {
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(makeClient(), async () => {
    throw new EngramError('engram/http', 'engram/http: GET /stats -> 500: boom', { status: 500 })
  }))
  const result = await toolOf(ctx, 'engram_stats').execute({}, EXEC)
  assert.ok(result.includes('engram/http'))
  assert.ok(result.includes('boom'))
})

test('oversized output is truncated at 8000 chars with a marker', async () => {
  const big = 'x'.repeat(10000)
  const client = makeClient({ get: async () => ({ content: big }) })
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(client))
  const result = await toolOf(ctx, 'engram_context').execute({}, EXEC)
  assert.ok(result.length <= 8013)
  assert.ok(result.endsWith('…[truncated]'))
})

test('save retries session registration once: one reject then resolve succeeds', async () => {
  let attempts = 0
  const ensureSession = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('session vanished')
  }
  const client = makeClient()
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(client, undefined, ensureSession))
  const result = await toolOf(ctx, 'engram_save').execute({ title: 'T', content: 'C' }, EXEC)
  assert.equal(attempts, 2)
  assert.ok(!result.includes('session registration failed'))
  assert.equal(client.calls.post.length, 1)
})

test('save with ensureSession rejecting twice surfaces a session-registration error', async () => {
  const ensureSession = async () => { throw new Error('daemon gone') }
  const client = makeClient()
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(client, undefined, ensureSession))
  const result = await toolOf(ctx, 'engram_save').execute({ title: 'T', content: 'C' }, EXEC)
  assert.ok(result.includes('session'))
  assert.ok(result.includes('daemon gone'))
  assert.equal(client.calls.post.length, 0)
})

test('search limit defaults to 20 and clamps to max 50', async () => {
  const client = makeClient()
  const ctx = makeCtx()
  registerAgentTools(ctx, makeDeps(client))
  await toolOf(ctx, 'engram_search').execute({ q: 'x' }, EXEC)
  assert.equal(client.calls.get[0].query.limit, 20)
  await toolOf(ctx, 'engram_search').execute({ q: 'x', limit: 100 }, EXEC)
  assert.equal(client.calls.get[1].query.limit, 50)
  await toolOf(ctx, 'engram_search').execute({ q: 'x', limit: 7 }, EXEC)
  assert.equal(client.calls.get[2].query.limit, 7)
})

test('engram_save with no session context fails fast with a model-readable message and no POST', async () => {
  const client = makeClient()
  const ctx = makeCtx()
  registerAgentTools(ctx, { ...makeDeps(client), sessionIdOf: () => '' })
  const result = await toolOf(ctx, 'engram_save').execute(
    { title: 'T', content: 'C' }, { callId: 'c2', agent: undefined })
  assert.ok(typeof result === 'string')
  assert.ok(result.includes('no session context available'), result)
  assert.ok(result.includes('cannot associate the observation'), result)
  assert.equal(client.calls.post.length, 0, 'guard fires before any POST')
})
