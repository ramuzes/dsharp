/**
 * Tests for the model-facing roster tools (Task 5). The registration API
 * mirrors engram's lib/agent-tools.js (this repo's precedent): defineTool
 * from '@deepseek-ai/dsh-tools', TEXT_OUTPUT-style plain-text output, a
 * `register` helper pushing disposers, and a failure() mapper that never
 * rethrows a raw error into the host.
 *
 * Fakes mirror real strictness (AGENTS.md): the fake tools scope exposes
 * ONLY the `tools` service — the one name the registering callback injects
 * (property access beyond the inject list throws in cordis) — and the
 * apply-level fake host is the host.spec.js makeFakeHost shape (framework
 * surface inject/effect/get only; everything else throws like a
 * non-injected service access). The upsert and list tests drive the REAL
 * AgentRosterService over the REAL store in memory mode, so name-taken and
 * patch-semantics enforcement is the production one, not a fake's.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { apply, setServiceFactoryForTests } from '../index.js'
import { openRosterStore } from '../lib/store.js'
import { AgentRosterService } from '../lib/roster-service.js'
import { registerRosterTools } from '../lib/agent-tools.js'

/** Fixed timestamp for fake-service returns. */
const T0 = '2026-11-22T12:00:00.000Z'

/** Minimal exec: the roster tools consume no exec members. */
const EXEC = { callId: 'call-1' }

const toolOf = (scope, name) => scope.registered.find((t) => t.name === name)

/** Fake inject scope exposing ONLY the injected `tools` service. */
function makeToolsScope() {
  const registered = []
  const disposed = []
  return {
    registered,
    disposed,
    tools: {
      // Real register returns the exact disposer that unregisters the tool
      // (dsh packages/core/tools/src/index.ts:128).
      register: (tool) => {
        registered.push(tool)
        return () => { disposed.push(tool.name) }
      },
    },
  }
}

/** Recording service: exactly the two remote methods the tools consume. */
function makeRecordingService(overrides = {}) {
  const calls = { saveTemplate: [], listTemplates: 0 }
  return {
    calls,
    async saveTemplate(input) {
      calls.saveTemplate.push(input)
      return overrides.saveTemplate ? overrides.saveTemplate(input) : {
        id: 't1', name: input.name, description: '', prompt: input.prompt,
        defaultModel: null, createdAt: T0, updatedAt: T0,
      }
    },
    async listTemplates() {
      calls.listTemplates += 1
      return overrides.listTemplates ? overrides.listTemplates() : []
    },
  }
}

/**
 * The REAL service over the REAL store in memory mode (no storageDomain
 * service — the store's documented fallback): upsert and list behavior is
 * enforced by production code. Object.create(prototype) because the
 * TypertRemoteService constructor needs a genuine cordis Context — the
 * host.spec.js makeRoster precedent.
 */
function makeRoster() {
  const store = openRosterStore({ get: () => undefined })
  const service = Object.create(AgentRosterService.prototype)
  service.store = store
  return { service, store }
}

/**
 * Fake host (host.spec.js makeFakeHost shape): ctx carries only the
 * framework surface (inject / effect / get); everything else throws like a
 * non-injected service access in cordis.
 */
function makeFakeHost(services = {}) {
  const injects = []
  const effects = []
  const framework = {
    inject: (names, fn) => { injects.push({ names, fn }) },
    effect: (fn, label) => {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
    get: (name) => services[name],
  }
  const ctx = new Proxy(framework, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      throw new Error(`cannot get property ${String(prop)} without inject`)
    },
  })
  return { ctx, injects, effects }
}

/** Run body with AGENT_ROSTER_STATUS_FILE pointed at a fresh temp file. */
async function withStatusFile(run) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-roster-t5-'))
  const file = join(dir, 'status.json')
  const prev = process.env.AGENT_ROSTER_STATUS_FILE
  process.env.AGENT_ROSTER_STATUS_FILE = file
  try {
    await run(file)
  } finally {
    setServiceFactoryForTests(undefined)
    if (prev === undefined) delete process.env.AGENT_ROSTER_STATUS_FILE
    else process.env.AGENT_ROSTER_STATUS_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The subagents fake: real activation signature, records every spawn. */
function makeSubagents(overrides = {}) {
  const calls = { listDescendants: [], startActivation: [] }
  const rootAgent = { id: 'root-session', name: 'lead' }
  const fake = {
    calls,
    rootAgent,
    rootOf: (caller) => { calls.rootOf = caller; return rootAgent },
    listDescendants: async (sessionId) => {
      calls.listDescendants.push(sessionId)
      return overrides.descendants ?? [{ kind: 'child', depth: 1, path: 'existing-member' }]
    },
    startActivation: async (spec) => {
      calls.startActivation.push(spec)
      return { kind: 'activation', name: spec.name, childId: 'child-session-1', result: { promise: Promise.resolve(undefined) } }
    },
  }
  return fake
}

test('registerRosterTools registers three tools; the disposer unregisters all', () => {
  const scope = makeToolsScope()
  const subagents = makeSubagents()
  const dispose = registerRosterTools(scope, makeRecordingService(), { store: makeRoster().store, subagents })
  assert.deepEqual(
    scope.registered.map((t) => t.name).sort(),
    ['roster_spawn', 'roster_template_list', 'roster_template_save'],
  )
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.deepEqual(scope.disposed.sort(), ['roster_spawn', 'roster_template_list', 'roster_template_save'])
})

test('the authoring toggle drops save/list but keeps the spawn tool', () => {
  const scope = makeToolsScope()
  const dispose = registerRosterTools(scope, makeRecordingService(), { store: makeRoster().store, subagents: makeSubagents() }, { authoring: false })
  assert.deepEqual(scope.registered.map((t) => t.name), ['roster_spawn'])
  dispose()
  assert.deepEqual(scope.disposed, ['roster_spawn'])
})

test('roster_template_list is concurrency-safe; roster_template_save is not', () => {
  const scope = makeToolsScope()
  registerRosterTools(scope, makeRecordingService(), { store: makeRoster().store, subagents: makeSubagents() })
  // Read-only declares isConcurrencySafe (the call may join a parallel
  // group — dsh packages/core/tools/src/contracts.ts:84); the mutating
  // save does not (engram_save precedent).
  assert.equal(toolOf(scope, 'roster_template_list').isConcurrencySafe({}), true)
  assert.ok(!('isConcurrencySafe' in toolOf(scope, 'roster_template_save')))
})

test('save upserts by name: the second save with the same name reuses the id', async () => {
  const { service } = makeRoster()
  const scope = makeToolsScope()
  registerRosterTools(scope, service)
  const save = toolOf(scope, 'roster_template_save')

  const first = JSON.parse(await save.execute(
    { name: 'Reviewer', prompt: 'v1', description: 'd1' }, EXEC))
  assert.match(first.id, /^[0-9a-f]{10}$/, 'fresh short-random hex id')
  assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'updatedAt'],
    'short bilingual-safe summary only')

  const second = JSON.parse(await save.execute({
    name: 'Reviewer',
    prompt: 'v2',
    default_model: { provider: 'p', model: 'm', reasoning_effort: 'high' },
  }, EXEC))
  assert.equal(second.id, first.id,
    'exact name match reuses the existing record id instead of tripping roster/name-taken')

  // The store now holds ONE updated record — never a duplicate.
  const stored = await service.listTemplates()
  assert.equal(stored.length, 1)
  assert.equal(stored[0].prompt, 'v2')
  assert.equal(stored[0].description, 'd1', 'omitted description preserved (service patch semantics)')
  assert.deepEqual(stored[0].defaultModel, { provider: 'p', model: 'm', reasoningEffort: 'high' },
    'default_model maps to defaultModel with reasoning_effort → reasoningEffort')
})

test('save calls the service method with the mapped input and summarizes its return', async () => {
  const service = makeRecordingService()
  const scope = makeToolsScope()
  registerRosterTools(scope, service)
  const result = await toolOf(scope, 'roster_template_save').execute(
    { name: 'Writer', description: 'prose', prompt: 'Write.', default_model: { provider: 'p', model: 'm' } },
    EXEC)
  // By-name resolution goes through the SAME service read (one operation,
  // two callers): one listTemplates, then one saveTemplate.
  assert.equal(service.calls.listTemplates, 1)
  assert.equal(service.calls.saveTemplate.length, 1)
  assert.deepEqual(service.calls.saveTemplate[0], {
    name: 'Writer',
    description: 'prose',
    prompt: 'Write.',
    defaultModel: { provider: 'p', model: 'm' },
  }, 'no id key on create; snake_case default_model mapped to defaultModel')
  assert.deepEqual(JSON.parse(result), { id: 't1', name: 'Writer', updatedAt: T0 })
})

test('list omits prompt: records carry exactly id, name, description, defaultModel, updatedAt', async () => {
  const { service } = makeRoster()
  await service.saveTemplate({
    name: 'Reviewer', prompt: 'Review diffs.', description: 'desc',
    defaultModel: { provider: 'p', model: 'm' },
  })
  await service.saveTemplate({ name: 'Writer', prompt: 'Write prose.' })
  const scope = makeToolsScope()
  registerRosterTools(scope, service)
  const records = JSON.parse(await toolOf(scope, 'roster_template_list').execute({}, EXEC))
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((r) => r.name), ['Reviewer', 'Writer'], 'insertion order')
  assert.deepEqual(Object.keys(records[0]).sort(),
    ['defaultModel', 'description', 'id', 'name', 'updatedAt'])
  for (const rec of records) {
    assert.equal('prompt' in rec, false, 'prompt deliberately omitted to keep context light')
  }
  assert.deepEqual(records[0].defaultModel, { provider: 'p', model: 'm' })
  assert.equal(records[1].defaultModel, null)
})

test('save with default_model: null clears the stored model through the tool schema', async () => {
  const { service } = makeRoster()
  const scope = makeToolsScope()
  registerRosterTools(scope, service)
  const save = toolOf(scope, 'roster_template_save')
  const first = JSON.parse(await save.execute(
    { name: 'Reviewer', prompt: 'v1', default_model: { provider: 'p', model: 'm' } }, EXEC))
  // `default_model: null` rides the oneOf null branch of the real tool
  // schema (defineTool validates before execute) and must CLEAR the stored
  // model, not preserve it — the documented explicit-null contract.
  const second = JSON.parse(await save.execute(
    { name: 'Reviewer', prompt: 'v2', default_model: null }, EXEC))
  assert.equal(second.id, first.id, 'still an upsert by name')
  const [stored] = await service.listTemplates()
  assert.equal(stored.defaultModel, null, 'explicit null clears the stored model')
  assert.equal(stored.prompt, 'v2')
})

test('service failures map to model-facing text and never rethrow', async () => {
  const service = makeRecordingService({
    saveTemplate: () => {
      throw new RemoteError('roster/name-taken',
        'Template name "X" is already taken / 模板名称 "X" 已被占用', { name: 'X' })
    },
  })
  const scope = makeToolsScope()
  registerRosterTools(scope, service)
  const result = await toolOf(scope, 'roster_template_save').execute(
    { name: 'X', prompt: 'p' }, EXEC)
  assert.equal(typeof result, 'string')
  assert.ok(result.includes('roster/name-taken'), result)
  assert.ok(result.includes('already taken'), result)
})

test('apply registers the tools inject and all three tools when exposeAgentTools reads true', async () => {
  await withStatusFile(async (file) => {
    const host = makeFakeHost()
    setServiceFactoryForTests(() => makeRecordingService())
    apply(host.ctx, { exposeAgentTools: { get: () => true } })
    assert.equal(host.injects.length, 1, 'exactly one inject callback')
    // roster_spawn resolves the tree root through `subagents`, so that name
    // must be injected on the same callback (AGENTS.md 3).
    assert.deepEqual(host.injects[0].names, ['tools', 'subagents'],
      'the callback injects both services it touches')
    // Drive the callback like real cordis once both services are available.
    const scope = makeToolsScope()
    scope.subagents = makeSubagents()
    const offInject = host.injects[0].fn(scope)
    assert.deepEqual(scope.registered.map((t) => t.name).sort(),
      ['roster_spawn', 'roster_template_list', 'roster_template_save'])
    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.stage, 'tools-registered')
    assert.equal(record.detail.authoring, true, 'the stage detail records the toggle state')
    // The callback returns its disposal; invoking it unregisters the tools.
    assert.equal(typeof offInject, 'function')
    offInject()
    assert.deepEqual(scope.disposed.sort(), ['roster_spawn', 'roster_template_list', 'roster_template_save'])
  })
})

test('a registration failure writes tools-failed with the error text and rethrows', async () => {
  await withStatusFile(async (file) => {
    const host = makeFakeHost()
    setServiceFactoryForTests(() => makeRecordingService())
    apply(host.ctx, { exposeAgentTools: { get: () => true } })
    // A scope whose register throws (a duplicate tool name on a live host,
    // an invalid definition): the callback must contain the failure —
    // stage tools-failed with the error text — then rethrow loudly, the
    // engram index.js:257-259 / airboard index.js:262-265 pattern.
    const boom = new Error('tool name "roster_template_save" already registered')
    const scope = { tools: { register: () => { throw boom } }, subagents: makeSubagents() }
    assert.throws(() => host.injects[0].fn(scope), (error) => error === boom,
      'the contained callback rethrows so the failure stays loud')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.stage, 'tools-failed', 'the failure names its stage')
    assert.equal(record.detail, String(boom), 'with the error text')
  })
})

test('exposeAgentTools false still injects and registers roster_spawn alone', async () => {
  await withStatusFile(async (file) => {
    const host = makeFakeHost()
    setServiceFactoryForTests(() => makeRecordingService())
    apply(host.ctx, { exposeAgentTools: { get: () => false } })
    // The "+" flow depends on roster_spawn, so the callback always runs; the
    // toggle only removes the authoring pair.
    assert.equal(host.injects.length, 1)
    const scope = makeToolsScope()
    scope.subagents = makeSubagents()
    host.injects[0].fn(scope)
    assert.deepEqual(scope.registered.map((t) => t.name), ['roster_spawn'])
    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.stage, 'tools-registered')
    assert.equal(record.detail.authoring, false)
  })
})

// ---------------------------------------------------------------------------
// roster_spawn — the single creation path (ADR-0011)
// ---------------------------------------------------------------------------

/** Seed a store with one template and wire the spawn tool over it. */
async function spawnToolHarness({ template = { name: 'Researcher', description: 'Finds sources', prompt: 'You research thoroughly.' }, subagents } = {}) {
  const { store } = makeRoster()
  const saved = await (async () => {
    const service = Object.create(AgentRosterService.prototype)
    service.store = store
    return service.saveTemplate(template)
  })()
  const scope = makeToolsScope()
  scope.subagents = subagents ?? makeSubagents()
  registerRosterTools(scope, makeRecordingService(), { store, subagents: scope.subagents })
  return { tool: toolOf(scope, 'roster_spawn'), store, saved, subagents: scope.subagents }
}

test('roster_spawn resolves a template by exact name and creates the member', async () => {
  const ctx = await spawnToolHarness()
  const caller = { id: 'root-1', name: 'lead' }
  ctx.subagents.rootOf = () => caller
  const out = await ctx.tool.execute({ template: 'Researcher', task: 'review payments' }, { agent: caller, callId: 'c1' })
  const spec = ctx.subagents.calls.startActivation[0]
  assert.equal(spec.label, 'Researcher')
  assert.equal(spec.name, 'researcher')
  assert.equal(spec.prompt[0].text, 'You research thoroughly.\n\n---\n\nInitial task (assigned by the user at spawn time):\nreview payments')
  assert.equal(spec.delivery, 'parent')
  const parsed = JSON.parse(out)
  assert.equal(parsed.created, 'researcher')
  assert.equal(parsed.template, 'Researcher')
  assert.equal(parsed.model, 'inherited from the parent agent')
})

test('roster_spawn resolves a template by id and applies its model', async () => {
  const ctx = await spawnToolHarness({
    template: { name: 'Researcher', prompt: 'You research.', defaultModel: { provider: 'deepseek', model: 'chat' } },
  })
  const caller = { id: 'root-1', name: 'lead' }
  ctx.subagents.rootOf = () => caller
  const out = await ctx.tool.execute({ template: ctx.saved.id }, { agent: caller, callId: 'c1' })
  assert.deepEqual(ctx.subagents.calls.startActivation[0].agentOptions, { provider: 'deepseek', model: 'chat' })
  assert.deepEqual(JSON.parse(out).model, { provider: 'deepseek', model: 'chat' })
})

test('roster_spawn maps an unknown template to model-facing text instead of throwing', async () => {
  const ctx = await spawnToolHarness()
  const out = await ctx.tool.execute({ template: 'Nope' }, { agent: { id: 'root-1', name: 'lead' }, callId: 'c1' })
  assert.match(out, /roster call failed \(roster\/not-found\)/)
  assert.equal(ctx.subagents.calls.startActivation.length, 0, 'nothing spawned')
})

test('roster_spawn without a calling agent reports misuse, never throws', async () => {
  const ctx = await spawnToolHarness()
  const out = await ctx.tool.execute({ template: 'Researcher' }, { callId: 'c1' })
  assert.match(out, /requires a calling agent/)
  assert.equal(ctx.subagents.calls.startActivation.length, 0)
})

test('roster_spawn is not concurrency-safe; the authoring list tool is', async () => {
  const scope = makeToolsScope()
  registerRosterTools(scope, makeRecordingService(), { store: makeRoster().store, subagents: makeSubagents() })
  // A spawn mutates the tree, so it must NOT join a parallel batch (the
  // flag's real shape is a predicate — tools/index.ts).
  const spawn = toolOf(scope, 'roster_spawn')
  assert.equal(spawn.isConcurrencySafe === undefined || spawn.isConcurrencySafe({}) === false, true)
  assert.equal(toolOf(scope, 'roster_template_list').isConcurrencySafe({}), true)
})
