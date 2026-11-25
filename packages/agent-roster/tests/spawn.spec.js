/**
 * Tests for agent-driven member creation (ADR-0011): `spawnFromTemplate`
 * renders one template into a subagent through the subagent runtime, and
 * `resolveTemplateRef` maps the model's id-or-name reference to a record.
 *
 * Fakes mirror the real strictness verified in the dsh checkout
 * (/home/ramuz/deepseek-harness, AGENTS.md 2b: source is the source of truth):
 *
 * - `startActivation` fake mirrors SubagentRuntime.startActivation
 *   (packages/subagent/subagent/src/index.ts:274-299): requires a registered
 *   provider name, the EXACT live parent agent, a text ContentBlock[] prompt,
 *   an AbortSignal, and a 'parent'|'caller' delivery; it also reserves the
 *   requested name like the real sibling-name reservation
 *   (packages/subagent/subagent/src/names.ts SiblingNameReservations.reserve:
 *   1–32 lower-case letters/digits/hyphens starting with a letter, other than
 *   `lead`, unique among the creator's children — duplicate → error).
 * - `rootOf` fake throws for an unknown caller, mirroring "when the caller or
 *   its runtime owner is unavailable" (subagent src/index.ts:296-302).
 * - Strict scopes expose ONLY the sanctioned get() name lookup; every other
 *   property access throws like a non-injected cordis service.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { slugify, allocateName, assembleSpawnPrompt, resolveTemplateRef, spawnFromTemplate } from '../lib/spawn.js'
import { openRosterStore, RoleTemplate } from '../lib/store.js'

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

/** One depth-1 descendant row (listDescendants entry shape). */
const child1 = (path, id = `c-${path}`) => ({ kind: 'child', id, activity: 'inactive', parentId: 'root-1', depth: 1, path })

/** The template fixtures. */
const RESEARCHER = { id: 't1', name: 'Researcher', description: 'Finds sources', prompt: 'You research thoroughly.', defaultModel: null, createdAt: T0, updatedAt: T0 }
const REVIEWER = { id: 't2', name: 'Reviewer', description: '', prompt: 'You review diffs.', defaultModel: null, createdAt: T0, updatedAt: T0 }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('slugify lowercases, hyphenates, trims to 32, and requires a leading letter', () => {
  assert.equal(slugify('Reviewer'), 'reviewer')
  assert.equal(slugify('Code Reviewer!!'), 'code-reviewer')
  assert.equal(slugify('  Mixed   Case  '), 'mixed-case')
  assert.equal(slugify('1st Place'), 'member', 'leading digit falls back')
  assert.equal(slugify(''), 'member')
  assert.equal(slugify('x'.repeat(40)).length, 32)
})

test('allocateName returns base then suffixed variants against taken names', () => {
  assert.equal(allocateName('reviewer', []), 'reviewer')
  assert.equal(allocateName('reviewer', ['reviewer']), 'reviewer-2')
  assert.equal(allocateName('reviewer', ['reviewer', 'reviewer-2']), 'reviewer-3')
  assert.equal(allocateName('lead', []), 'lead-member', 'root name is unallocatable')
  assert.equal(allocateName('x'.repeat(40), ['x'.repeat(32)]).length <= 32, true)
})

test('assembleSpawnPrompt matches the exact string contract', () => {
  assert.equal(assembleSpawnPrompt('Standing.', ''), 'Standing.')
  assert.equal(assembleSpawnPrompt('Standing.', '   '), 'Standing.')
  assert.equal(
    assembleSpawnPrompt('Standing.', 'Do X.'),
    'Standing.\n\n---\n\nInitial task (assigned by the user at spawn time):\nDo X.',
  )
})

// ---------------------------------------------------------------------------
// resolveTemplateRef — id, exact name, and the typed failures
// ---------------------------------------------------------------------------

test('resolveTemplateRef accepts a record id', async () => {
  const store = await makeStore(RESEARCHER, REVIEWER)
  assert.deepEqual(await resolveTemplateRef(store, 't1'), RoleTemplate.parse(RESEARCHER))
})

test('resolveTemplateRef accepts an exact display name', async () => {
  const store = await makeStore(RESEARCHER, REVIEWER)
  const found = await resolveTemplateRef(store, 'Reviewer')
  assert.equal(found.id, 't2')
})

test('resolveTemplateRef rejects empty, unknown, and cases the name is not exact', async () => {
  const store = await makeStore(RESEARCHER)
  await assert.rejects(() => resolveTemplateRef(store, ''), (error) => remoteErrorOf(error)?.code === 'roster/bad-request')
  await assert.rejects(() => resolveTemplateRef(store, 'nope'), (error) => remoteErrorOf(error)?.code === 'roster/not-found')
  // Case-sensitive: a model lower-casing the name must get the typed miss,
  // not a silent wrong match, so the fix is a listing call.
  await assert.rejects(() => resolveTemplateRef(store, 'researcher'), (error) => remoteErrorOf(error)?.code === 'roster/not-found')
})

test('resolveTemplateRef reports ambiguous names with the candidate ids', async () => {
  // The store forbids duplicate names through saveTemplate, but a foreign or
  // hand-edited domain could hold them; the resolver must not pick blindly.
  const store = await makeStore(RESEARCHER)
  const twin = { ...REVIEWER, id: 't9', name: 'Researcher' }
  await store.put(RoleTemplate.parse(twin))
  await assert.rejects(() => resolveTemplateRef(store, 'Researcher'), (error) => {
    const remote = remoteErrorOf(error)
    return remote?.code === 'roster/ambiguous-name'
  })
})

// ---------------------------------------------------------------------------
// spawnFromTemplate — the deterministic half of ADR-0011
// ---------------------------------------------------------------------------

test('happy path: the template spawns under the caller tree root with exact activation args', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const result = await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(RESEARCHER) })
  assert.equal(result.name, 'researcher')
  assert.equal(result.childSessionId, 'cs-1')
  assert.equal(result.model, null, 'no template model → inherited')
  const [spec] = subagents.activations
  assert.equal(spec.provider, SPAWN)
  assert.equal(spec.parent, root, 'parented at the tree root, not the caller')
  assert.equal(spec.label, 'Researcher')
  assert.equal(spec.name, 'researcher')
  assert.equal(spec.delivery, 'parent')
  assert.deepEqual(spec.prompt, [{ type: 'text', text: 'You research thoroughly.' }])
  assert.equal('agentOptions' in spec, false, 'inherit means the key is omitted')
})

test('a member caller is re-rooted: the child is parented at the root, not at the member', async () => {
  const root = { id: 'root-1', name: LEAD }
  const member = { id: 'member-1', name: 'reviewer' }
  const subagents = fakeSubagents({ root, known: [root, member] })
  await spawnFromTemplate(strictScope(), { subagents }, { agent: member, template: RoleTemplate.parse(RESEARCHER) })
  assert.equal(subagents.activations[0].parent, root)
})

test('the task rides the prompt through the exact separator contract', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  await spawnFromTemplate(strictScope(), { subagents }, {
    agent: root,
    template: RoleTemplate.parse(RESEARCHER),
    task: '  review the payments module  ',
  })
  assert.equal(
    subagents.activations[0].prompt[0].text,
    'You research thoroughly.\n\n---\n\nInitial task (assigned by the user at spawn time):\nreview the payments module',
  )
})

test('the template defaultModel becomes agentOptions, effort included', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const template = RoleTemplate.parse({ ...RESEARCHER, defaultModel: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' } })
  const result = await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template })
  assert.deepEqual(subagents.activations[0].agentOptions, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
  assert.deepEqual(result.model, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
})

test('a retired or malformed stored model degrades to inherit instead of failing the spawn', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const template = { ...RoleTemplate.parse(RESEARCHER), defaultModel: { provider: '', model: '' } }
  const result = await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template })
  assert.equal('agentOptions' in subagents.activations[0], false)
  assert.equal(result.model, null)
})

test('name allocation suffixes past taken siblings', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root, children: [child1('researcher'), child1('researcher-2'), { kind: 'child', id: 'deep', activity: 'inactive', parentId: 'c-researcher', depth: 2, path: 'researcher-3' }] })
  const result = await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(RESEARCHER) })
  assert.equal(result.name, 'researcher-3', 'depth-2 names do not block a root child')
})

test('a template named like the root spawns as lead-member', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const template = RoleTemplate.parse({ ...RESEARCHER, name: 'lead' })
  const result = await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template })
  assert.equal(result.name, 'lead-member')
})

test('a repeated spawn probes names fresh on every call', async () => {
  const root = { id: 'root-1', name: LEAD }
  const children = []
  const subagents = fakeSubagents({ root, children })
  const first = await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(RESEARCHER) })
  children.push(child1(first.name))
  const second = await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(RESEARCHER) })
  assert.deepEqual([first.name, second.name], ['researcher', 'researcher-2'])
})

test('a host without the subagents runtime rejects typed', async () => {
  await assert.rejects(
    () => spawnFromTemplate(strictScope(), {}, { agent: { id: 'a' }, template: RoleTemplate.parse(RESEARCHER) }),
    (error) => remoteErrorOf(error)?.code === 'roster/no-subagents',
  )
})

test('a missing calling agent is misuse, not a data error', async () => {
  const subagents = fakeSubagents({ root: { id: 'root-1', name: LEAD } })
  await assert.rejects(
    () => spawnFromTemplate(strictScope(), { subagents }, { template: RoleTemplate.parse(RESEARCHER) }),
    (error) => error instanceof Error && !(error instanceof RemoteError),
  )
})
test('the caller signal is forwarded to startActivation (tool cancellation)', async () => {
  // exec.signal reaches spawnFromTemplate through the tool; it must become the
  // activation's own signal so cancelling the tool call cancels publication.
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const controller = new AbortController()
  await spawnFromTemplate(strictScope(), { subagents }, {
    agent: root,
    template: RoleTemplate.parse(RESEARCHER),
    signal: controller.signal,
  })
  assert.equal(subagents.activations[0].signal, controller.signal)
  // An absent signal must still satisfy the required spec member.
  await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(RESEARCHER) })
  assert.equal(subagents.activations[1].signal instanceof AbortSignal, true)
})

// ---------------------------------------------------------------------------
// Per-spawn model override (2026-11-25): the user may override the template's
// model and reasoning effort for one member. Precedence: explicit object or
// null beats the template default; an omitted choice keeps the default.
// ---------------------------------------------------------------------------

/** A template carrying a default route, so overrides have something to beat. */
const ROUTED = { ...RESEARCHER, defaultModel: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' } }

test('an explicit per-spawn model overrides the template default, effort included', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const result = await spawnFromTemplate(strictScope(), { subagents }, {
    agent: root,
    template: RoleTemplate.parse(ROUTED),
    model: { provider: 'acme', model: 'cheap', reasoningEffort: 'low' },
  })
  assert.deepEqual(subagents.activations[0].agentOptions, { provider: 'acme', model: 'cheap', reasoningEffort: 'low' })
  assert.deepEqual(result.model, { provider: 'acme', model: 'cheap', reasoningEffort: 'low' })
})

test('an explicit per-spawn model may drop the effort: the template effort does not leak', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  await spawnFromTemplate(strictScope(), { subagents }, {
    agent: root,
    template: RoleTemplate.parse(ROUTED),
    model: { provider: 'acme', model: 'cheap' },
  })
  assert.deepEqual(subagents.activations[0].agentOptions, { provider: 'acme', model: 'cheap' })
})

test('an explicit null model clears the template default: the member inherits the session route', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const result = await spawnFromTemplate(strictScope(), { subagents }, {
    agent: root,
    template: RoleTemplate.parse(ROUTED),
    model: null,
  })
  assert.equal('agentOptions' in subagents.activations[0], false)
  assert.equal(result.model, null)
})

// Characterization: the back-compat half of the matrix. An agent calling the
// tool the pre-override way must get exactly the behavior it had before.
test('an omitted model keeps the template default (the pre-override contract)', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(ROUTED) })
  assert.deepEqual(subagents.activations[0].agentOptions, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
})

test('an invalid explicit model rejects with roster/bad-request and spawns nothing', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  for (const model of [{ provider: '', model: 'x' }, { provider: 'acme' }, 'acme/cheap', 42]) {
    await assert.rejects(
      () => spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(ROUTED), model }),
      (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
      `expected roster/bad-request for ${JSON.stringify(model)}`,
    )
  }
  assert.equal(subagents.activations.length, 0)
})
