/**
 * Task 4 tests: AI-assisted template drafting over the reusable per-workspace
 * draft session (ADR-0010).
 *
 * Fakes mirror the real strictness verified in the dsh checkout
 * (/home/ramuz/deepseek-harness, AGENTS.md 2b: source is the source of truth):
 *
 * - `resolveAgent` fake returns `{ agent } | { error }`, the real result shape
 *   (packages/api/session-controller/src/agent.ts:90-92); a typed error
 *   rethrows as-is (schedule precedent, schedule/src/index.ts:250-257).
 * - `create` fake mirrors SessionCreateRequest/SessionCreateValue
 *   (session-controller src/commands.ts:120-158, src/types.ts:272-277):
 *   takes `{ sessionId?, cwd, agentPreset? }`, returns `{ sessionId }`.
 * - `selectModel` fake mirrors the Remote surface
 *   (session-controller src/index.ts:289-292):
 *   `{ sessionId, provider, model, reasoningEffort? }`.
 * - Fake sessions carry `header.cwd` + `deriveMessages(): Message[]`
 *   (core/session src/index.ts — header at :567, controller consumers at
 *   agent.ts:303,340); fake agents expose `followup(message): void`
 *   (core/agent src/runtime-types.ts:252).
 * - Fake `sessions.flush(session): Promise<boolean>` mirrors the real
 *   durability checkpoint (core/session src/index.ts:1422-1438): true when a
 *   listener participated, throws the listener failure.
 * - Fake `sessionTitle` mirrors `get(session): snapshot | undefined` and
 *   `rename(session, title)` (session/session-title src/index.ts:393-427).
 * - Fake emitter mirrors cordis `scope.on(name, listener, options)` returning
 *   a disposer; `session/event` listeners receive `(session, event)` with
 *   `event.type` discriminating (core/session src/types.ts:510-536, map
 *   entry `turn/end` at :307). Registered options must be `{ global: true }`
 *   — the feishu-gateway precedent (packages/feishu-gateway/index.js:326-331),
 *   NOT a scoped waterfall.
 * - The delivered message is built by the REAL `createUserMessage`
 *   (@deepseek-ai/dsh-llm), never a hand-rolled fake.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteError, remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { buildMetaPrompt, parseDraft, lastAssistantText, runDraft, DRAFT_SESSION_TITLE } from '../lib/drafter.js'
import { openRosterStore } from '../lib/store.js'
import { AgentRosterService } from '../lib/roster-service.js'

/** Fixed timestamp for hand-built records. */
const T0 = '2026-11-22T12:00:00.000Z'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Recording event emitter standing in for cordis event registration:
 * `on(name, listener, options)` returns a disposer, exactly like a real
 * Context. `emit` drives listeners synchronously like a cordis dispatch.
 */
function fakeEmitter() {
  const listeners = []
  return {
    listeners,
    on(name, listener, options) {
      const entry = { name, listener, options, removed: false }
      listeners.push(entry)
      return () => { entry.removed = true }
    },
    emit(name, ...args) {
      for (const entry of [...listeners]) {
        if (!entry.removed && entry.name === name) entry.listener(...args)
      }
    },
  }
}

/**
 * A scope whose ONLY members are the sanctioned get() lookup and the on()
 * event registration; any other property access throws exactly like a
 * non-injected service in cordis (spawn.spec.js strictScope pattern).
 */
function strictScope(services = {}, emitter = fakeEmitter()) {
  const framework = {
    get: (name) => services[name],
    on: (name, listener, options) => emitter.on(name, listener, options),
  }
  return new Proxy(framework, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      throw new Error(`cannot get property ${String(prop)} without inject`)
    },
  })
}

/**
 * Real in-memory roster store (memory fallback path of openRosterStore): no
 * hand-rolled store fake to drift from the real interface.
 */
function makeStore() {
  return openRosterStore({ get: () => undefined })
}

/** Fake Session: header with cwd, deriveMessages() over stored messages. */
function fakeSession({ id, cwd, messages = [] }) {
  return { id, header: { id, cwd }, deriveMessages: () => messages }
}

/** Fake Agent: identity, live session, recorded followup deliveries. */
function fakeAgent({ id, session, onFollowup }) {
  const followups = []
  return {
    id,
    session,
    followups,
    followup(message) { followups.push(message); onFollowup?.(message) },
  }
}

/**
 * Fake sessionController mirroring resolveAgent/create/selectModel. Agents
 * are keyed by session id; `resolveErrors` pins exact error objects;
 * `onCreate(request)` lets a rig register the draft agent under the fresh id.
 */
function fakeSessionController({ agents = {}, resolveErrors = {}, onCreate } = {}) {
  const created = []
  const selections = []
  // Used by reference, not copied: an onCreate hook may register agents under
  // ids minted inside create() and resolveAgent must see them.
  const table = agents
  return {
    created,
    selections,
    async resolveAgent(sessionId) {
      if (resolveErrors[sessionId] !== undefined) return { error: resolveErrors[sessionId] }
      const agent = table[sessionId]
      return agent === undefined
        ? { error: new RemoteError('session/not-found', `session ${sessionId} not found`) }
        : { agent }
    },
    async create(request) {
      created.push(request)
      await onCreate?.(request)
      return { sessionId: request.sessionId }
    },
    async selectModel(request) { selections.push(request); return { ...request } },
  }
}

/** Fake sessions store: flush(session) with configurable outcome. */
function fakeSessions({ result = true, error = undefined } = {}) {
  const flushes = []
  return {
    flushes,
    async flush(session) {
      flushes.push(session)
      if (error !== undefined) throw error
      return result
    },
  }
}

/** Fake sessionTitle: get(session) undefined until renamed (schedule model). */
function fakeSessionTitle() {
  const titled = new Map()
  const gets = []
  const renames = []
  return {
    gets,
    renames,
    get(session) { gets.push(session); return titled.get(session.id) },
    rename(session, title) {
      renames.push({ session, title })
      titled.set(session.id, { title, source: { kind: 'user' } })
    },
  }
}

/** One assistant message over the surface projection shape. */
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
/** One assistant message with several text blocks. */
const assistant2 = (...texts) => ({ role: 'assistant', content: texts.map((text) => ({ type: 'text', text })) })
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

/** A complete draft rig: requesting session + lazily created draft session. */
function makeRig({ cwd = '/w', brief = 'A reviewer for pull requests', assistantText, flush, silent = false } = {}) {
  const emitter = fakeEmitter()
  const store = makeStore()
  const draftSession = fakeSession({ id: 'draft-1', cwd, messages: [] })
  const draftAgent = fakeAgent({
    id: 'draft-1',
    session: draftSession,
    onFollowup: () => {
      // Default: the draft turn ends synchronously with the delivery, before
      // flush resolves — pins the subscribe-before-followup ordering. The
      // `silent` rigs keep the turn open for manual emission.
      if (!silent) {
        emitter.emit('session/event', draftSession, { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
      }
    },
  })
  draftSession.deriveMessages = () => [user(brief), assistant(assistantText ?? '')]
  const requestingAgent = fakeAgent({ id: 's-req', session: fakeSession({ id: 's-req', cwd }) })
  const table = { 's-req': requestingAgent }
  const controller = fakeSessionController({
    agents: table,
    // The draft agent appears under whatever fresh id create() minted.
    onCreate: (request) => {
      draftSession.header.id = request.sessionId
      draftSession.id = request.sessionId
      draftAgent.id = request.sessionId
      table[request.sessionId] = draftAgent
    },
  })
  const sessions = fakeSessions(flush ?? {})
  const sessionTitle = fakeSessionTitle()
  const scope = strictScope({ sessionController: controller, sessions, sessionTitle }, emitter)
  return { emitter, store, scope, controller, sessions, sessionTitle, draftAgent, draftSession }
}

// ---------------------------------------------------------------------------
// buildMetaPrompt
// ---------------------------------------------------------------------------

test('buildMetaPrompt pins the full authoring contract and embeds the brief', () => {
  const prompt = buildMetaPrompt('A reviewer that audits pull requests')
  for (const marker of [
    'ONLY a JSON object',
    'no markdown code fences',
    'no commentary',
    '"name"',
    '2–4 words',
    '"description"',
    'one-line',
    '"prompt"',
    'duties',
    'working rules',
    'constraints',
    'output expectations',
    'instructions addressed to the agent itself',
    'same language as the brief',
  ]) {
    assert.ok(prompt.includes(marker), `meta-prompt must contain "${marker}"`)
  }
  assert.ok(prompt.endsWith('A reviewer that audits pull requests'), 'the brief rides verbatim at the end')
  assert.equal(buildMetaPrompt('x'), buildMetaPrompt('x'), 'deterministic for the same brief')
})

// ---------------------------------------------------------------------------
// parseDraft
// ---------------------------------------------------------------------------

test('parseDraft extracts the first {...} block and reports parsed true', () => {
  const draft = parseDraft('Sure! Here it is:\n{"name":"Code Reviewer","description":"Reviews diffs","prompt":"You review diffs."}')
  assert.deepEqual(draft, { name: 'Code Reviewer', description: 'Reviews diffs', prompt: 'You review diffs.', parsed: true })
  // The FIRST block wins even when later braces follow.
  const first = parseDraft('{"name":"A","description":"d","prompt":"p"} trailing {"name":"B","description":"d","prompt":"q"}')
  assert.deepEqual(first, { name: 'A', description: 'd', prompt: 'p', parsed: true })
})

test('parseDraft handles braces inside JSON strings', () => {
  const draft = parseDraft('{"name":"A","description":"uses {braces}","prompt":"p"}')
  assert.deepEqual(draft, { name: 'A', description: 'uses {braces}', prompt: 'p', parsed: true })
})

test('parse failure returns the raw text as prompt with parsed false', () => {
  assert.deepEqual(parseDraft('no json here'), { name: '', description: '', prompt: 'no json here', parsed: false })
  assert.deepEqual(parseDraft('{"name": broken'), { name: '', description: '', prompt: '{"name": broken', parsed: false })
  // A parse that yields the wrong shape is a failure too (own boundary
  // assertion — the return type promises three strings).
  assert.deepEqual(
    parseDraft('{"name":"A","prompt":"p"}'),
    { name: '', description: '', prompt: '{"name":"A","prompt":"p"}', parsed: false },
  )
  assert.deepEqual(parseDraft('["not","an","object"]'), { name: '', description: '', prompt: '["not","an","object"]', parsed: false })
  assert.deepEqual(parseDraft(''), { name: '', description: '', prompt: '', parsed: false })
  assert.deepEqual(parseDraft(undefined), { name: '', description: '', prompt: '', parsed: false })
})

// ---------------------------------------------------------------------------
// lastAssistantText (port of feishu lib/driver.js:42-60)
// ---------------------------------------------------------------------------

test('lastAssistantText returns the last assistant message text, skipping later user turns', () => {
  const session = fakeSession({
    id: 's', cwd: '/w',
    messages: [
      user('q1'),
      assistant('a1'),
      user('q2'),
      // One assistant message with several text blocks: blocks join.
      assistant2('part one ', 'part two'),
      // A later user turn does not become the answer…
      user('q3'),
      // …but a later assistant message does: it alone is the turn's answer.
      assistant('final'),
    ],
  })
  assert.equal(lastAssistantText(session), 'final')
  const single = fakeSession({ id: 's2', cwd: '/w', messages: [user('q'), assistant2('a ', 'b')] })
  assert.equal(lastAssistantText(single), 'a b', 'text blocks of one message join')
})

test('lastAssistantText is gracefully empty without an assistant or a surface', () => {
  assert.equal(lastAssistantText(fakeSession({ id: 's', cwd: '/w', messages: [user('q')] })), '')
  assert.equal(lastAssistantText({ id: 's' }), '', 'no deriveMessages member')
  assert.equal(lastAssistantText(undefined), '')
})

// ---------------------------------------------------------------------------
// runDraft — happy paths
// ---------------------------------------------------------------------------

test('creates the draft session once and reuses it across two drafts', async () => {
  const rig = makeRig({ assistantText: '{"name":"Code Reviewer","description":"Reviews diffs","prompt":"You review diffs."}' })
  const input = { sessionId: 's-req', brief: 'A reviewer for pull requests' }
  const first = await runDraft(rig.scope, { store: rig.store }, input)
  assert.deepEqual(first, { name: 'Code Reviewer', description: 'Reviews diffs', prompt: 'You review diffs.', parsed: true })

  // Second draft, same workspace: no second create, title pinned once.
  const second = await runDraft(rig.scope, { store: rig.store }, input)
  assert.deepEqual(second, { name: 'Code Reviewer', description: 'Reviews diffs', prompt: 'You review diffs.', parsed: true })
  assert.equal(rig.controller.created.length, 1, 'sessionController.create called exactly once')
  assert.equal(rig.controller.created[0].cwd, '/w')
  assert.ok(rig.controller.created[0].sessionId.startsWith('session-'), 'fresh session id follows the schedule id shape')
  assert.equal(rig.sessionTitle.renames.length, 1, 'title pinned once')
  assert.deepEqual(rig.sessionTitle.renames[0].title, DRAFT_SESSION_TITLE)
  // The pointer record persisted for the workspace.
  const record = await rig.store.draftSessionFor('/w')
  assert.equal(record.sessionId, rig.controller.created[0].sessionId)
  assert.equal(record.cwd, '/w')
  // Both drafts delivered to the SAME live agent.
  assert.equal(rig.draftAgent.followups.length, 2)
})

test('delivers the meta-prompt as a real createUserMessage user message', async () => {
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  await runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: 'Translate things' })
  const message = rig.draftAgent.followups[0]
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0, 'identified by createUserMessage')
  assert.deepEqual(message.content, [{ type: 'text', text: buildMetaPrompt('Translate things') }])
})

test('subscribes to the global session/event stream and filters by session and type', async () => {
  const rig = makeRig({ silent: true, assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  const pending = runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: 'b' })
  // Let the creation + flush settle; the draft is now parked on turn/end.
  await new Promise((resolve) => setImmediate(resolve))
  const registrations = rig.emitter.listeners.filter((l) => l.name === 'session/event')
  assert.equal(registrations.length, 1, 'subscribed to session/event exactly once')
  assert.deepEqual(registrations[0].options, { global: true }, 'global stream, not a scoped waterfall')
  // Noise first: another session's turn/end, then a non-turn event on the
  // draft session itself.
  rig.emitter.emit('session/event', fakeSession({ id: 'other', cwd: '/w' }), { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
  rig.emitter.emit('session/event', rig.draftSession, { type: 'turn/start', seq: 3, time: 0, data: { turn: 2 } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(rig.emitter.listeners.filter((l) => l.name === 'session/event' && !l.removed).length, 1, 'still parked: noise filtered')
  rig.emitter.emit('session/event', rig.draftSession, { type: 'turn/end', seq: 4, time: 0, data: { turn: 2, reason: { kind: 'completed' } } })
  const result = await pending
  assert.deepEqual(result, { name: 'A', description: 'd', prompt: 'p', parsed: true })
  assert.equal(rig.emitter.listeners.filter((l) => l.name === 'session/event' && !l.removed).length, 0, 'listener removed on success')
})

test('a turn that ends before flush resolves still completes the draft', async () => {
  // The rig's default agent emits turn/end synchronously inside followup —
  // BEFORE the awaited flush settles. The listener must already be attached.
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  const result = await runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: 'b' })
  assert.deepEqual(result, { name: 'A', description: 'd', prompt: 'p', parsed: true })
  assert.equal(rig.sessions.flushes.length, 1)
  assert.equal(rig.sessions.flushes[0], rig.draftAgent.session)
})

test('unparseable assistant text returns the raw text with parsed false', async () => {
  const rig = makeRig({ assistantText: 'The user wants a reviewer, so write: be strict.' })
  const result = await runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: 'b' })
  assert.deepEqual(result, { name: '', description: '', prompt: 'The user wants a reviewer, so write: be strict.', parsed: false })
})

test('nothing is saved: no template ever enters the store', async () => {
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  await runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: 'b' })
  assert.deepEqual(await rig.store.all(), [], 'drafts are proposals only (ADR-0010)')
})

test('distinct workspaces get distinct draft sessions', async () => {
  const rigA = makeRig({ cwd: '/a', assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  const rigB = makeRig({ cwd: '/b', assistantText: '{"name":"B","description":"d","prompt":"p"}' })
  await runDraft(rigA.scope, { store: rigA.store }, { sessionId: 's-req', brief: 'b' })
  await runDraft(rigB.scope, { store: rigB.store }, { sessionId: 's-req', brief: 'b' })
  const idA = (await rigA.store.draftSessionFor('/a')).sessionId
  const idB = (await rigB.store.draftSessionFor('/b')).sessionId
  assert.notEqual(idA, idB)
})

// ---------------------------------------------------------------------------
// runDraft — model selection
// ---------------------------------------------------------------------------

test('an explicit model selects it on the draft session; null and omission do not', async () => {
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  await runDraft(rig.scope, { store: rig.store }, {
    sessionId: 's-req', brief: 'b', model: { provider: 'cheap', model: 'm1', reasoningEffort: 'low' },
  })
  assert.deepEqual(rig.controller.selections, [{
    sessionId: rig.controller.created[0].sessionId, provider: 'cheap', model: 'm1', reasoningEffort: 'low',
  }])

  const rig2 = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  await runDraft(rig2.scope, { store: rig2.store }, { sessionId: 's-req', brief: 'b', model: { provider: 'p', model: 'm' } })
  assert.deepEqual(rig2.controller.selections, [{ sessionId: rig2.controller.created[0].sessionId, provider: 'p', model: 'm' }])

  const rig3 = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  await runDraft(rig3.scope, { store: rig3.store }, { sessionId: 's-req', brief: 'b', model: null })
  assert.equal(rig3.controller.selections.length, 0, 'explicit null keeps the session own selection')
})

test('a malformed model rejects with roster/bad-request before any delivery', async () => {
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  await assert.rejects(
    () => runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: 'b', model: { provider: 'p' } }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request' && Array.isArray(remoteErrorOf(error).details.issues),
  )
  assert.equal(rig.draftAgent.followups.length, 0)
})

// ---------------------------------------------------------------------------
// runDraft — failures
// ---------------------------------------------------------------------------

test('times out with roster/draft-timeout and unsubscribes', async () => {
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  // Replace the agent's auto-turn-end with silence: the turn never ends.
  rig.draftAgent.followup = (message) => { rig.draftAgent.followups.push(message) }
  await assert.rejects(
    () => runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: 'b' }, 20),
    (error) => remoteErrorOf(error)?.code === 'roster/draft-timeout',
  )
  const live = rig.emitter.listeners.filter((l) => l.name === 'session/event' && !l.removed)
  assert.equal(live.length, 0, 'listener removed on timeout')
})

test('flush rejection surfaces a roster error and unsubscribes', async () => {
  const rig = makeRig({
    assistantText: '{"name":"A","description":"d","prompt":"p"}',
    flush: { error: new Error('disk on fire') },
  })
  await assert.rejects(
    () => runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: 'b' }),
    (error) => remoteErrorOf(error)?.code === 'roster/draft-flush-failed',
  )
  assert.equal(rig.emitter.listeners.filter((l) => l.name === 'session/event' && !l.removed).length, 0)
})

test('a flush that no durability listener acknowledges surfaces a roster error', async () => {
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}', flush: { result: false } })
  await assert.rejects(
    () => runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: 'b' }),
    (error) => remoteErrorOf(error)?.code === 'roster/draft-flush-failed',
  )
  assert.equal(rig.emitter.listeners.filter((l) => l.name === 'session/event' && !l.removed).length, 0)
})

test('a resolveAgent error on the requesting session rethrows as-is', async () => {
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  const failure = new RemoteError('session/agent-busy', 'session is busy')
  const controller = { async resolveAgent() { return { error: failure } } }
  await assert.rejects(
    () => runDraft(strictScope({ sessionController: controller, sessions: rig.sessions }, rig.emitter), { store: rig.store }, { sessionId: 's-busy', brief: 'b' }),
    (error) => error === failure,
  )
})

test('a resolveAgent error on the draft session rethrows as-is', async () => {
  const emitter = fakeEmitter()
  const store = makeStore()
  // Pre-seed a pointer whose session no longer resolves.
  await store.putDraftSession({ cwd: '/w', sessionId: 's-gone', createdAt: T0 })
  const requesting = fakeAgent({ id: 's-req', session: fakeSession({ id: 's-req', cwd: '/w' }) })
  const failure = new RemoteError('session/not-found', 'gone')
  const controller = fakeSessionController({ agents: { 's-req': requesting }, resolveErrors: { 's-gone': failure } })
  await assert.rejects(
    () => runDraft(strictScope({ sessionController: controller, sessions: fakeSessions() }, emitter), { store }, { sessionId: 's-req', brief: 'b' }),
    (error) => error === failure,
  )
})

test('a requesting session without a working directory rejects with roster/bad-request', async () => {
  const emitter = fakeEmitter()
  const requesting = fakeAgent({ id: 's-req', session: fakeSession({ id: 's-req', cwd: undefined }) })
  const controller = fakeSessionController({ agents: { 's-req': requesting } })
  await assert.rejects(
    () => runDraft(strictScope({ sessionController: controller, sessions: fakeSessions() }, emitter), { store: makeStore() }, { sessionId: 's-req', brief: 'b' }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
})

test('missing required services reject typed; a missing sessionTitle only skips naming', async () => {
  const input = { sessionId: 's-req', brief: 'b' }
  // No sessionController on scope or bag.
  await assert.rejects(
    () => runDraft(strictScope({}, fakeEmitter()), { store: makeStore() }, input),
    (error) => remoteErrorOf(error)?.code === 'roster/no-session-controller',
  )
  // sessionController present, sessions absent.
  const emitter = fakeEmitter()
  const requesting = fakeAgent({ id: 's-req', session: fakeSession({ id: 's-req', cwd: '/w' }) })
  const controller = fakeSessionController({ agents: { 's-req': requesting } })
  await assert.rejects(
    () => runDraft(strictScope({ sessionController: controller }, emitter), { store: makeStore() }, input),
    (error) => remoteErrorOf(error)?.code === 'roster/no-sessions',
  )
  // sessionTitle absent: the draft still runs, no rename, no error.
  const rigNoTitle = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  const result = await runDraft(
    strictScope({ sessionController: rigNoTitle.controller, sessions: rigNoTitle.sessions }, rigNoTitle.emitter),
    { store: rigNoTitle.store },
    input,
  )
  assert.deepEqual(result, { name: 'A', description: 'd', prompt: 'p', parsed: true })
  assert.equal(rigNoTitle.draftAgent.followups.length, 1, 'draft still delivered')
})

test('empty sessionId or brief rejects with roster/bad-request', async () => {
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  await assert.rejects(
    () => runDraft(rig.scope, { store: rig.store }, { sessionId: '', brief: 'b' }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
  await assert.rejects(
    () => runDraft(rig.scope, { store: rig.store }, { sessionId: 's-req', brief: '' }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
  assert.equal(rig.draftAgent.followups.length, 0)
})

// ---------------------------------------------------------------------------
// Remote surface
// ---------------------------------------------------------------------------

test('service draft resolves services from its ctx scope', async () => {
  const rig = makeRig({ assistantText: '{"name":"A","description":"d","prompt":"p"}' })
  const service = Object.create(AgentRosterService.prototype)
  service.store = rig.store
  service.ctx = rig.scope
  const result = await service.draft({ sessionId: 's-req', brief: 'Draft me a reviewer' })
  assert.deepEqual(result, { name: 'A', description: 'd', prompt: 'p', parsed: true })
})

test('AgentRosterService carries a direct Remote marker for draft', () => {
  const markers = remoteMethods(Object.create(AgentRosterService.prototype))
  const draft = markers.find((m) => m.method === 'draft')
  assert.ok(draft !== undefined, 'draft method is marked')
  assert.deepEqual(draft.invocation, { kind: 'direct' }, 'direct invocation')
  assert.equal(draft.mode, undefined, 'unary method')
})
