/**
 * Host-half tests. Task 1: config unwrap discipline, the staged status
 * writer, and the apply() boot sequence. Task 2: the storageDomain-backed
 * roster store and the AgentRosterService CRUD remote. Task 3 extends the
 * remote with spawnMember/teamStatus (their behavior lives in
 * tests/spawn.spec.js; only the Remote marker set is asserted here). Task 5
 * adds the tools inject to apply() — the tools themselves live in
 * tests/tools.spec.js; only the inject's presence is pinned here.
 *
 * Fakes mirror real strictness (AGENTS.md): the fake ctx exposes ONLY the
 * framework members a plugin may touch (inject / effect / get — the optional-
 * service name lookup real cordis always provides) — any other property
 * access throws exactly like cordis does for a non-injected service
 * ("cannot get property ... without inject"; engram tests/host.spec.js
 * makeFakeHost/makeScope pattern) — config fields are schemastery-style
 * reactive wrappers `{ get: () => value }`, the exact shape the Loader hands
 * the plugin (AGENTS.md, "Config values arrive wrapped"), and the fake
 * storageDomain validates records with the real zod schemas, exactly like
 * the real facility parses every loaded record (dsh-storage-domain
 * lib/index.js, DomainFacility.open → parseRecord).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { apply, Config, setServiceFactoryForTests } from '../index.js'
import { readString, readBoolean } from '../lib/wire.js'
import { createStaging } from '../lib/staging.js'
import { openRosterStore, RoleTemplate } from '../lib/store.js'
import { AgentRosterService } from '../lib/roster-service.js'

/** Unwrap rule the host code itself uses (defensive: wrapper or plain). */
const unwrap = (v) => typeof v?.get === 'function' ? v.get() : v

/** Fixed timestamp for hand-built records. */
const T0 = '2026-11-22T12:00:00.000Z'

/**
 * Fake host: a ctx that carries only the framework surface (inject, effect,
 * get); everything else throws like a non-injected service access in cordis.
 * `services` is the optional-service bag ctx.get(name) resolves from.
 */
function makeFakeHost(services = {}) {
  const injects = []
  const effects = []
  const framework = {
    inject: (names, fn) => { injects.push({ names, fn }) },
    // Real ctx.effect runs the body synchronously and keeps the returned
    // disposer for fiber disposal (cordis fiber.d.ts effect(execute, label)).
    effect: (fn, label) => {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
    // Real cordis exposes ctx.get(name) as framework surface — the sanctioned
    // optional-service lookup returning undefined when not provided (property
    // ACCESS without inject is what throws) — feishu-gateway wiring.spec
    // allowed-set precedent.
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

/** Recording status writer (same shape openStatus returns). */
const recordingStatus = () => {
  const records = []
  return { records, write(stage, detail) { records.push({ stage, detail }) } }
}

/**
 * Fake KV table mirroring the real KvTableImpl members the store consumes
 * (dsh-storage-domain lib/index.js: get/keys/put/delete; put and delete
 * queue on the domain's write chain and return promises there). put parses
 * through the table's real zod valueSchema — the same validation the real
 * facility runs on every loaded record (DomainFacility.open → parseRecord)
 * — so a record the domain would reject on load never enters the fake.
 */
function makeFakeTable(valueSchema) {
  const records = new Map()
  return {
    get: (key) => records.get(key),
    keys: () => [...records.keys()][Symbol.iterator](),
    async put(key, value) { records.set(key, valueSchema.parse(value)) },
    async delete(key) { return records.delete(key) },
  }
}

/**
 * Fake storageDomain facility mirroring the surface openRosterStore touches:
 * open(spec) → domain with table(name)/close(); already-open names rejected
 * and freed on close, like DomainFacility.open/runClose.
 */
function makeFakeStorageDomain() {
  const opens = { specs: [], closedCounts: [], names: [] }
  return {
    opens,
    async open(spec) {
      const index = opens.specs.push(spec) - 1
      opens.names.push(spec.name)
      opens.closedCounts.push(0)
      const tables = new Map(Object.entries(spec.tables).map(([name, ts]) => [name, makeFakeTable(ts.valueSchema)]))
      return {
        table(name) {
          const table = tables.get(name)
          if (table === undefined) throw new Error(`domain '${spec.name}' declares no table '${name}'`)
          return table
        },
        async close() { opens.closedCounts[index] += 1 },
      }
    },
  }
}

/** A scope whose ONLY member is the sanctioned get() lookup. */
const scopeWithStorage = (domain) => ({ get: (name) => (name === 'storageDomain' ? domain : undefined) })

/**
 * A roster service instance without constructing one: TypertRemoteService's
 * constructor needs a genuine cordis Context (Service registration), so unit
 * tests use Object.create(prototype) + the consumed field — the feishu
 * diagnostics.spec precedent.
 */
async function makeRoster() {
  const storage = makeFakeStorageDomain()
  const status = recordingStatus()
  const store = openRosterStore(scopeWithStorage(storage), status)
  const service = Object.create(AgentRosterService.prototype)
  service.store = store
  return { service, store, storage, status }
}

test('apply reads config through wrappers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-roster-t1-'))
  const file = join(dir, 'status.json')
  const prev = process.env.AGENT_ROSTER_STATUS_FILE
  process.env.AGENT_ROSTER_STATUS_FILE = file
  try {
    let wrapperReads = 0
    const config = {
      exposeAgentTools: { get: () => { wrapperReads += 1; return true } },
    }
    const host = makeFakeHost()
    // The remote service needs a genuine cordis Context (Service
    // registration) — substitute a recording factory (feishu seam pattern).
    const constructed = []
    setServiceFactoryForTests((ctx, store) => { constructed.push({ ctx, store }) })
    await apply(host.ctx, config)
    assert.equal(constructed.length, 1, 'service factory ran once')
    // Task 5: with exposeAgentTools reading true, apply adds exactly one
    // inject callback — the tools registration scope (tests/tools.spec.js
    // drives and asserts it).
    assert.equal(host.injects.length, 2, 'the tools callback and the /roster command callback')
    assert.deepEqual(host.injects[0].names, ['tools', 'subagents'])
    assert.equal(host.effects.length, 1, 'wiring wrapped in exactly one ctx.effect')
    assert.ok(wrapperReads >= 1, 'exposeAgentTools must be read through the wrapper getter')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    // The mount stops at tools-pending until the injected services appear;
    // a terminal `done` here would hide a tools callback that never ran.
    assert.equal(record.stage, 'tools-pending', 'the mount names the pending tools state')
    assert.equal(typeof record.at, 'string')
    assert.ok(!Number.isNaN(Date.parse(record.at)))
  } finally {
    setServiceFactoryForTests(undefined)
    // Assigning undefined to process.env stores the STRING "undefined";
    // delete instead (engram test precedent).
    if (prev === undefined) delete process.env.AGENT_ROSTER_STATUS_FILE
    else process.env.AGENT_ROSTER_STATUS_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readString/readBoolean unwrap reactive wrappers and pass plain values through', () => {
  assert.equal(readString('plain'), 'plain')
  assert.equal(readString({ get: () => 'wrapped' }), 'wrapped')
  assert.equal(readString(42), '')                     // wrong type → ''
  assert.equal(readString(undefined), '')
  assert.equal(readBoolean(true), true)
  assert.equal(readBoolean(false), false)
  assert.equal(readBoolean({ get: () => true }), true)
  assert.equal(readBoolean({ get: () => false }), false)
  assert.equal(readBoolean('true'), false)             // strict boolean: wrong type → false
  assert.equal(readBoolean(undefined), false)
})

test('Config parses {} to exposeAgentTools: true', () => {
  const parsed = Config({})
  assert.equal(unwrap(parsed.exposeAgentTools), true)
  // Structural (non-volatile) per the plan: edits reload the plugin rather
  // than applying live, so the field parses as a plain value, not a wrapper.
  assert.equal(typeof parsed.exposeAgentTools?.get, 'undefined')
})

test('Config exposes exactly one field: the authoring-tools toggle', () => {
  // ADR-0011 removed every draft field: drafting is gone and member creation
  // is the always-on roster_spawn tool, so nothing else belongs in Config.
  const parsed = Config({})
  assert.deepEqual(Object.keys(parsed), ['exposeAgentTools'])
  assert.equal(unwrap(parsed.exposeAgentTools), true)
})

// ---------------------------------------------------------------------------
// Task 2: roster store + CRUD remote
// ---------------------------------------------------------------------------

test('store persists through the storageDomain fake which validates records with the real zod schemas', async () => {
  const { store, storage } = await makeRoster()
  // The store opened exactly the declared domain specs through the facility:
  // the templates domain and (Task 1, tiers) the separate high-tier log domain.
  assert.equal(storage.opens.specs.length, 2)
  assert.equal(storage.opens.specs[0].name, 'agent_roster')
  assert.equal(storage.opens.specs[0].version, 1)
  assert.deepEqual(Object.keys(storage.opens.specs[0].tables).sort(), ['templates'])
  assert.equal(storage.opens.specs[1].name, 'agent_roster_log', 'the log keeps its own domain')
  assert.equal(storage.opens.specs[1].version, 1)

  const rec = RoleTemplate.parse({ id: 'a1', name: 'Reviewer', prompt: 'Review diffs.', createdAt: T0, updatedAt: T0 })
  await store.put(rec)
  assert.deepEqual(await store.byId('a1'), rec)
  assert.equal(await store.byId('nope'), undefined)
  assert.equal((await store.all()).length, 1)
  assert.equal(await store.delete('a1'), true)
  assert.equal(await store.delete('a1'), false, 'second delete reports nothing removed')

  // The fake rejects a record the real facility would reject on load: same
  // zod valueSchema, same .parse surface (empty prompt violates min(1)).
  await assert.rejects(
    () => store.put({ id: 'x', name: 'X', prompt: '', createdAt: T0, updatedAt: T0 }),
    (error) => Array.isArray(error.issues),
  )
})

test('save assigns id and timestamps', async () => {
  const { service } = await makeRoster()
  const saved = await service.saveTemplate({ name: 'Reviewer', prompt: 'Review diffs.' })
  assert.match(saved.id, /^[0-9a-f]{10}$/, 'fresh short-random hex id')
  assert.equal(saved.name, 'Reviewer')
  assert.equal(saved.description, '', 'zod default fills description')
  assert.equal(saved.defaultModel, null, 'zod default fills defaultModel')
  assert.ok(!Number.isNaN(Date.parse(saved.createdAt)))
  assert.equal(saved.updatedAt, saved.createdAt, 'freshly created record has equal timestamps')
  const listed = await service.listTemplates()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, saved.id)
})

test('duplicate name rejected with roster/name-taken', async () => {
  const { service } = await makeRoster()
  await service.saveTemplate({ name: 'Reviewer', prompt: 'first' })
  // A different record taking the same name.
  await assert.rejects(
    () => service.saveTemplate({ name: 'Reviewer', prompt: 'second' }),
    (error) => remoteErrorOf(error)?.code === 'roster/name-taken',
  )
  // Renaming an existing record onto another record's name.
  const writer = await service.saveTemplate({ name: 'Writer', prompt: 'third' })
  await assert.rejects(
    () => service.saveTemplate({ id: writer.id, name: 'Reviewer', prompt: 'third' }),
    (error) => remoteErrorOf(error)?.code === 'roster/name-taken',
  )
  // Re-saving a record under its OWN name is not a conflict.
  const mine = await service.saveTemplate({ name: 'Auditor', prompt: 'v1' })
  const again = await service.saveTemplate({ id: mine.id, name: 'Auditor', prompt: 'v2' })
  assert.equal(again.id, mine.id)
})

test('update keeps id bumps updatedAt', async () => {
  const { service } = await makeRoster()
  const first = await service.saveTemplate({ name: 'Reviewer', prompt: 'v1' })
  await new Promise((resolve) => setTimeout(resolve, 5)) // ISO millisecond resolution
  const updated = await service.saveTemplate({
    id: first.id,
    name: 'Reviewer',
    prompt: 'v2',
    description: 'touched',
    defaultModel: { provider: 'p', model: 'm' },
  })
  assert.equal(updated.id, first.id, 'id is stable across updates')
  assert.equal(updated.createdAt, first.createdAt, 'createdAt is the create time')
  assert.notEqual(updated.updatedAt, first.updatedAt, 'updatedAt bumps on every write')
  assert.equal(updated.prompt, 'v2')
  assert.equal(updated.description, 'touched')
  assert.deepEqual(updated.defaultModel, { provider: 'p', model: 'm' })
  // Patch semantics: an update that omits optional keys keeps their stored
  // values (Task 5's upsert-by-name tool relies on this), while an explicit
  // null clears them.
  const trimmed = await service.saveTemplate({ id: first.id, name: 'Reviewer', prompt: 'v3' })
  assert.equal(trimmed.description, 'touched', 'omitted description preserved')
  assert.deepEqual(trimmed.defaultModel, { provider: 'p', model: 'm' }, 'omitted defaultModel preserved')
  const cleared = await service.saveTemplate({ id: first.id, name: 'Reviewer', prompt: 'v4', defaultModel: null })
  assert.equal(cleared.defaultModel, null, 'explicit null applies')
  // Updating an unknown id is not-found, never a silent create.
  await assert.rejects(
    () => service.saveTemplate({ id: 'nope', name: 'X', prompt: 'y' }),
    (error) => remoteErrorOf(error)?.code === 'roster/not-found',
  )
})

test('delete missing throws roster/not-found', async () => {
  const { service } = await makeRoster()
  const saved = await service.saveTemplate({ name: 'Reviewer', prompt: 'a' })
  assert.deepEqual(await service.deleteTemplate(saved.id), { deleted: true })
  assert.equal((await service.listTemplates()).length, 0)
  await assert.rejects(
    () => service.deleteTemplate(saved.id),
    (error) => remoteErrorOf(error)?.code === 'roster/not-found',
  )
})

test('saveTemplate rejects invalid input with roster/bad-request', async () => {
  const { service } = await makeRoster()
  await assert.rejects(
    () => service.saveTemplate({ name: '', prompt: 'x' }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
  await assert.rejects(
    () => service.saveTemplate({ name: 'X', prompt: '' }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
  // Shape failures (defaultModel missing its model) surface through the same
  // code, with the zod issues attached.
  await assert.rejects(
    () => service.saveTemplate({ name: 'X', prompt: 'y', defaultModel: { provider: 'p' } }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request' && Array.isArray(remoteErrorOf(error).details.issues),
  )
})

test('saveTemplate stores highTierModel and reuse, patch-semantics on update', async () => {
  const { service } = await makeRoster()
  const BASE = { provider: 'acme', model: 'cheap' }
  const HIGH = { provider: 'acme', model: 'capable', reasoningEffort: 'max' }
  // Create without the tier fields: zod defaults fill them.
  const bare = await service.saveTemplate({ name: 'Writer', prompt: 'p' })
  assert.equal(bare.highTierModel, null, 'zod default fills highTierModel')
  assert.equal(bare.reuse, 'role', "zod default fills reuse")
  // Create with both: stored verbatim and visible through the read side.
  const created = await service.saveTemplate({
    name: 'Reviewer', prompt: 'v1', defaultModel: BASE, highTierModel: HIGH, reuse: 'task',
  })
  assert.deepEqual(created.highTierModel, HIGH)
  assert.equal(created.reuse, 'task')
  const [stored] = (await service.listTemplates()).filter((rec) => rec.id === created.id)
  assert.deepEqual(stored.highTierModel, HIGH, 'highTierModel is persisted, not just echoed')
  assert.equal(stored.reuse, 'task')

  // Patch semantics, same as defaultModel: omitted keys keep stored values.
  const touched = await service.saveTemplate({ id: created.id, name: 'Reviewer', prompt: 'v2' })
  assert.deepEqual(touched.highTierModel, HIGH, 'omitted highTierModel preserved')
  assert.equal(touched.reuse, 'task', 'omitted reuse preserved')
  // An explicit value always applies.
  const other = { provider: 'acme', model: 'swift' }
  const changed = await service.saveTemplate({
    id: created.id, name: 'Reviewer', prompt: 'v3', highTierModel: other, reuse: 'role',
  })
  assert.deepEqual(changed.highTierModel, other)
  assert.equal(changed.reuse, 'role')
  // Including an explicit null.
  const cleared = await service.saveTemplate({ id: created.id, name: 'Reviewer', prompt: 'v4', highTierModel: null })
  assert.equal(cleared.highTierModel, null, 'explicit null clears the high-tier model')
  assert.equal(cleared.reuse, 'role', 'clearing one field leaves the other')
  assert.deepEqual(cleared.defaultModel, BASE, 'base model untouched')
  // A reuse outside the enum is a shape failure with the field named.
  await assert.rejects(
    () => service.saveTemplate({ name: 'X', prompt: 'p', reuse: 'sometimes' }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request'
      && remoteErrorOf(error).details.issues.some((issue) => issue.path === 'reuse'),
  )
  assert.equal((await service.listTemplates()).length, 2, 'the refused create stored nothing')
})

test('saveTemplate refuses a high-tier model without a base model and one with empty parts', async () => {
  const { service } = await makeRoster()
  const BASE = { provider: 'acme', model: 'cheap' }
  const HIGH = { provider: 'acme', model: 'capable' }
  const requiresBase = (error) => {
    const remote = remoteErrorOf(error)
    return remote?.code === 'roster/bad-request'
      && remote.details?.field === 'highTierModel'
      && /requires a base model/.test(remote.message)
      && /配置高阶模型前请先配置基础模型/.test(remote.message)
  }
  // Create: no base model at all.
  await assert.rejects(
    () => service.saveTemplate({ name: 'Reviewer', prompt: 'p', highTierModel: HIGH }),
    requiresBase,
  )
  // Update: the stored base model is an explicit null.
  const noBase = await service.saveTemplate({ name: 'Writer', prompt: 'p', defaultModel: null })
  await assert.rejects(
    () => service.saveTemplate({ id: noBase.id, name: 'Writer', prompt: 'p', highTierModel: HIGH }),
    requiresBase,
  )
  // Update: clearing the base model under the stored high-tier model — the
  // rule is on the EFFECTIVE pair after the patch merges, not the input alone.
  const tiered = await service.saveTemplate({
    name: 'Auditor', prompt: 'p', defaultModel: BASE, highTierModel: HIGH,
  })
  await assert.rejects(
    () => service.saveTemplate({ id: tiered.id, name: 'Auditor', prompt: 'p', defaultModel: null }),
    requiresBase,
  )
  // The refused write left the stored record intact.
  const [auditor] = (await service.listTemplates()).filter((rec) => rec.id === tiered.id)
  assert.deepEqual(auditor.defaultModel, BASE)
  assert.deepEqual(auditor.highTierModel, HIGH)

  // Empty provider or model: an unusable route, refused with the field named.
  for (const highTierModel of [{ provider: '', model: 'capable' }, { provider: 'acme', model: '' }]) {
    await assert.rejects(
      () => service.saveTemplate({ name: 'Broken', prompt: 'p', defaultModel: BASE, highTierModel }),
      (error) => {
        const remote = remoteErrorOf(error)
        return remote?.code === 'roster/bad-request'
          && remote.details?.issues?.some((issue) => issue.path === 'highTierModel')
      },
      `expected roster/bad-request naming highTierModel for ${JSON.stringify(highTierModel)}`,
    )
  }
  assert.equal((await service.listTemplates()).length, 2, 'no refused create stored a record')
})

test('listHighTierUse returns the newest records from the store log', async () => {
  const { service, store } = await makeRoster()
  const entry = (i) => ({
    id: `u${i}`,
    at: `2026-11-22T12:0${i}:00.000Z`,
    sessionId: 's1',
    templateId: 't1',
    templateName: 'Reviewer',
    memberName: 'reviewer',
    reason: 'template pins a high-tier model',
  })
  for (let i = 1; i <= 3; i++) await store.log.add(entry(i))
  // The remote is a fixed-size window: record the limit it asks the store for.
  const limits = []
  const list = store.log.list
  store.log.list = async (limit) => { limits.push(limit); return list(limit) }
  const rows = await service.listHighTierUse()
  assert.deepEqual(rows.map((row) => row.id), ['u3', 'u2', 'u1'], 'newest first, straight from the store log')
  assert.deepEqual(limits, [50])
  assert.deepEqual(await service.listHighTierUse(), rows, 'a read with no side effects')
})

test('degrades to memory store with storage-degraded status', async () => {
  // A real ctx always provides get(); an absent service resolves undefined.
  const status = recordingStatus()
  const store = openRosterStore({ get: () => undefined }, status)
  assert.equal(status.records.at(-1)?.stage, 'storage-degraded')
  // A scope with no get member at all degrades identically.
  const status2 = recordingStatus()
  openRosterStore({}, status2)
  assert.equal(status2.records.at(-1)?.stage, 'storage-degraded')

  const rec = RoleTemplate.parse({ id: 'm1', name: 'Reviewer', prompt: 'p', createdAt: T0, updatedAt: T0 })
  await store.put(rec)
  assert.deepEqual(await store.byId('m1'), rec)
  assert.equal(await store.byId('nope'), undefined)
  assert.equal((await store.all()).length, 1)
  assert.equal((await store.byName('Reviewer'))?.id, 'm1')
  assert.equal(await store.delete('nope'), false)

})

test('openRosterStore loads records written before the tiers change with role reuse and no high-tier model', async () => {
  const { store } = await makeRoster()
  // A record stored by the pre-tiers build carries neither new field; zod
  // defaults must fill them on load (nullable highTierModel, 'role' reuse).
  await store.put({ id: 'old', name: 'Reviewer', prompt: 'p', createdAt: T0, updatedAt: T0 })
  const rec = await store.byId('old')
  assert.equal(rec.highTierModel, null)
  assert.equal(rec.reuse, 'role')
})

test('the store keeps high-tier use in its own domain, newest first', async () => {
  const { store, storage } = await makeRoster()
  // The fake opens each domain by its real open(spec) name: the templates
  // domain is untouched, the log lives in agent_roster_log.
  assert.deepEqual(
    storage.opens.names.filter((n) => n === 'agent_roster' || n === 'agent_roster_log').sort(),
    ['agent_roster', 'agent_roster_log'],
  )
  const mk = (i) => ({
    id: `u${i}`,
    at: `2026-11-22T12:0${i}:00.000Z`,
    sessionId: 's',
    templateId: 't',
    templateName: 'Reviewer',
    memberName: 'reviewer',
    reason: 'template pins a high-tier model',
  })
  for (let i = 1; i <= 3; i++) await store.log.add(mk(i))
  const all = await store.log.list()
  assert.deepEqual(all.map((r) => r.id), ['u3', 'u2', 'u1'], 'newest (largest at) first')
  assert.equal((await store.log.list(2)).length, 2)
})

test('AgentRosterService carries Remote markers for template CRUD, stageSpawn and listHighTierUse', () => {
  // remoteMethods reads markers off getPrototypeOf(service): pass an instance.
  const markers = remoteMethods(Object.create(AgentRosterService.prototype))
  // ADR-0011 kept the remote surface to template CRUD (spawn is an agent
  // tool); ADR-0012 adds stageSpawn — the dialog stages its request here and
  // the /roster command consumes it — and the tiers change adds the read-only
  // high-tier dispatch log. Nothing spawns through the remote.
  assert.deepEqual(markers.map((m) => m.method).sort(),
    ['deleteTemplate', 'listHighTierUse', 'listTemplates', 'saveTemplate', 'stageSpawn'])
  for (const marker of markers) {
    assert.deepEqual(marker.invocation, { kind: 'direct' }, `${marker.method} is a direct invocation`)
    assert.equal(marker.mode, undefined, 'unary method')
  }
})

test('apply registers the service over the domain store and closes the domain on unload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-roster-t2-'))
  const file = join(dir, 'status.json')
  const prev = process.env.AGENT_ROSTER_STATUS_FILE
  process.env.AGENT_ROSTER_STATUS_FILE = file
  try {
    const storage = makeFakeStorageDomain()
    const host = makeFakeHost({ storageDomain: storage })
    const constructed = []
    setServiceFactoryForTests((ctx, store) => { constructed.push({ ctx, store }) })
    await apply(host.ctx, { exposeAgentTools: { get: () => true } })
    assert.equal(constructed.length, 1, 'service constructed exactly once')
    assert.equal(constructed[0].ctx, host.ctx, 'service receives the plugin ctx')
    assert.equal(typeof constructed[0].store.all, 'function', 'service receives the opened store')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'tools-pending')
    assert.equal(storage.opens.closedCounts[0], 0, 'domain open while mounted')
    host.effects[0].dispose()
    // dispose() rides the domain-open promise's microtask: flush before
    // asserting (no fire-and-forget assertions).
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(storage.opens.closedCounts[0], 1, 'domain closed at fiber disposal (caller-owns-handle)')
  } finally {
    setServiceFactoryForTests(undefined)
    if (prev === undefined) delete process.env.AGENT_ROSTER_STATUS_FILE
    else process.env.AGENT_ROSTER_STATUS_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejected domain open never dangles: recorded, mount completes, ops fail loudly', async () => {
  // Node's default unhandled-rejection policy throws and kills the process;
  // capture the hook to assert the open() rejection is acknowledged instead.
  const unhandled = []
  const onUnhandled = (error) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  const dir = mkdtempSync(join(tmpdir(), 'agent-roster-t2-'))
  const file = join(dir, 'status.json')
  const prev = process.env.AGENT_ROSTER_STATUS_FILE
  process.env.AGENT_ROSTER_STATUS_FILE = file
  try {
    const failure = new Error('backend version-mismatch')

    // Store level: the failing facility is resolved, open() rejects.
    const status = recordingStatus()
    const store = openRosterStore({ get: () => ({ open: async () => { throw failure } }) }, status)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      status.records.filter((r) => r.stage === 'storage-open-failed').map((r) => r.detail),
      [String(failure), String(failure)],
      'each opened domain (templates, log) records its degradation once',
    )
    // Operations still fail loudly with the typed backend error — the
    // creation-time handler observes, it does not swallow.
    await assert.rejects(() => store.all(), (error) => error === failure)
    await assert.rejects(() => store.put({ id: 'z', name: 'Z', prompt: 'p', createdAt: T0, updatedAt: T0 }), (error) => error === failure)

    // Mount level: apply still completes (done) — the failure settles after
    // the mount, so it must not crash or block it — and the real status
    // writer records the degradation once the rejection lands. apply() runs
    // its effect body synchronously, so read the file WITHOUT awaiting (an
    // await would flush the rejection microtask and overwrite first).
    const host = makeFakeHost({ storageDomain: { open: async () => { throw failure } } })
    let factoryRan = 0
    setServiceFactoryForTests(() => { factoryRan += 1 })
    apply(host.ctx, { exposeAgentTools: { get: () => true } })
    assert.equal(factoryRan, 1, 'service registration ran — the mount completed')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'tools-pending', 'mount proceeds past the open failure up to the tools stage')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'storage-open-failed')
    // Disposal over a failed open is also safe (nothing to close).
    host.effects[0].dispose()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [], 'no unhandled rejection anywhere on the failed-open path')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    setServiceFactoryForTests(undefined)
    if (prev === undefined) delete process.env.AGENT_ROSTER_STATUS_FILE
    else process.env.AGENT_ROSTER_STATUS_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejected domain close is observed at unload: recorded as storage-close-failed, never an unhandled rejection', async () => {
  // DomainFacility.close() is async (storage-domain src/domain.ts:251-260)
  // and rejects when the unit fails to close, so a synchronous try around
  // the call cannot see that — the rejected promise would dangle. Capture
  // Node's hook (default policy: throw) as the rejected-open test above does.
  const unhandled = []
  const onUnhandled = (error) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const failure = new Error('unit close failed')
    const closed = []
    const domain = { table: () => { throw new Error('not touched') }, close: () => { closed.push(true); return Promise.reject(failure) } }
    const status = recordingStatus()
    const store = openRosterStore({ get: () => ({ open: async () => domain }) }, status)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed.length, 0, 'nothing is closed while mounted')
    store.dispose()
    // The rejection lands on a later tick: flush before asserting.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed.length, 2, 'both domains (templates, log) are told to close')
    assert.deepEqual(
      status.records.filter((r) => r.stage === 'storage-close-failed').map((r) => r.detail),
      [String(failure), String(failure)],
      'each failed close is recorded once',
    )
    assert.deepEqual(unhandled, [], 'no unhandled rejection on the close path')

    // A synchronous throw from close() is still contained by the same path.
    const syncStatus = recordingStatus()
    const syncFailure = new Error('sync close failed')
    const syncStore = openRosterStore({ get: () => ({ open: async () => ({ close() { throw syncFailure } }) }) }, syncStatus)
    await new Promise((resolve) => setImmediate(resolve))
    assert.doesNotThrow(() => syncStore.dispose())
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      syncStatus.records.filter((r) => r.stage === 'storage-close-failed').map((r) => r.detail),
      [String(syncFailure), String(syncFailure)],
    )
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('apply containment: a service failure writes wire-failed, rethrows, and still disposes the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-roster-t2-'))
  const file = join(dir, 'status.json')
  const prev = process.env.AGENT_ROSTER_STATUS_FILE
  process.env.AGENT_ROSTER_STATUS_FILE = file
  try {
    const storage = makeFakeStorageDomain()
    const host = makeFakeHost({ storageDomain: storage })
    setServiceFactoryForTests(() => { throw new Error('boom') })
    // Real cordis runs the effect body synchronously, so the contained
    // rethrow escapes apply() as a synchronous throw (loud failed load).
    assert.throws(() => apply(host.ctx, { exposeAgentTools: true }), /boom/)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'wire-failed')
    // The failure path's dispose() rides a microtask: flush before asserting.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(storage.opens.closedCounts[0], 1, 'the already-opened domain is released on the failure path')
  } finally {
    setServiceFactoryForTests(undefined)
    if (prev === undefined) delete process.env.AGENT_ROSTER_STATUS_FILE
    else process.env.AGENT_ROSTER_STATUS_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// stageSpawn (ADR-0012): the dialog's one-shot request for the /roster command
// ---------------------------------------------------------------------------

/** The REAL service over the REAL store and a REAL staging (no cordis Context needed). */
async function makeStagedService(...templates) {
  const { service, store } = await makeRoster()
  service.staging = createStaging({ ttlMs: 60_000, now: () => 0 })
  for (const t of templates) await store.put(RoleTemplate.parse(t))
  return { service, store, staging: service.staging }
}

test('stageSpawn stores a one-shot request bound to the session, task trimmed', async () => {
  const { service, staging } = await makeStagedService({ id: 't1', name: 'Reviewer', prompt: 'Review diffs.', createdAt: T0, updatedAt: T0 })
  const out = await service.stageSpawn({
    sessionId: 'sess-1', templateId: 't1',
    model: { provider: 'acme', model: 'cheap', reasoningEffort: 'low' }, task: '  review payments  ',
  })
  assert.deepEqual(out, { staged: true })
  assert.deepEqual(staging.take('sess-1'), {
    templateRef: 't1', model: { provider: 'acme', model: 'cheap', reasoningEffort: 'low' }, task: 'review payments',
  })
  assert.equal(staging.take('sess-1'), undefined, 'single use')
})

test('stageSpawn accepts model null (inherit) and stages by exact template name too', async () => {
  const { service, staging } = await makeStagedService({ id: 't1', name: 'Reviewer', prompt: 'Review diffs.', createdAt: T0, updatedAt: T0 })
  await service.stageSpawn({ sessionId: 'sess-1', templateId: 'Reviewer', model: null })
  assert.deepEqual(staging.take('sess-1'), { templateRef: 'Reviewer', model: null, task: '' })
})

test('stageSpawn refuses an unknown template immediately so the dialog can show it', async () => {
  const { service, staging } = await makeStagedService()
  await assert.rejects(
    () => service.stageSpawn({ sessionId: 'sess-1', templateId: 'nobody', model: null, task: '' }),
    (error) => error?.code === 'roster/not-found',
  )
  assert.equal(staging.size, 0, 'nothing is left staged for a refused request')
})

test('stageSpawn rejects a missing sessionId or templateId and an invalid model', async () => {
  const { service, staging } = await makeStagedService({ id: 't1', name: 'Reviewer', prompt: 'Review diffs.', createdAt: T0, updatedAt: T0 })
  for (const input of [
    { templateId: 't1', model: null },
    { sessionId: 'sess-1', model: null },
    { sessionId: 'sess-1', templateId: 't1', model: { provider: '', model: 'x' } },
    { sessionId: 'sess-1', templateId: 't1', model: { provider: 'acme', model: 'cheap', reasoningEffort: '' } },
    { sessionId: 'sess-1', templateId: 't1', model: 'acme/cheap' },
  ]) {
    await assert.rejects(() => service.stageSpawn(input), (error) => error?.code === 'roster/bad-request', JSON.stringify(input))
  }
  assert.equal(staging.size, 0)
})
