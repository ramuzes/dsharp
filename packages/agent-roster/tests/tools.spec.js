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
 *
 * roster_spawn takes a model TIER and the escalation basis, never a model
 * (ADR-0013): the lead cannot pick an arbitrary route or inherit its own.
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
import { assembleMemberOpening } from '../lib/spawn.js'

/** Fixed timestamp for fake-service returns. */
const T0 = '2026-11-22T12:00:00.000Z'

/** Minimal exec: the roster tools consume no exec members. */
const EXEC = { callId: 'call-1' }

const toolOf = (scope, name) => scope.registered.find((t) => t.name === name)

/** An inject scope exposing ONLY the named services: anything else throws, as cordis does (AGENTS.md 3). */
function strictScope(services) {
  return new Proxy({ ...services }, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop]
      throw new Error(`cannot get property ${String(prop)} without inject`)
    },
  })
}

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
        defaultModel: null, highTierModel: null, reuse: 'role',
        createdAt: T0, updatedAt: T0,
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

test('list omits prompt: records carry exactly id, name, description, defaultModel, highTierModel, reuse, updatedAt', async () => {
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
    ['defaultModel', 'description', 'highTierModel', 'id', 'name', 'reuse', 'updatedAt'])
  for (const rec of records) {
    assert.equal('prompt' in rec, false, 'prompt deliberately omitted to keep context light')
  }
  assert.deepEqual(records[0].defaultModel, { provider: 'p', model: 'm' })
  assert.equal(records[1].defaultModel, null)
  // Both rows were stored without the tier fields: the read schema fills
  // them in, and the list carries them (a lead reads a role's high tier
  // and reuse policy before it decides how to dispatch).
  assert.equal(records[0].highTierModel, null)
  assert.equal(records[0].reuse, 'role')
})

test('roster_template_save passes high_tier_model and reuse; list rows carry highTierModel and reuse', async () => {
  // Pass-through half: the tool maps the snake_case arguments onto the
  // service's input (storing them is the service's job).
  const recording = makeRecordingService()
  const scope = makeToolsScope()
  registerRosterTools(scope, recording)
  const save = toolOf(scope, 'roster_template_save')
  await save.execute(
    { name: 'Reviewer', prompt: 'v1', high_tier_model: { provider: 'acme', model: 'capable', reasoning_effort: 'max' }, reuse: 'task' },
    EXEC)
  assert.deepEqual(recording.calls.saveTemplate[0], {
    name: 'Reviewer',
    description: undefined,
    prompt: 'v1',
    defaultModel: undefined,
    highTierModel: { provider: 'acme', model: 'capable', reasoningEffort: 'max' },
    reuse: 'task',
  }, 'high_tier_model maps like default_model; reuse passes as the enum value')
  // `high_tier_model: null` is the explicit clear, like default_model.
  await save.execute({ name: 'Reviewer', prompt: 'v2', high_tier_model: null }, EXEC)
  assert.equal(recording.calls.saveTemplate[1].highTierModel, null)
  assert.equal(recording.calls.saveTemplate[1].reuse, undefined, 'omitted reuse stays undefined (patch semantics)')

  // Row half: the list tool renders both fields of a stored template,
  // including a high-tier route and a non-default reuse policy.
  const rows = makeRecordingService({
    listTemplates: () => [{
      id: 't1', name: 'Reviewer', description: '', prompt: 'p',
      defaultModel: { provider: 'acme', model: 'cheap' },
      highTierModel: { provider: 'acme', model: 'capable', reasoningEffort: 'max' },
      reuse: 'task', createdAt: T0, updatedAt: T0,
    }],
  })
  const scope2 = makeToolsScope()
  registerRosterTools(scope2, rows)
  const listed = JSON.parse(await toolOf(scope2, 'roster_template_list').execute({}, EXEC))
  assert.deepEqual(listed[0].highTierModel, { provider: 'acme', model: 'capable', reasoningEffort: 'max' })
  assert.equal(listed[0].reuse, 'task')
})

test('roster_template_save with a misspelled reuse is rejected by the tools library', async () => {
  // The REAL @deepseek-ai/dsh-tools validates arguments against the
  // parameter schema before execute (lib/index.js:864): a value outside the
  // enum throws ToolArgsError (INVALID_ARGS) and never reaches the plugin,
  // so a typo cannot be stored as a policy.
  const { service } = makeRoster()
  const scope = makeToolsScope()
  registerRosterTools(scope, service)
  const save = toolOf(scope, 'roster_template_save')
  await assert.rejects(
    () => save.execute({ name: 'Reviewer', prompt: 'p', reuse: 'tasks' }, EXEC),
    (error) => error?.code === 'INVALID_ARGS' && /"reuse"/.test(String(error?.message)),
    'expected INVALID_ARGS for a reuse value outside the enum',
  )
  assert.equal((await service.listTemplates()).length, 0, 'nothing stored')
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
    // Two independent callbacks: the tools, and the /roster command (ADR-0012).
    assert.equal(host.injects.length, 2, 'the tools callback and the command callback')
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
    assert.equal(host.injects.length, 2)
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

/**
 * Seed a store with one template and wire the spawn tool over it. The seed
 * goes through the REAL service's saveTemplate, so the tier fields are stored
 * by the service's own write rules.
 */
async function spawnToolHarness({ template = { name: 'Researcher', description: 'Finds sources', prompt: 'You research thoroughly.' }, subagents } = {}) {
  const { store } = makeRoster()
  const service = Object.create(AgentRosterService.prototype)
  service.store = store
  const saved = await service.saveTemplate(template)
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
  assert.equal(spec.delivery, 'parent', 'a member given a task reports its result to the lead')
  assert.equal(spec.prompt[0].text, assembleMemberOpening('researcher', 'You research thoroughly.', 'review payments'))
  assert.equal(spec.delivery, 'parent')
  const parsed = JSON.parse(out)
  assert.deepEqual(parsed, {
    name: 'researcher',
    template: 'Researcher',
    tier: 'base',
    reused: false,
    model: 'inherited from the parent agent',
  }, 'no `reason` key on a base dispatch')
})

test('roster_spawn resolves a template by id and runs the member on the base model', async () => {
  const ctx = await spawnToolHarness({
    template: { name: 'Researcher', prompt: 'You research.', defaultModel: { provider: 'acme', model: 'cheap' } },
  })
  const caller = { id: 'root-1', name: 'lead' }
  ctx.subagents.rootOf = () => caller
  const out = await ctx.tool.execute({ template: ctx.saved.id }, { agent: caller, callId: 'c1' })
  assert.deepEqual(ctx.subagents.calls.startActivation[0].agentOptions, { provider: 'acme', model: 'cheap' })
  assert.deepEqual(JSON.parse(out), {
    name: 'researcher', template: 'Researcher', tier: 'base', reused: false,
    model: { provider: 'acme', model: 'cheap' },
  })
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

// ---------------------------------------------------------------------------
// roster_spawn: the tier argument (ADR-0013)
// ---------------------------------------------------------------------------

/** A template with both tiers configured (invented provider/model ids). */
const BASE_ONLY = { name: 'Researcher', prompt: 'You research.', defaultModel: { provider: 'acme', model: 'cheap' } }
const HIGH = { provider: 'acme', model: 'capable', reasoningEffort: 'max' }
const tiered = () => spawnToolHarness({ template: { ...BASE_ONLY, highTierModel: HIGH } })
const CALLER = { id: 'root-1', name: 'lead' }

test('roster_spawn has no model parameter; tier and reason are the only model inputs', () => {
  const scope = makeToolsScope()
  registerRosterTools(scope, makeRecordingService(), { store: makeRoster().store, subagents: makeSubagents() })
  const spawn = toolOf(scope, 'roster_spawn')
  // defineTool compiles the parameter definitions into one JSON schema
  // ({ type, properties, required }) that the tools library validates with.
  const params = spawn.parameters.properties
  assert.deepEqual(Object.keys(params).sort(), ['reason', 'task', 'template', 'tier'])
  assert.deepEqual(spawn.parameters.required, ['template'])
  assert.deepEqual(params.tier.enum, ['base', 'high'])
  assert.equal(spawn.description,
    "Give a task to a team member of a configured role template, creating the member when the role has no idle one. The template carries the member's standing instruction and its models; pass the template id from the instruction that asked for this member, or its exact display name. Model tier — every new task starts on the base model; move to high only after one rework on the base model failed to pass, or when the task brief itself names the high tier. The tier follows the task, never the role. Do not restate the template yourself — the template text is used verbatim. Once nothing is left but waiting for members, end your turn: a member's completion notice starts your next turn, so do not poll with wait_agent.")
})

test('roster_spawn tier high passes the reason-checked tier and reports it', async () => {
  const ctx = await tiered()
  ctx.subagents.rootOf = () => CALLER
  const out = await ctx.tool.execute(
    { template: ctx.saved.id, task: 'the hard part', tier: 'high', reason: '  the base model failed rework once  ' },
    { agent: CALLER, callId: 'c1' },
  )
  assert.deepEqual(ctx.subagents.calls.startActivation[0].agentOptions,
    { provider: 'acme', model: 'capable', reasoningEffort: 'max' }, 'the member runs on the high-tier model')
  assert.deepEqual(JSON.parse(out), {
    name: 'researcher',
    template: 'Researcher',
    tier: 'high',
    reused: false,
    model: { provider: 'acme', model: 'capable', reasoningEffort: 'max' },
    reason: 'the base model failed rework once',
  }, 'the reason is reported trimmed')
})

test('roster_spawn tier high without a reason is refused and spawns nothing', async () => {
  const ctx = await tiered()
  ctx.subagents.rootOf = () => CALLER
  for (const reason of [undefined, '', '   ']) {
    const args = { template: ctx.saved.id, tier: 'high', ...(reason === undefined ? {} : { reason }) }
    const out = await ctx.tool.execute(args, { agent: CALLER, callId: 'c1' })
    assert.match(out, /roster\/bad-request/, JSON.stringify(args))
  }
  assert.equal(ctx.subagents.calls.startActivation.length, 0)
})

test('roster_spawn high on a template without a high-tier model reports roster/no-high-tier-model', async () => {
  const ctx = await spawnToolHarness({ template: BASE_ONLY })
  ctx.subagents.rootOf = () => CALLER
  const out = await ctx.tool.execute(
    { template: ctx.saved.id, tier: 'high', reason: 'the brief names the high tier' },
    { agent: CALLER, callId: 'c1' },
  )
  assert.match(out, /roster\/no-high-tier-model/, out)
  assert.equal(ctx.subagents.calls.startActivation.length, 0)
})

test('a tier outside the enum is rejected by the real tools library before the tool runs', async () => {
  // The REAL @deepseek-ai/dsh-tools validates arguments against the
  // parameter schema in its execute wrapper (lib/index.js:864): a value
  // outside the enum throws ToolArgsError (INVALID_ARGS) and never reaches
  // the plugin — the lead cannot name a tier of its own invention.
  const ctx = await tiered()
  ctx.subagents.rootOf = () => CALLER
  await assert.rejects(
    () => ctx.tool.execute({ template: ctx.saved.id, tier: 'ultra', reason: 'why not' }, { agent: CALLER, callId: 'c1' }),
    (error) => error?.code === 'INVALID_ARGS' && /"tier"/.test(String(error?.message)),
    'expected INVALID_ARGS for tier ultra',
  )
  assert.equal(ctx.subagents.calls.startActivation.length, 0)
})

test('a non-string reason is rejected by the real tools library before the tool runs', async () => {
  // Same gate as the tier case: the parameter schema types `reason` as a
  // string, so a wrong-typed one never reaches requireReason or the spawn.
  const ctx = await tiered()
  ctx.subagents.rootOf = () => CALLER
  await assert.rejects(
    () => ctx.tool.execute({ template: ctx.saved.id, tier: 'high', reason: 123 }, { agent: CALLER, callId: 'c1' }),
    (error) => error?.code === 'INVALID_ARGS' && /"reason"/.test(String(error?.message)),
    'expected INVALID_ARGS for a non-string reason',
  )
  assert.equal(ctx.subagents.calls.startActivation.length, 0)
})

// ---------------------------------------------------------------------------
// roster_spawn: the high-tier dispatch log (Task 1 store.log + ADR-0013)
// ---------------------------------------------------------------------------

/**
 * Wrap a harness store's `log` with a strict recording stand-in: the exact
 * same call shape as the real store handle (add/list), recording every add,
 * delegating to the real one unless told to reject.
 */
function recordingLog(store, { reject = false } = {}) {
  const calls = { add: [] }
  const real = store.log
  store.log = {
    add: async (record) => {
      calls.add.push(record)
      if (reject) throw new Error('log storage unavailable')
      return real.add(record)
    },
    list: real.list.bind(store),
  }
  return { calls }
}

test('a high-tier dispatch writes a record with the reason and session', async () => {
  const ctx = await tiered()
  ctx.subagents.rootOf = () => CALLER
  // The calling agent carries a session id, like a real exec does
  // (exec.agent.session.id) — invented id, no private detail.
  const exec = { agent: { id: 'root-1', name: 'lead', session: { id: 'caller-session-1' } }, callId: 'c1' }
  const log = recordingLog(ctx.store)
  const out = await ctx.tool.execute(
    { template: ctx.saved.id, task: 'the hard part', tier: 'high', reason: 'base rework failed once' },
    exec,
  )
  assert.equal(log.calls.add.length, 1, 'exactly one record per successful high dispatch')
  const record = log.calls.add[0]
  assert.deepEqual(Object.keys(record).sort(),
    ['at', 'id', 'memberName', 'reason', 'sessionId', 'templateId', 'templateName'])
  assert.equal(record.sessionId, 'caller-session-1')
  assert.equal(record.templateId, ctx.saved.id)
  assert.equal(record.templateName, 'Researcher')
  assert.equal(record.memberName, 'researcher')
  assert.equal(record.reason, 'base rework failed once')
  assert.match(record.id, /^[0-9a-f]{10}$/, 'fresh short-random hex id')
  assert.doesNotThrow(() => new Date(record.at), 'at is a parseable timestamp')
  assert.equal(JSON.parse(out).warning, undefined, 'a successful write adds no warning')
})

test('a base dispatch writes no record', async () => {
  const ctx = await tiered()
  ctx.subagents.rootOf = () => CALLER
  const log = recordingLog(ctx.store)
  await ctx.tool.execute(
    { template: ctx.saved.id, task: 'the easy part' },
    { agent: CALLER, callId: 'c1' },
  )
  assert.equal(log.calls.add.length, 0, 'only high-tier dispatches are recorded')
})

test('a failed record write reports a warning and keeps the result', async () => {
  const ctx = await tiered()
  ctx.subagents.rootOf = () => CALLER
  const exec = { agent: { id: 'root-1', name: 'lead', session: { id: 'caller-session-1' } }, callId: 'c1' }
  recordingLog(ctx.store, { reject: true })
  const out = await ctx.tool.execute(
    { template: ctx.saved.id, task: 'the hard part', tier: 'high', reason: 'base rework failed once' },
    exec,
  )
  const parsed = JSON.parse(out)
  // The dispatch itself succeeded: the full result stays, the log loss is
  // reported — never swallowed, never thrown into the caller.
  assert.equal(parsed.name, 'researcher')
  assert.equal(parsed.tier, 'high')
  assert.equal(parsed.reason, 'base rework failed once')
  assert.match(parsed.warning, /^high-tier use was not recorded \(/)
  assert.ok(parsed.warning.includes('log storage unavailable'), 'the warning carries the error detail')
})

test('roster_template_save refuses a default model with an empty provider or model', async () => {
  // The real service over the real store: a stored ref with empty parts is
  // unusable as a route, so the write boundary rejects it instead of leaving a
  // default that only fails at spawn time.
  const { service } = makeRoster()
  for (const defaultModel of [{ provider: '', model: 'm' }, { provider: 'acme', model: '' }]) {
    await assert.rejects(
      () => service.saveTemplate({ name: 'Broken', prompt: 'p', defaultModel }),
      (error) => error?.code === 'roster/bad-request' && Array.isArray(error?.details?.issues),
      `expected roster/bad-request for ${JSON.stringify(defaultModel)}`,
    )
  }
  assert.equal((await service.listTemplates()).length, 0)
})

test('roster_spawn without a task creates a standby member that settles silently', async () => {
  const ctx = await spawnToolHarness()
  const caller = { id: 'root-1', name: 'lead' }
  ctx.subagents.rootOf = () => caller
  await ctx.tool.execute({ template: ctx.saved.id }, { agent: caller, callId: 'c1' })
  const spec = ctx.subagents.calls.startActivation[0]
  assert.equal(spec.delivery, 'caller', 'no settle notice, so an idle lead is not woken')
  assert.ok(spec.prompt[0].text.includes('No task has been assigned yet.'))
  assert.equal(spec.prompt[0].text.includes('Your first task'), false)
})

test('apply registers the /roster command on its own inject callback (commands + subagents)', async () => {
  await withStatusFile(async (file) => {
    const host = makeFakeHost()
    setServiceFactoryForTests(() => makeRecordingService())
    apply(host.ctx, { exposeAgentTools: { get: () => true } })
    const callback = host.injects.find((entry) => entry.names.includes('commands'))
    assert.ok(callback, 'one callback injects the commands service')
    // The handler spawns through the runtime: `subagents` must be injected on
    // the same callback (AGENTS.md 3).
    assert.deepEqual(callback.names, ['commands', 'subagents'])
    const registered = []
    const scope = {
      subagents: makeSubagents(),
      commands: {
        register: (definition) => {
          registered.push(definition)
          return () => { registered.splice(registered.indexOf(definition), 1) }
        },
      },
    }
    const off = callback.fn(strictScope(scope))
    assert.deepEqual(registered.map((definition) => definition.name), ['roster'])
    assert.equal(typeof off, 'function')
    let record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.stage, 'command-registered', 'the stage names what mounted')
    assert.equal(record.detail.authoring, true)
    assert.equal(record.detail.command, true)
    await off()
    assert.equal(registered.length, 0, 'the inject disposer unregisters the command')
  })
})

test('after both callbacks ran the status record names the tools and the command', async () => {
  await withStatusFile(async (file) => {
    const host = makeFakeHost()
    setServiceFactoryForTests(() => makeRecordingService())
    apply(host.ctx, { exposeAgentTools: { get: () => true } })
    const scope = makeToolsScope()
    scope.subagents = makeSubagents()
    scope.commands = { register: () => () => {} }
    for (const callback of host.injects) callback.fn(strictScope(scope))
    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.stage, 'tools-registered')
    assert.deepEqual(record.detail, { authoring: true, command: true })
  })
})

test('a failed command registration writes command-failed with the error text and rethrows', async () => {
  await withStatusFile(async (file) => {
    const host = makeFakeHost()
    setServiceFactoryForTests(() => makeRecordingService())
    apply(host.ctx, { exposeAgentTools: { get: () => true } })
    const boom = new Error('command "roster" is already registered')
    const scope = { subagents: makeSubagents(), commands: { register: () => { throw boom } } }
    const callback = host.injects.find((entry) => entry.names.includes('commands'))
    assert.throws(() => callback.fn(strictScope(scope)), (error) => error === boom, 'contained, then rethrown loudly')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.stage, 'command-failed')
    assert.equal(record.detail, String(boom))
  })
})
