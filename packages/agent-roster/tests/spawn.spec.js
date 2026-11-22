/**
 * Task 3 tests: member spawn through the subagent runtime and team status.
 *
 * Fakes mirror the real strictness verified in the dsh checkout
 * (/home/ramuz/deepseek-harness, AGENTS.md 2b: source is the source of truth):
 *
 * - `startActivation` fake mirrors SubagentRuntime.startActivation
 *   (packages/subagent/subagent/src/index.ts:267-292): requires a registered
 *   provider name, the EXACT live parent agent, a text ContentBlock[] prompt,
 *   an AbortSignal, and a 'parent'|'caller' delivery; it also reserves the
 *   requested name like the real sibling-name reservation
 *   (packages/subagent/subagent/src/names.ts SiblingNameReservations.reserve:
 *   1–32 lower-case letters/digits/hyphens starting with a letter, other than
 *   `lead`, unique among the creator's children — duplicate → error).
 * - `resolveAgent` fake returns `{ agent } | { error }`, the real result shape
 *   (packages/api/session-controller/src/agent.ts:90-92).
 * - `rootOf` fake throws for an unknown caller, mirroring "when the caller or
 *   its runtime owner is unavailable" (subagent src/index.ts:296-302).
 * - `isEnabled(caller)` takes the caller Agent and internally roots —
 *   packages/team/agent-team/src/index.ts:94-97.
 * - Strict scopes expose ONLY the sanctioned get() name lookup; every other
 *   property access throws like a non-injected cordis service
 *   (host.spec.js makeFakeHost pattern).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteError, remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { slugify, allocateName, assembleSpawnPrompt, spawnFromRoster, teamStatusOf } from '../lib/spawn.js'
import { openRosterStore, RoleTemplate } from '../lib/store.js'
import { AgentRosterService } from '../lib/roster-service.js'

/** Fixed timestamp for hand-built records. */
const T0 = '2026-11-22T12:00:00.000Z'

/** The in-process provider's default registry name (spawn-in-process Config). */
const SPAWN = 'spawn'

/** The root agent's reserved name (subagent src/names.ts ROOT_AGENT_NAME). */
const LEAD = 'lead'

/** Name grammar the runtime enforces (names.ts NAME_PATTERN + ROOT_AGENT_NAME). */
const isValidChildName = (value) => /^[a-z][a-z0-9-]{0,31}$/u.test(value) && value !== LEAD

/**
 * A scope whose ONLY member is the sanctioned get() lookup; any other property
 * access throws exactly like a non-injected service in cordis.
 */
function strictScope(services = {}) {
  const framework = { get: (name) => services[name] }
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
async function makeStore(...templates) {
  const store = openRosterStore({ get: () => undefined })
  for (const t of templates) await store.put(RoleTemplate.parse(t))
  return store
}

/**
 * Fake subagents runtime. `children` mirrors listDescendants rows
 * (SubagentDescendantListEntry: kind/id/activity/parentId/depth/path —
 * control-types.ts:42-47 + list-children.ts:17-24); depth-1 `path`s are the
 * root's direct-child names. `startActivation` records every spec and applies
 * the real admission strictness (see file header).
 */
function fakeSubagents({ root, known = [root], children = [], activations = [] }) {
  return {
    activations,
    rootOf(caller) {
      if (!known.includes(caller)) throw new Error(`rootOf: unknown caller ${String(caller?.id)}`)
      return root
    },
    async listDescendants(rootSessionId) {
      if (rootSessionId !== root.id) throw new Error('listDescendants: not the root session')
      return children
    },
    async startActivation(spec) {
      // Mirror the real admission checks before recording success.
      if (spec.provider !== SPAWN) throw new Error(`unknown provider ${String(spec.provider)}`)
      if (spec.parent !== root) {
        throw new Error('UNAUTHORIZED: subagent creation requires the exact live parent agent')
      }
      if (!(spec.signal instanceof AbortSignal)) throw new Error('signal is required')
      if (spec.delivery !== 'parent' && spec.delivery !== 'caller') throw new Error('bad delivery')
      if (!Array.isArray(spec.prompt) || spec.prompt.some((block) => block?.type !== 'text' || typeof block.text !== 'string')) {
        throw new Error('prompt must be an array of text ContentBlocks')
      }
      if (typeof spec.label !== 'string' || spec.label === '') throw new Error('label is required')
      if (spec.name !== undefined && !isValidChildName(spec.name)) throw new Error('INVALID_AGENT_NAME')
      const taken = children.filter((e) => e.depth === 1 && typeof e.path === 'string').map((e) => e.path)
      if (spec.name !== undefined && taken.includes(spec.name)) throw new Error('DUPLICATE_AGENT_NAME')
      activations.push(spec)
      return {
        childId: `cs-${activations.length}`,
        name: spec.name,
        messageId: `m-${activations.length}`,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
}

/** Fake sessionController mirroring resolveAgent's `{agent}|{error}` result. */
function fakeSessionController(agents) {
  return {
    async resolveAgent(sessionId) {
      const agent = agents[sessionId]
      return agent === undefined
        ? { error: new RemoteError('session/not-found', `session ${sessionId} not found`) }
        : { agent }
    },
  }
}

/** Fake agentTeams: isEnabled(caller) takes the caller, roots internally. */
function fakeAgentTeams(enabled) {
  const calls = []
  return {
    calls,
    isEnabled(caller) { calls.push(caller); return enabled },
  }
}

/** One depth-1 descendant row (listDescendants entry shape). */
const child1 = (path, id = `c-${path}`) => ({ kind: 'child', id, activity: 'inactive', parentId: 'root-1', depth: 1, path })

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('slugify lowercases, hyphenates, trims to 32, and requires a leading letter', () => {
  assert.equal(slugify('Reviewer'), 'reviewer')
  assert.equal(slugify('Code Reviewer!!'), 'code-reviewer')
  assert.equal(slugify('  Mixed   Case  '), 'mixed-case')
  assert.equal(slugify('Build 42'), 'build-42')
  assert.equal(slugify('a'.repeat(40)), 'a'.repeat(32), 'truncated to 32')
  assert.equal(slugify('a'.repeat(31) + '-'), 'a'.repeat(31), 'no trailing hyphen after truncation')
  // Leading digit is invalid (must start with a letter) → member.
  assert.equal(slugify('7zip audit'), 'member')
  // Empty / fully non-alphanumeric → member.
  assert.equal(slugify(''), 'member')
  assert.equal(slugify('___'), 'member')
  assert.equal(slugify(undefined), 'member')
  // slugify itself does NOT reserve lead — that is allocateName's contract.
  assert.equal(slugify('Lead'), LEAD)
})

test('allocateName returns base then suffixed variants against taken names', () => {
  assert.equal(allocateName('reviewer', []), 'reviewer')
  assert.equal(allocateName('reviewer', ['reviewer']), 'reviewer-2')
  assert.equal(allocateName('reviewer', ['reviewer', 'reviewer-2']), 'reviewer-3')
  assert.equal(allocateName('Lead', []), 'lead-member', 'lead is reserved for the root')
  assert.equal(allocateName('Lead', ['lead-member']), 'lead-member-2')
  assert.equal(allocateName('', []), 'member', 'invalid base falls back to member')
  assert.equal(allocateName(undefined, ['member']), 'member-2')
  // Suffixed variants stay inside the runtime's 1–32 name grammar even when
  // the base fills it (names.ts NAME_PATTERN).
  const full = 'a'.repeat(32)
  const fitted = allocateName(full, [full])
  assert.equal(fitted, `${'a'.repeat(30)}-2`, 'base truncated so base+suffix fills exactly 32')
  assert.ok(fitted.length <= 32)
  assert.ok(isValidChildName(fitted), 'fitted variant satisfies the runtime grammar')
})

test('assembleSpawnPrompt matches the exact string contract', () => {
  assert.equal(assembleSpawnPrompt('Standing instructions.'), 'Standing instructions.')
  assert.equal(assembleSpawnPrompt('Standing instructions.', undefined), 'Standing instructions.')
  assert.equal(assembleSpawnPrompt('Standing instructions.', ''), 'Standing instructions.', 'empty task is omitted')
  assert.equal(
    assembleSpawnPrompt('Standing instructions.', 'Check PR 9'),
    'Standing instructions.\n\n---\n\nInitial task (assigned by the user at spawn time):\nCheck PR 9',
  )
})

// ---------------------------------------------------------------------------
// spawnFromRoster
// ---------------------------------------------------------------------------

const ROOT = { id: 'root-1' }
const MEMBER = { id: 'member-9' }

test('happy path: template spawn parents at the tree root with exact activation args', async () => {
  const store = await makeStore({ id: 't1', name: 'Reviewer', prompt: 'You review diffs.', createdAt: T0, updatedAt: T0 })
  const subagents = fakeSubagents({ root: ROOT, known: [ROOT, MEMBER] })
  // The session resolves to a NON-root member: the parent must still be the root.
  const sessionController = fakeSessionController({ 's-member': MEMBER })
  const result = await spawnFromRoster(
    strictScope({ sessionController, subagents }),
    { store },
    { sessionId: 's-member', templateId: 't1' },
  )
  assert.equal(subagents.activations.length, 1)
  const spec = subagents.activations[0]
  assert.equal(spec.provider, SPAWN)
  assert.equal(spec.parent, ROOT, 'parent is the resolved tree root, not the calling member')
  assert.equal(spec.label, 'Reviewer')
  assert.equal(spec.name, 'reviewer')
  assert.equal(spec.delivery, 'parent')
  assert.ok(spec.signal instanceof AbortSignal)
  assert.equal(spec.signal.aborted, false)
  assert.deepEqual(spec.prompt, [{ type: 'text', text: 'You review diffs.' }])
  assert.equal('agentOptions' in spec, false, 'no agentOptions key when no model chosen')
  assert.deepEqual(result, { name: 'reviewer', childSessionId: 'cs-1' })
})

test('an initial task rides the prompt through the exact separator contract', async () => {
  const store = await makeStore({ id: 't1', name: 'Reviewer', prompt: 'You review diffs.', createdAt: T0, updatedAt: T0 })
  const subagents = fakeSubagents({ root: ROOT })
  await spawnFromRoster(
    strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents }),
    { store },
    { sessionId: 's-root', templateId: 't1', task: 'Check PR 9' },
  )
  assert.deepEqual(subagents.activations[0].prompt, [{
    type: 'text',
    text: 'You review diffs.\n\n---\n\nInitial task (assigned by the user at spawn time):\nCheck PR 9',
  }])
})

test('memberName overrides the name base, slugified', async () => {
  const store = await makeStore({ id: 't1', name: 'Reviewer', prompt: 'p', createdAt: T0, updatedAt: T0 })
  const subagents = fakeSubagents({ root: ROOT })
  await spawnFromRoster(
    strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents }),
    { store },
    { sessionId: 's-root', templateId: 't1', memberName: 'Q.A. Lead' },
  )
  assert.equal(subagents.activations[0].name, 'q-a-lead')
  assert.equal(subagents.activations[0].label, 'Reviewer', 'label stays the display name')
})

test('name suffixes past taken sibling names; deeper descendants do not block', async () => {
  const store = await makeStore({ id: 't1', name: 'Reviewer', prompt: 'p', createdAt: T0, updatedAt: T0 })
  const children = [
    child1('reviewer'),
    child1('reviewer-2'),
    // A depth-2 descendant named 'sub' under 'other' — different sibling set.
    { kind: 'child', id: 'c-sub', activity: 'inactive', parentId: 'c-other', depth: 2, path: 'other/sub' },
  ]
  const subagents = fakeSubagents({ root: ROOT, children })
  await spawnFromRoster(
    strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents }),
    { store },
    { sessionId: 's-root', templateId: 't1' },
  )
  assert.equal(subagents.activations[0].name, 'reviewer-3')

  // And a base colliding only with the depth-2 row stays unsuffixed.
  const store2 = await makeStore({ id: 't2', name: 'Sub', prompt: 'p', createdAt: T0, updatedAt: T0 })
  const subagents2 = fakeSubagents({ root: ROOT, children })
  await spawnFromRoster(
    strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents: subagents2 }),
    { store: store2 },
    { sessionId: 's-root', templateId: 't2' },
  )
  assert.equal(subagents2.activations[0].name, 'sub')
})

test('a base that slugs to lead becomes lead-member', async () => {
  const store = await makeStore({ id: 't1', name: 'Lead', prompt: 'p', createdAt: T0, updatedAt: T0 })
  const subagents = fakeSubagents({ root: ROOT })
  await spawnFromRoster(
    strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents }),
    { store },
    { sessionId: 's-root', templateId: 't1' },
  )
  assert.equal(subagents.activations[0].name, 'lead-member')
})

test('template defaultModel becomes agentOptions; explicit input overrides it', async () => {
  const store = await makeStore(
    { id: 't1', name: 'Reviewer', prompt: 'p', createdAt: T0, updatedAt: T0, defaultModel: { provider: 'p1', model: 'm1' } },
    { id: 't2', name: 'Planner', prompt: 'p', createdAt: T0, updatedAt: T0, defaultModel: { provider: 'p2', model: 'm2', reasoningEffort: 'high' } },
  )
  const sc = fakeSessionController({ 's-root': ROOT })

  // Template default without reasoningEffort: exactly { provider, model }.
  const sa1 = fakeSubagents({ root: ROOT })
  await spawnFromRoster(strictScope({ sessionController: sc, subagents: sa1 }), { store }, { sessionId: 's-root', templateId: 't1' })
  assert.deepEqual(sa1.activations[0].agentOptions, { provider: 'p1', model: 'm1' })
  assert.equal('reasoningEffort' in sa1.activations[0].agentOptions, false)

  // Template default carrying reasoningEffort.
  const sa2 = fakeSubagents({ root: ROOT })
  await spawnFromRoster(strictScope({ sessionController: sc, subagents: sa2 }), { store }, { sessionId: 's-root', templateId: 't2' })
  assert.deepEqual(sa2.activations[0].agentOptions, { provider: 'p2', model: 'm2', reasoningEffort: 'high' })

  // Explicit input model wins over the template default.
  const sa3 = fakeSubagents({ root: ROOT })
  await spawnFromRoster(
    strictScope({ sessionController: sc, subagents: sa3 }),
    { store },
    { sessionId: 's-root', templateId: 't2', model: { provider: 'p3', model: 'm3' } },
  )
  assert.deepEqual(sa3.activations[0].agentOptions, { provider: 'p3', model: 'm3' })

  // Explicit null clears the template default: no agentOptions key at all.
  const sa4 = fakeSubagents({ root: ROOT })
  await spawnFromRoster(
    strictScope({ sessionController: sc, subagents: sa4 }),
    { store },
    { sessionId: 's-root', templateId: 't2', model: null },
  )
  assert.equal('agentOptions' in sa4.activations[0], false)
})

test('custom member spawns without a template', async () => {
  const store = await makeStore()
  const subagents = fakeSubagents({ root: ROOT })
  const result = await spawnFromRoster(
    strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents }),
    { store },
    { sessionId: 's-root', custom: { name: 'Auditor', description: 'audits things', prompt: 'Audit everything.' } },
  )
  const spec = subagents.activations[0]
  assert.equal(spec.label, 'Auditor')
  assert.equal(spec.name, 'auditor')
  assert.deepEqual(spec.prompt, [{ type: 'text', text: 'Audit everything.' }])
  assert.deepEqual(result, { name: 'auditor', childSessionId: 'cs-1' })
})

test('templateId and custom are xor: both or neither reject with roster/bad-request', async () => {
  const store = await makeStore({ id: 't1', name: 'R', prompt: 'p', createdAt: T0, updatedAt: T0 })
  const scope = strictScope({
    sessionController: fakeSessionController({ 's-root': ROOT }),
    subagents: fakeSubagents({ root: ROOT }),
  })
  await assert.rejects(
    () => spawnFromRoster(scope, { store }, { sessionId: 's-root', templateId: 't1', custom: { name: 'A', prompt: 'p' } }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
  await assert.rejects(
    () => spawnFromRoster(scope, { store }, { sessionId: 's-root' }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
  // Incomplete custom members are bad requests too.
  await assert.rejects(
    () => spawnFromRoster(scope, { store }, { sessionId: 's-root', custom: { name: '', prompt: 'p' } }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
  await assert.rejects(
    () => spawnFromRoster(scope, { store }, { sessionId: 's-root', custom: { name: 'A', prompt: '' } }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
  await assert.rejects(
    () => spawnFromRoster(scope, { store }, { sessionId: '' , templateId: 't1' }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
})

test('unknown templateId rejects with roster/not-found', async () => {
  const store = await makeStore()
  await assert.rejects(
    () => spawnFromRoster(
      strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents: fakeSubagents({ root: ROOT }) }),
      { store },
      { sessionId: 's-root', templateId: 'nope' },
    ),
    (error) => remoteErrorOf(error)?.code === 'roster/not-found',
  )
})

test('a malformed model rejects with roster/bad-request and zod issues', async () => {
  const store = await makeStore({ id: 't1', name: 'R', prompt: 'p', createdAt: T0, updatedAt: T0 })
  await assert.rejects(
    () => spawnFromRoster(
      strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents: fakeSubagents({ root: ROOT }) }),
      { store },
      { sessionId: 's-root', templateId: 't1', model: { provider: 'p' } },
    ),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request' && Array.isArray(remoteErrorOf(error).details.issues),
  )
})

test('missing optional services reject typed: roster/no-session-controller, roster/no-subagents', async () => {
  const store = await makeStore({ id: 't1', name: 'R', prompt: 'p', createdAt: T0, updatedAt: T0 })
  const input = { sessionId: 's-root', templateId: 't1' }
  // Nothing on the scope, nothing in the bag.
  await assert.rejects(
    () => spawnFromRoster(strictScope(), { store }, input),
    (error) => remoteErrorOf(error)?.code === 'roster/no-session-controller',
  )
  await assert.rejects(
    () => spawnFromRoster(strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }) }), { store }, input),
    (error) => remoteErrorOf(error)?.code === 'roster/no-subagents',
  )
  // Deps-bag members satisfy the service without any scope lookup.
  const subagents = fakeSubagents({ root: ROOT })
  const result = await spawnFromRoster(
    strictScope(),
    { store, sessionController: fakeSessionController({ 's-root': ROOT }), subagents },
    input,
  )
  assert.equal(result.name, 'r')
})

test('a resolveAgent error rethrows the typed session error as-is', async () => {
  const store = await makeStore({ id: 't1', name: 'R', prompt: 'p', createdAt: T0, updatedAt: T0 })
  const failure = new RemoteError('session/agent-busy', 'session is busy')
  await assert.rejects(
    () => spawnFromRoster(
      strictScope({ sessionController: { async resolveAgent() { return { error: failure } } }, subagents: fakeSubagents({ root: ROOT }) }),
      { store },
      { sessionId: 's-busy', templateId: 't1' },
    ),
    (error) => error === failure,
  )
})

// ---------------------------------------------------------------------------
// teamStatusOf
// ---------------------------------------------------------------------------

test('teamStatus reports the root/non-root × enabled/disabled matrix', async () => {
  const sc = fakeSessionController({ 's-root': ROOT, 's-member': MEMBER })
  const subagents = fakeSubagents({ root: ROOT, known: [ROOT, MEMBER] })

  const rootEnabled = fakeAgentTeams(true)
  assert.deepEqual(
    await teamStatusOf(strictScope({ sessionController: sc, subagents, agentTeams: rootEnabled }), {}, { sessionId: 's-root' }),
    { teamMode: true, isRoot: true, canEnable: true },
  )
  assert.equal(rootEnabled.calls[0], ROOT, 'isEnabled receives the resolved caller agent')

  assert.deepEqual(
    await teamStatusOf(strictScope({ sessionController: sc, subagents, agentTeams: fakeAgentTeams(false) }), {}, { sessionId: 's-root' }),
    { teamMode: false, isRoot: true, canEnable: true },
  )
  // A non-root member shares the root's team mode but can never enable it.
  assert.deepEqual(
    await teamStatusOf(strictScope({ sessionController: sc, subagents, agentTeams: fakeAgentTeams(true) }), {}, { sessionId: 's-member' }),
    { teamMode: true, isRoot: false, canEnable: false },
  )
  assert.deepEqual(
    await teamStatusOf(strictScope({ sessionController: sc, subagents, agentTeams: fakeAgentTeams(false) }), {}, { sessionId: 's-member' }),
    { teamMode: false, isRoot: false, canEnable: false },
  )
})

test('teamStatus without agentTeams: teamMode false, canEnable false, no error', async () => {
  assert.deepEqual(
    await teamStatusOf(
      strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents: fakeSubagents({ root: ROOT }) }),
      {},
      { sessionId: 's-root' },
    ),
    { teamMode: false, isRoot: true, canEnable: false },
  )
})

test('teamStatus rejects typed when sessionController or subagents are absent', async () => {
  await assert.rejects(
    () => teamStatusOf(strictScope(), {}, { sessionId: 's-root' }),
    (error) => remoteErrorOf(error)?.code === 'roster/no-session-controller',
  )
  await assert.rejects(
    () => teamStatusOf(strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }) }), {}, { sessionId: 's-root' }),
    (error) => remoteErrorOf(error)?.code === 'roster/no-subagents',
  )
  await assert.rejects(
    () => teamStatusOf(
      strictScope({ sessionController: fakeSessionController({ 's-root': ROOT }), subagents: fakeSubagents({ root: ROOT }) }),
      {},
      { sessionId: '' },
    ),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
})

// ---------------------------------------------------------------------------
// Remote surface
// ---------------------------------------------------------------------------

test('service spawnMember/teamStatus resolve services from their ctx scope', async () => {
  const store = await makeStore({ id: 't1', name: 'Reviewer', prompt: 'You review diffs.', createdAt: T0, updatedAt: T0 })
  const subagents = fakeSubagents({ root: ROOT })
  const service = Object.create(AgentRosterService.prototype)
  service.store = store
  service.ctx = strictScope({
    sessionController: fakeSessionController({ 's-root': ROOT }),
    subagents,
    agentTeams: fakeAgentTeams(true),
  })
  const result = await service.spawnMember({ sessionId: 's-root', templateId: 't1' })
  assert.deepEqual(result, { name: 'reviewer', childSessionId: 'cs-1' })
  assert.deepEqual(await service.teamStatus({ sessionId: 's-root' }), { teamMode: true, isRoot: true, canEnable: true })
})

test('AgentRosterService carries Remote markers for all five methods', () => {
  const markers = remoteMethods(Object.create(AgentRosterService.prototype))
  assert.deepEqual(
    markers.map((m) => m.method).sort(),
    // Task 4 added draft; drafter.spec pins its own marker details.
    ['deleteTemplate', 'draft', 'listTemplates', 'saveTemplate', 'spawnMember', 'teamStatus'],
  )
  for (const marker of markers) {
    assert.deepEqual(marker.invocation, { kind: 'direct' }, `${marker.method} is a direct invocation`)
    assert.equal(marker.mode, undefined, 'unary method')
  }
})
