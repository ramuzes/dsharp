/**
 * Tests for agent-driven member creation (ADR-0011): `spawnFromTemplate`
 * renders one template into a subagent through the subagent runtime, and
 * `resolveTemplateRef` maps the model's id-or-name reference to a record.
 *
 * Fakes mirror the real strictness verified in the dsh source checkout
 * (AGENTS.md 2b: the source is the source of truth):
 *
 * - `startActivation` fake mirrors SubagentRuntime.startActivation
 *   (packages/subagent/subagent/src/index.ts:274-299): requires a registered
 *   provider name, the EXACT live parent agent, a text ContentBlock[] prompt,
 *   an AbortSignal, and a 'parent'|'caller' delivery; it also reserves the
 *   requested name like the real sibling-name reservation
 *   (packages/subagent/subagent/src/names.ts SiblingNameReservations.reserve:
 *   1–32 lower-case letters/digits/hyphens starting with a letter, other than
 *   `lead`, unique among the creator's children — duplicate → error).
 * - `sendMessage` fake mirrors SubagentManager.sendMessage (manager.ts:568):
 *   the exact live root as sender, a text ContentBlock[], and `options.signal`
 *   dereferenced first; it records the call and returns a message id.
 * - `rootOf` fake throws for an unknown caller, mirroring "when the caller or
 *   its runtime owner is unavailable" (subagent src/index.ts:296-302).
 * - Strict scopes expose ONLY the sanctioned get() name lookup; every other
 *   property access throws like a non-injected cordis service.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { slugify, allocateName, assembleMemberOpening, spawnDeliveryOf, resolveTemplateRef, spawnFromTemplate } from '../lib/spawn.js'
import { modelKeyOf, createMemberRegistry, assembleTaskMessage, findIdleMember } from '../lib/members.js'
import { openRosterStore, RoleTemplate } from '../lib/store.js'
import { TIERS, usableModel, sameModel, resolveMemberModel, requireReason } from '../lib/tiers.js'

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
function fakeSubagents({ root, known = [root], children = [], activations = [], messages = [], activityOf, childIdOf }) {
  // Default: a created member stands by (inactive) until something wakes it.
  const activity = activityOf ?? ((childId) => (children.some((entry) => entry.id === childId) ? 'inactive' : undefined))
  const idOf = childIdOf ?? ((ordinal) => `cs-${ordinal}`)
  return {
    activations,
    messages,
    children,
    rootOf(caller) {
      if (!known.includes(caller)) throw new Error(`rootOf: unknown caller ${String(caller?.id)}`)
      return root
    },
    async listDescendants(rootSessionId) {
      if (rootSessionId !== root.id) throw new Error('listDescendants: not the root session')
      return children.map((entry) => (entry.kind === 'child' ? { ...entry, activity: activity(entry.id) ?? entry.activity } : entry))
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
      const childId = idOf(activations.length)
      // As in the runtime, a local child enters the parent catalog at once.
      if (childId !== undefined) children.push(child1(spec.name, childId))
      return {
        ...(childId !== undefined ? { childId } : {}),
        name: spec.name,
        messageId: `m-${activations.length}`,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
    // Mirrors SubagentManager.sendMessage (manager.ts:568): the sender is the
    // exact live tree root, the content is a text ContentBlock[], and
    // `options.signal` is a required member (it is dereferenced first).
    async sendMessage(sender, targetId, content, options) {
      options.signal.throwIfAborted()
      if (!known.some((agent) => agent.id === root.id) || sender !== root) {
        throw new Error('UNAUTHORIZED: sendMessage requires the exact live root agent')
      }
      if (typeof targetId !== 'string' || targetId === '') throw new Error('send_message requires another agent in the subagent tree')
      if (!Array.isArray(content) || content.some((block) => block?.type !== 'text' || typeof block.text !== 'string')) {
        throw new Error('content must be an array of text ContentBlocks')
      }
      messages.push({ sender, targetId, content, options })
      return 'm1'
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

test('assembleMemberOpening states the role as identity, never as a task', () => {
  const standby = assembleMemberOpening('researcher', 'You research thoroughly.', '')
  // Framed as joining a team with a role definition — not as work to do. The
  // 2026-11-25 incident: a bare role prompt read as a task and the member
  // spent two minutes producing an unsolicited report.
  assert.ok(standby.startsWith('You have joined the team of agent "lead" as the member "researcher".'))
  assert.ok(standby.includes('---\nYou research thoroughly.\n---'))
  assert.equal(standby.includes('Your first task'), false)
  // A standby member is told explicitly that inherited context is not work
  // (DSH injects the creating session's timeline tree title into children).
  assert.ok(standby.includes('No task has been assigned yet.'))
  assert.ok(standby.includes('is an assignment to you'))
  assert.ok(standby.includes('reply with one short line confirming that you are ready'))
})

test('assembleMemberOpening turns a user-given task into the first task, verbatim and trimmed', () => {
  const opening = assembleMemberOpening('researcher', 'You research thoroughly.', '  review the payments module  ')
  assert.ok(opening.includes('Your first task, assigned by the user when you were added'))
  assert.ok(opening.endsWith('review the payments module'))
  assert.equal(opening.includes('No task has been assigned yet.'), false)
})

test('spawnDeliveryOf: a member given a task reports to the lead; a standby member settles silently', () => {
  // `parent` delivery makes the runtime post a settle notice that wakes an
  // idle lead (subagent manager.ts notifySettlement / sendWaking); `caller`
  // delivery never notifies, and the member still enters the parent catalog
  // (subagent types.ts: "Local children always enter the parent catalog").
  assert.equal(spawnDeliveryOf(''), 'caller')
  assert.equal(spawnDeliveryOf('   '), 'caller')
  assert.equal(spawnDeliveryOf('Do X.'), 'parent')
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
  // No task: the member is told to stand by and settles without waking the lead.
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.prompt[0].text, assembleMemberOpening('researcher', 'You research thoroughly.', undefined))
  assert.ok(spec.prompt[0].text.includes('No task has been assigned yet.'))
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
  assert.equal(subagents.activations[0].delivery, 'parent', 'a first task reports its result to the lead')
  assert.equal(
    subagents.activations[0].prompt[0].text,
    assembleMemberOpening('researcher', 'You research thoroughly.', 'review the payments module'),
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
  // An empty effort is refused too: the host's own delegation tool requires a
  // non-empty effort (tool-subagent/src/index.ts:92).
  for (const model of [{ provider: '', model: 'x' }, { provider: 'acme' }, 'acme/cheap', 42, { provider: 'acme', model: 'cheap', reasoningEffort: '' }]) {
    await assert.rejects(
      () => spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(ROUTED), model }),
      (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
      `expected roster/bad-request for ${JSON.stringify(model)}`,
    )
  }
  assert.equal(subagents.activations.length, 0)
})

// ---------------------------------------------------------------------------
// Tier resolution: the lead names a tier ('base' | 'high') and the plugin
// resolves it from the template. The dialog's explicit `model` (object or
// null) still wins and is classified against the stored models.
// ---------------------------------------------------------------------------

/** A template carrying both routes; the two differ in effort only. */
const TIERED = { ...ROUTED, highTierModel: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'max' } }

test('tier high runs the member on the template\'s high-tier model', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const result = await spawnFromTemplate(strictScope(), { subagents }, {
    agent: root,
    template: RoleTemplate.parse(TIERED),
    tier: 'high',
  })
  assert.deepEqual(subagents.activations[0].agentOptions, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'max' })
  assert.deepEqual(result.model, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'max' })
  assert.equal(result.tier, 'high')
  assert.equal(result.reused, false)
})

test('the omitted tier is base, and the result reports it', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const result = await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(TIERED) })
  assert.deepEqual(subagents.activations[0].agentOptions, { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
  assert.deepEqual({ model: result.model, tier: result.tier, reused: result.reused }, {
    model: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }, tier: 'base', reused: false,
  })
})

test('tier high without a high-tier model rejects typed and spawns nothing', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  await assert.rejects(
    () => spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(ROUTED), tier: 'high' }),
    (error) => remoteErrorOf(error)?.code === 'roster/no-high-tier-model',
  )
  assert.equal(subagents.activations.length, 0)
})

test('an unknown tier rejects typed and spawns nothing', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  await assert.rejects(
    () => spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(TIERED), tier: 'ultra' }),
    (error) => remoteErrorOf(error)?.code === 'roster/bad-request',
  )
  assert.equal(subagents.activations.length, 0)
})

test('a malformed stored high-tier model refuses high and degrades base to inherit', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  // Stored data can predate a schema change: an empty provider is schema-legal
  // but not a usable route. `high` must never start a member on it, and `base`
  // degrades to inherit rather than failing the spawn.
  const template = { ...RoleTemplate.parse(RESEARCHER), defaultModel: { provider: '', model: 'x' }, highTierModel: { provider: '', model: 'x' } }
  await assert.rejects(
    () => spawnFromTemplate(strictScope(), { subagents }, { agent: root, template, tier: 'high' }),
    (error) => remoteErrorOf(error)?.code === 'roster/no-high-tier-model',
  )
  const result = await spawnFromTemplate(strictScope(), { subagents }, { agent: root, template, tier: 'base' })
  assert.equal('agentOptions' in subagents.activations[0], false)
  assert.deepEqual({ model: result.model, tier: result.tier }, { model: null, tier: 'base' })
})

test('resolveMemberModel: an explicit model wins and is classified against the stored models', () => {
  const template = RoleTemplate.parse(TIERED)
  assert.deepEqual(TIERS, ['base', 'high'])
  const high = { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'max' }
  const custom = { provider: 'acme', model: 'cheap' }
  assert.deepEqual(resolveMemberModel(template, { model: high, tier: 'base' }), { model: high, tier: 'high' }, 'explicit beats the tier')
  assert.deepEqual(resolveMemberModel(template, { model: ROUTED.defaultModel }), { model: ROUTED.defaultModel, tier: 'base' })
  assert.deepEqual(resolveMemberModel(template, { model: custom }), { model: custom, tier: 'custom' })
  assert.deepEqual(resolveMemberModel(template, {}), { model: ROUTED.defaultModel, tier: 'base' })
  assert.deepEqual(resolveMemberModel(template, { tier: 'high' }), { model: high, tier: 'high' })
  // An invalid explicit choice is refused, not silently replaced.
  assert.throws(() => resolveMemberModel(template, { model: { provider: '', model: 'x' } }), (error) => remoteErrorOf(error)?.code === 'roster/bad-request')
  assert.throws(() => resolveMemberModel(template, { tier: 'ultra' }), (error) => remoteErrorOf(error)?.code === 'roster/bad-request')
  // The failure names the template, for the lead's report.
  assert.throws(() => resolveMemberModel(RoleTemplate.parse(ROUTED), { tier: 'high' }), (error) => {
    const remote = remoteErrorOf(error)
    return remote?.code === 'roster/no-high-tier-model' && remote.message.includes('"Researcher"') && remote?.details?.template === 't1'
  })
  // Extracted defensive rule: absent or empty provider/model → null.
  assert.equal(usableModel(null), null)
  assert.equal(usableModel(undefined), null)
  assert.equal(usableModel({ provider: '', model: 'x' }), null)
  assert.deepEqual(usableModel({ provider: 'acme', model: 'cheap' }), { provider: 'acme', model: 'cheap' })
  // Exact on provider, model and effort; an absent effort equals an empty one.
  assert.equal(sameModel(custom, { provider: 'acme', model: 'cheap', reasoningEffort: '' }), true)
  assert.equal(sameModel(ROUTED.defaultModel, high), false)
  assert.equal(sameModel(null, null), true)
  assert.equal(sameModel(null, custom), false)
})

test('inherit is one route: a dialog member and a base member of a model-less template resolve to the same tier and route', () => {
  assert.deepEqual(resolveMemberModel(RESEARCHER, { model: null }), { model: null, tier: 'base' })
  assert.deepEqual(resolveMemberModel(RESEARCHER, { tier: 'base' }), { model: null, tier: 'base' })
})

test('requireReason trims and refuses blank', () => {
  assert.equal(requireReason('  concurrency  '), 'concurrency')
  assert.throws(() => requireReason('  '), (error) => remoteErrorOf(error)?.code === 'roster/bad-request')
  assert.throws(() => requireReason(undefined), (error) => remoteErrorOf(error)?.code === 'roster/bad-request')
})

// ---------------------------------------------------------------------------
// Resident reuse (ADR-0013): a role's idle member takes the next task before
// a sibling is created. Fakes: a created member enters the catalog at once.
// ---------------------------------------------------------------------------

test('modelKeyOf: inherit is one route; a route is provider/model@effort', () => {
  assert.equal(modelKeyOf(null), 'inherit')
  assert.equal(modelKeyOf(undefined), 'inherit')
  assert.equal(modelKeyOf({ provider: 'acme', model: 'cheap' }), 'acme/cheap@')
  assert.equal(modelKeyOf({ provider: 'acme', model: 'cheap', reasoningEffort: 'low' }), 'acme/cheap@low')
})

test('assembleTaskMessage frames the task as new work under an unchanged role, verbatim and trimmed', () => {
  const text = assembleTaskMessage('  review the payments module  ')
  assert.equal(text, 'A new task from the lead of your team. Your standing role is unchanged; this task is what to do now:\n\nreview the payments module')
})

test('createMemberRegistry keeps candidates per tree root and template route, in insertion order', () => {
  const registry = createMemberRegistry()
  const entry = (name) => ({ templateId: 't1', modelKey: 'inherit', name, tier: 'base' })
  registry.remember('root-1', 'cs-1', entry('researcher'))
  registry.remember('root-1', 'cs-2', entry('reviewer'))
  registry.remember('root-1', 'cs-3', { templateId: 't1', modelKey: 'acme/cheap@low', name: 'scout', tier: 'custom' })
  registry.remember('root-2', 'cs-9', entry('elsewhere'))
  assert.deepEqual(registry.candidates('root-1', 't1', 'inherit'), ['cs-1', 'cs-2'])
  assert.deepEqual(registry.candidates('root-1', 't1', 'acme/cheap@low'), ['cs-3'])
  assert.deepEqual(registry.candidates('root-1', 't2', 'inherit'), [], 'another template')
  assert.deepEqual(registry.candidates('root-3', 't1', 'inherit'), [])
})

/** A role-template spawn with a registry, against one shared fake runtime. */
function reuseHarness(options = {}) {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root, ...options })
  const registry = createMemberRegistry()
  const spawn = (extra = {}) => spawnFromTemplate(strictScope(), { subagents, registry }, {
    agent: root, template: RoleTemplate.parse(RESEARCHER), ...extra,
  })
  return { root, subagents, registry, spawn }
}

test('role reuse hands a second task to the idle member and starts no activation', async () => {
  const { subagents, spawn } = reuseHarness()
  const controller = new AbortController()
  const first = await spawn({ task: 'review the payments module' })
  const second = await spawn({ task: '  review the orders module  ', signal: controller.signal })
  assert.equal(first.reused, false)
  assert.deepEqual({ reused: second.reused, name: second.name, childSessionId: second.childSessionId },
    { reused: true, name: first.name, childSessionId: first.childSessionId })
  assert.equal(subagents.activations.length, 1)
  assert.equal(subagents.messages.length, 1)
  const [message] = subagents.messages
  assert.equal(message.sender, subagents.activations[0].parent, 'the sender is the tree root')
  assert.equal(message.targetId, first.childSessionId)
  const text = message.content[0].text
  assert.ok(text.startsWith('A new task from the lead of your team.'), text)
  assert.ok(text.endsWith('review the orders module'))
  assert.equal(message.options.signal, controller.signal)
})

test('a busy member is not reused: a sibling is created', async () => {
  const { subagents, spawn } = reuseHarness({ activityOf: () => 'running' })
  await spawn({ task: 'first' })
  await spawn({ task: 'second' })
  assert.equal(subagents.activations.length, 2)
  assert.equal(subagents.messages.length, 0)
})

test('reuse policy task creates a member every time', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const registry = createMemberRegistry()
  const template = RoleTemplate.parse({ ...RESEARCHER, reuse: 'task' })
  const spawn = () => spawnFromTemplate(strictScope(), { subagents, registry }, { agent: root, template, task: 'go' })
  const results = [await spawn(), await spawn()]
  assert.equal(subagents.activations.length, 2)
  assert.equal(subagents.messages.length, 0)
  assert.deepEqual(results.map((result) => result.reused), [false, false])
})

test('another model route is another member', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const registry = createMemberRegistry()
  const template = RoleTemplate.parse(TIERED)
  const spawn = (extra) => spawnFromTemplate(strictScope(), { subagents, registry }, { agent: root, template, ...extra })
  const base = await spawn({ task: 'first' })
  const high = await spawn({ task: 'second', tier: 'high' })
  assert.equal(subagents.activations.length, 2)
  assert.equal(subagents.messages.length, 0)
  assert.deepEqual([base.tier, high.tier], ['base', 'high'])
})

test('a standby request for a role that already stands by returns the member and wakes nobody', async () => {
  const { spawn, subagents } = reuseHarness()
  const first = await spawn()
  const second = await spawn()
  assert.equal(subagents.activations.length, 1)
  assert.equal(subagents.messages.length, 0, 'no task, no message')
  assert.deepEqual({ reused: second.reused, name: second.name, childSessionId: second.childSessionId },
    { reused: true, name: first.name, childSessionId: first.childSessionId })
})

test('a model-less template inherits one route and is reused', async () => {
  const { spawn, subagents } = reuseHarness()
  const first = await spawn({ model: null })
  const second = await spawn({ tier: 'base' })
  assert.equal(subagents.activations.length, 1)
  assert.deepEqual({ reused: second.reused, name: second.name, model: second.model, tier: second.tier },
    { reused: true, name: first.name, model: null, tier: 'base' })
})

test('a member without an exposed session id is never reused and nothing throws', async () => {
  const { spawn, subagents, registry } = reuseHarness({ childIdOf: () => undefined })
  const first = await spawn({ task: 'first' })
  const second = await spawn({ task: 'second' })
  assert.equal('childSessionId' in first, false)
  assert.equal(subagents.activations.length, 2)
  assert.equal(subagents.messages.length, 0)
  assert.deepEqual(registry.candidates('root-1', 't1', 'inherit'), [])
  assert.equal(second.reused, false)
})

test('diagnostic entries are skipped and a failing delivery is reported, not retried with a second member', async () => {
  const boom = new Error('inbox closed')
  const { subagents, spawn } = reuseHarness()
  const first = await spawn({ task: 'first' })
  // A diagnostic row for the SAME session id, ahead of the real child row:
  // it must neither count as the idle member nor hide it.
  subagents.children.unshift({ kind: 'diagnostic', id: first.childSessionId, reason: 'corrupt' })
  assert.equal(subagents.children[0].kind, 'diagnostic')
  subagents.sendMessage = async (sender, targetId, content, options) => {
    options.signal.throwIfAborted()
    throw boom
  }
  // The member was still chosen (the delivery was attempted and is the
  // caller's error), and no second member was started in its place.
  await assert.rejects(() => spawn({ task: 'second' }), (error) => error === boom)
  assert.equal(subagents.activations.length, 1)
})

test('a member listed only as a diagnostic row is not reused: a sibling is created', async () => {
  const { subagents, spawn } = reuseHarness()
  const first = await spawn({ task: 'first' })
  subagents.children.splice(0, subagents.children.length, { kind: 'diagnostic', id: first.childSessionId, reason: 'corrupt' })
  const second = await spawn({ task: 'second' })
  assert.equal(second.reused, false)
  assert.equal(subagents.messages.length, 0, 'an unreachable member is never messaged')
  assert.equal(subagents.activations.length, 2)
})

test('the registry is scoped to the caller\'s tree root', async () => {
  const rootA = { id: 'root-1', name: LEAD }
  const rootB = { id: 'root-2', name: LEAD }
  const activations = []
  const subA = fakeSubagents({ root: rootA, activations })
  const subB = fakeSubagents({ root: rootB, activations })
  const registry = createMemberRegistry()
  const template = RoleTemplate.parse(RESEARCHER)
  const first = await spawnFromTemplate(strictScope(), { subagents: subA, registry }, { agent: rootA, template })
  const second = await spawnFromTemplate(strictScope(), { subagents: subB, registry }, { agent: rootB, template })
  assert.equal(activations.length, 2)
  assert.equal(second.reused, false)
  assert.notEqual(second.childSessionId, first.childSessionId)
})

test('findIdleMember: the first registered candidate listed as an inactive child; nothing else', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root, activityOf: (childId) => (childId === 'busy' ? 'running' : 'inactive') })
  const registry = createMemberRegistry()
  const entry = (name) => ({ templateId: 't1', modelKey: 'inherit', name, tier: 'base' })
  registry.remember('root-1', 'gone', entry('gone'))
  registry.remember('root-1', 'busy', entry('busy'))
  registry.remember('root-1', 'idle', entry('idle'))
  subagents.children.push(child1('busy', 'busy'), { ...child1('idle', 'idle'), path: 'team/idle', depth: 2 })
  assert.deepEqual(await findIdleMember({ subagents, registry, rootId: 'root-1', templateId: 't1', modelKey: 'inherit' }),
    { childId: 'idle', name: 'idle' })
  assert.deepEqual(await findIdleMember({ subagents, registry, rootId: 'root-1', templateId: 't2', modelKey: 'inherit' }), null)
})

test('without a registry a role template still creates a member every time', async () => {
  const root = { id: 'root-1', name: LEAD }
  const subagents = fakeSubagents({ root })
  const spawn = () => spawnFromTemplate(strictScope(), { subagents }, { agent: root, template: RoleTemplate.parse(RESEARCHER), task: 'go' })
  await spawn()
  await spawn()
  assert.equal(subagents.activations.length, 2)
})
