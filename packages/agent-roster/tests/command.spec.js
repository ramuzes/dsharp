/**
 * Tests for the `/roster` command (2026-11-25): the "+" dialog creates a
 * member through a host command, the way `/compact` compacts — two log-only
 * lifecycle events and no model message (dsh packages/interaction/commands:
 * `execute()` appends `command/run` before the handler and `command/done` at
 * settlement; README: "without turning the command or its result into a model
 * message").
 *
 * Fakes mirror real strictness (AGENTS.md §1): the command registry returns
 * the exact disposer (commands/src/index.ts register), the subagents fake
 * applies the activation admission checks the runtime applies, and templates
 * go through the REAL store and resolver.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStaging } from '../lib/staging.js'
import { createRosterCommand, registerRosterCommand } from '../lib/roster-command.js'
import { openRosterStore, RoleTemplate } from '../lib/store.js'

const T0 = '2026-11-22T12:00:00.000Z'
const RESEARCHER = { id: 't1', name: 'Researcher', description: 'Finds sources', prompt: 'You research thoroughly.', defaultModel: null, createdAt: T0, updatedAt: T0 }

async function makeStore(...templates) {
  const store = openRosterStore({ get: () => undefined })
  for (const t of templates) await store.put(RoleTemplate.parse(t))
  return store
}

/** Recording spawn: the command's only side effect, with the real result shape. */
function makeSpawn(result = { name: 'researcher', childSessionId: 'cs-1', model: null }) {
  const calls = []
  return { calls, spawn: async (input) => { calls.push(input); return result } }
}

const invocationOf = (sessionId, rawInput = '', signal = new AbortController().signal) =>
  ({ commandId: 'cmd-1', agent: { id: sessionId, session: { id: sessionId } }, rawInput, attachments: [], signal })

// ---------------------------------------------------------------------------
// staging: the dialog's one-shot request, bound to the session that made it
// ---------------------------------------------------------------------------

test('a staged request is returned once and then gone', () => {
  let now = 1000
  const staging = createStaging({ ttlMs: 120_000, now: () => now })
  staging.put('sess-1', { templateRef: 't1', model: null, task: '' })
  assert.deepEqual(staging.take('sess-1'), { templateRef: 't1', model: null, task: '' })
  assert.equal(staging.take('sess-1'), undefined, 'single use')
})

test('a staged request expires and never fires later', () => {
  let now = 1000
  const staging = createStaging({ ttlMs: 120_000, now: () => now })
  staging.put('sess-1', { templateRef: 't1', model: null, task: '' })
  now += 120_001
  assert.equal(staging.take('sess-1'), undefined)
})

test('a staged request belongs to one session; a later stage for the same session replaces it', () => {
  const staging = createStaging({ ttlMs: 120_000, now: () => 0 })
  staging.put('sess-1', { templateRef: 't1', model: null, task: '' })
  staging.put('sess-1', { templateRef: 't2', model: null, task: 'later' })
  assert.equal(staging.take('sess-2'), undefined, 'another session cannot consume it')
  assert.equal(staging.take('sess-1').templateRef, 't2')
})

test('staging prunes expired entries of other sessions on access', () => {
  let now = 0
  const staging = createStaging({ ttlMs: 1000, now: () => now })
  staging.put('old', { templateRef: 't1', model: null, task: '' })
  now = 5000
  staging.put('new', { templateRef: 't1', model: null, task: '' })
  assert.equal(staging.size, 1, 'the expired entry is dropped')
})

// ---------------------------------------------------------------------------
// the handler
// ---------------------------------------------------------------------------

test('a bare /roster consumes the staged request of the invoking session', async () => {
  const store = await makeStore(RESEARCHER)
  const staging = createStaging({ ttlMs: 120_000, now: () => 0 })
  staging.put('sess-1', { templateRef: 't1', model: { provider: 'acme', model: 'cheap' }, task: 'review payments' })
  const recorded = makeSpawn()
  const command = createRosterCommand({ store, staging, spawn: recorded.spawn })
  const signal = new AbortController().signal
  const out = await command.handler(invocationOf('sess-1', '', signal))

  assert.equal(out.kind, 'success')
  assert.equal(recorded.calls.length, 1)
  const input = recorded.calls[0]
  assert.equal(input.agent.session.id, 'sess-1')
  assert.equal(input.template.id, 't1')
  assert.equal(input.task, 'review payments')
  assert.deepEqual(input.model, { provider: 'acme', model: 'cheap' })
  assert.equal(input.signal, signal, 'the command signal owns cancellation')
  assert.ok(out.text.includes('"researcher" (Researcher) created and given its first task'))
  assert.equal(staging.take('sess-1'), undefined, 'consumed')
})

test('a standby spawn reports the member name and that it is standing by', async () => {
  const store = await makeStore(RESEARCHER)
  const staging = createStaging({ ttlMs: 120_000, now: () => 0 })
  staging.put('sess-1', { templateRef: 't1', model: null, task: '' })
  const recorded = makeSpawn()
  const command = createRosterCommand({ store, staging, spawn: recorded.spawn })
  const out = await command.handler(invocationOf('sess-1'))
  assert.equal(recorded.calls[0].task, '')
  assert.ok(out.text.includes('created and standing by'))
  assert.ok(out.text.includes('inherits the session model'))
})

test('a typed "/roster <template>" adds that template with its defaults and no staged request', async () => {
  const store = await makeStore(RESEARCHER)
  const staging = createStaging({ ttlMs: 120_000, now: () => 0 })
  const recorded = makeSpawn()
  const command = createRosterCommand({ store, staging, spawn: recorded.spawn })
  const out = await command.handler(invocationOf('sess-1', '  Researcher '))
  assert.equal(out.kind, 'success')
  assert.equal(recorded.calls[0].template.id, 't1')
  assert.equal(recorded.calls[0].model, undefined, 'no override: the template default applies')
  assert.equal(recorded.calls[0].task, undefined, 'typed use creates a standby member')
})

test('a staged request wins over the typed argument', async () => {
  const other = { ...RESEARCHER, id: 't2', name: 'Scout' }
  const store = await makeStore(RESEARCHER, other)
  const staging = createStaging({ ttlMs: 120_000, now: () => 0 })
  staging.put('sess-1', { templateRef: 't2', model: null, task: '' })
  const recorded = makeSpawn({ name: 'scout', model: null })
  const command = createRosterCommand({ store, staging, spawn: recorded.spawn })
  await command.handler(invocationOf('sess-1', 'Researcher'))
  assert.equal(recorded.calls[0].template.id, 't2')
})

test('without a staged request and without an argument the command answers its usage', async () => {
  const store = await makeStore(RESEARCHER)
  const recorded = makeSpawn()
  const command = createRosterCommand({ store, staging: createStaging({ ttlMs: 1, now: () => 0 }), spawn: recorded.spawn })
  const out = await command.handler(invocationOf('sess-1', '   '))
  assert.equal(out.kind, 'error')
  assert.match(out.text, /\/roster <template/)
  assert.equal(recorded.calls.length, 0)
})

test('an unknown template is a model-safe error and creates nothing', async () => {
  const store = await makeStore(RESEARCHER)
  const recorded = makeSpawn()
  const command = createRosterCommand({ store, staging: createStaging({ ttlMs: 1, now: () => 0 }), spawn: recorded.spawn })
  const out = await command.handler(invocationOf('sess-1', 'Nobody'))
  assert.equal(out.kind, 'error')
  assert.match(out.text, /roster call failed \(roster\/not-found\)/)
  assert.equal(recorded.calls.length, 0)
})

test('a failed spawn is reported as an error, never thrown into the command executor', async () => {
  const store = await makeStore(RESEARCHER)
  const command = createRosterCommand({
    store, staging: createStaging({ ttlMs: 1, now: () => 0 }),
    spawn: async () => { throw new Error('runtime said no') },
  })
  const out = await command.handler(invocationOf('sess-1', 'Researcher'))
  assert.equal(out.kind, 'error')
  assert.match(out.text, /runtime said no/)
})

test('a staged request is single-use even when its template cannot be resolved', async () => {
  const store = await makeStore(RESEARCHER)
  const staging = createStaging({ ttlMs: 120_000, now: () => 0 })
  staging.put('sess-1', { templateRef: 'gone', model: null, task: '' })
  const recorded = makeSpawn()
  const command = createRosterCommand({ store, staging, spawn: recorded.spawn })
  const first = await command.handler(invocationOf('sess-1'))
  const second = await command.handler(invocationOf('sess-1'))
  assert.match(first.text, /roster\/not-found/)
  assert.match(second.text, /\/roster <template/, 'the second run finds no staged request')
  assert.equal(recorded.calls.length, 0)
})

test('the definition names the command, describes it, and hints its input', () => {
  const store = openRosterStore({ get: () => undefined })
  const command = createRosterCommand({ store, staging: createStaging({ ttlMs: 1, now: () => 0 }), spawn: makeSpawn().spawn })
  assert.equal(command.name, 'roster')
  assert.equal(typeof command.description, 'string')
  assert.equal(typeof command.input.hint, 'string')
  assert.equal(typeof command.handler, 'function')
})

// ---------------------------------------------------------------------------
// registration (the /compact lifecycle pattern: drain before disposal)
// ---------------------------------------------------------------------------

test('registerRosterCommand registers on the scope and hands its subagents to the real spawn', async () => {
  const store = await makeStore(RESEARCHER)
  const staging = createStaging({ ttlMs: 120_000, now: () => 0 })
  staging.put('sess-1', { templateRef: 't1', model: null, task: '' })
  const activations = []
  const subagents = {
    rootOf: (agent) => agent,
    listDescendants: async () => [],
    startActivation: async (spec) => {
      if (spec.delivery !== 'parent' && spec.delivery !== 'caller') throw new Error('bad delivery')
      if (!(spec.signal instanceof AbortSignal)) throw new Error('signal is required')
      activations.push(spec)
      return { childId: 'cs-1', name: spec.name }
    },
  }
  const registered = []
  const scope = {
    subagents,
    commands: {
      register: (definition) => { registered.push(definition); return () => { registered.splice(registered.indexOf(definition), 1) } },
    },
  }
  const off = registerRosterCommand(scope, { store, staging })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'roster')
  assert.equal(typeof off, 'function')
  const out = await registered[0].handler(invocationOf('sess-1'))
  assert.equal(out.kind, 'success')
  assert.equal(activations.length, 1, 'the real spawnFromTemplate ran against the scope subagents')
  assert.equal(activations[0].delivery, 'caller', 'standby: the member settles without waking the lead')
  await off()
  await off()
  assert.equal(registered.length, 0, 'the registration is undone exactly once')
})
