/**
 * Host-half tests. Task 1: config unwrap discipline, the staged status
 * writer, and the apply() boot sequence. Task 2: the storageDomain-backed
 * roster store and the AgentRosterService CRUD remote.
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
  const opens = { specs: [], closedCounts: [] }
  return {
    opens,
    async open(spec) {
      const index = opens.specs.push(spec) - 1
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
    assert.equal(host.injects.length, 0, 'no inject callback registered')
    assert.equal(host.effects.length, 1, 'wiring wrapped in exactly one ctx.effect')
    assert.ok(wrapperReads >= 1, 'exposeAgentTools must be read through the wrapper getter')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(record.stage, 'done', 'stage sequence ends with a done record')
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

// ---------------------------------------------------------------------------
// Task 2: roster store + CRUD remote
// ---------------------------------------------------------------------------

test('store persists through the storageDomain fake which validates records with the real zod schemas', async () => {
  const { store, storage } = await makeRoster()
  // The store opened exactly the declared domain spec through the facility.
  assert.equal(storage.opens.specs.length, 1)
  assert.equal(storage.opens.specs[0].name, 'agent_roster')
  assert.equal(storage.opens.specs[0].version, 1)
  assert.deepEqual(Object.keys(storage.opens.specs[0].tables).sort(), ['draft_sessions', 'templates'])

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

  // Draft-session mapping ops round-trip keyed by cwd.
  await store.putDraftSession({ cwd: '/w', sessionId: 's1', createdAt: T0 })
  assert.deepEqual(await store.draftSessionFor('/w'), { cwd: '/w', sessionId: 's1', createdAt: T0 })
  assert.equal(await store.draftSessionFor('/other'), undefined)
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
  await store.putDraftSession({ cwd: '/w', sessionId: 's1', createdAt: T0 })
  assert.deepEqual(await store.draftSessionFor('/w'), { cwd: '/w', sessionId: 's1', createdAt: T0 })
})

test('AgentRosterService carries Remote markers for the three CRUD methods', () => {
  // remoteMethods reads markers off getPrototypeOf(service): pass an instance.
  const markers = remoteMethods(Object.create(AgentRosterService.prototype))
  assert.deepEqual(markers.map((m) => m.method).sort(), ['deleteTemplate', 'listTemplates', 'saveTemplate'])
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
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'done')
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
