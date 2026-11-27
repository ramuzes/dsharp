/**
 * Agent-driven member creation (ADR-0011): the `roster_spawn` tool renders a
 * role template into one ordinary subagent through the subagent runtime.
 *
 * Why a plugin tool rather than the model's own `subagent` call: DSH limits
 * explicit child-model selection made through the `subagent` tool to the
 * parent's current route unless the Host configures an allowlist policy
 * (packages/subagent/tool-subagent/src/model-selection.ts:167-190,
 * MODEL_ROUTE_NOT_ALLOWED), and letting the model rewrite the standing prompt
 * per spawn would reintroduce the drift templates exist to prevent. The tool
 * therefore owns the deterministic part and the agent loop owns the context.
 *
 * Mechanism (unchanged from ADR-0008): resolve the caller's tree root via the
 * subagents runtime (`rootOf`, packages/subagent/subagent/src/index.ts:307),
 * allocate a free sibling name, then `startActivation` with parent delivery —
 * the identical path the `subagent` tool uses. `prompt` becomes the child's
 * FIRST USER MESSAGE, not its system prompt (manager.ts:406-412); the system
 * prompt comes from the child's own composition. The render is frozen: the
 * template's standing prompt is passed verbatim.
 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assembleTaskMessage, findIdleMember, modelKeyOf } from './members.js'
import { resolveMemberModel } from './tiers.js'
import { readString } from './wire.js'

// Model validation lives in lib/tiers.js; re-exported for its existing importers.
export { parseModelChoice } from './tiers.js'

/** In-process spawn provider name (subagent-spawn-in-process default). */
const SPAWN_PROVIDER = 'spawn'

/** The subagent tree root's fixed, unallocatable name (names.ts ROOT_AGENT_NAME). */
const ROOT_AGENT_NAME = 'lead'

/** Child-name length cap the runtime enforces (names.ts NAME_PATTERN). */
const NAME_MAX = 32

/**
 * Slugify a display name into a child-name base: lower-case, `[a-z0-9-]` with
 * single hyphens between runs, at most 32 characters, starting with a letter.
 * An empty or otherwise invalid result (e.g. leading digit) falls back to
 * `member`, mirroring the runtime's own name grammar.
 * @param {unknown} name - display name (defensively string-coerced).
 * @returns {string}
 */
export function slugify(name) {
  const slug = readString(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/g, '')
  return slug === '' || !/^[a-z]/.test(slug) ? 'member' : slug
}

/**
 * Allocate a child name unique among `taken`: `base`, `base-2`, `base-3`, …
 * The base is slugified defensively, and `lead` — the root agent's fixed
 * name, which no child may take — becomes `lead-member`. A suffixed variant
 * is length-fitted so every emitted name stays within the runtime's 1–32
 * character name grammar (names.ts NAME_PATTERN) even when the base fills it.
 * @param {unknown} base - requested base (template display name).
 * @param {string[]} taken - names already used among the creator's children.
 * @returns {string} a name absent from `taken`.
 */
export function allocateName(base, taken = []) {
  const held = new Set(taken)
  let effective = slugify(base)
  if (effective === ROOT_AGENT_NAME) effective = `${ROOT_AGENT_NAME}-member`
  if (!held.has(effective)) return effective
  let ordinal = 2
  let candidate = ''
  do {
    candidate = `${effective.slice(0, NAME_MAX - String(ordinal).length - 1)}-${ordinal}`
    ordinal += 1
  } while (held.has(candidate))
  return candidate
}

/**
 * Delivery mode for one member's activation (dsh
 * packages/subagent/subagent/src/manager.ts, `notifySettlement` →
 * `sendWaking(parent, message, parent.status === 'idle' ? 'queue' : 'steer')`).
 *
 * `parent` makes the runtime post a settle notice to the lead when the
 * member's turn ends, and an idle lead then runs a turn. `caller` returns
 * before that notice (the function's first line) while the member still
 * enters the parent catalog (types.ts: "Local children always enter the
 * parent catalog"), so it stays discoverable and continuable.
 *
 * A member given a first task owes the lead a result; a standby member owes
 * nothing and must not wake anybody. The 2026-11-25 incident: a freshly
 * added member's settlement notice started a lead turn that could only say
 * the member's report was irrelevant.
 * @param {unknown} task - the user-given first task, if any.
 * @returns {'parent' | 'caller'}
 */
export function spawnDeliveryOf(task) {
  return readString(task).trim() === '' ? 'caller' : 'parent'
}

/**
 * The member's opening message — its FIRST USER MESSAGE (never its system
 * prompt): a role definition framed as identity, then either an explicit
 * stand-by order or the user's first task.
 *
 * Why the framing matters: the runtime presents this message to the member as
 * "Agent lead sent a message: …", and DSH injects the creating session's
 * timeline tree title into the child's context. A bare role prompt ("your job
 * is to read all the related code…") therefore reads as a task, and the
 * member picks that inherited title as its topic (2026-11-25 incident).
 * @param {unknown} name - the member's allocated name.
 * @param {unknown} standing - the template's standing instruction.
 * @param {unknown} [task] - optional first task assigned by the user.
 * @returns {string}
 */
export function assembleMemberOpening(name, standing, task) {
  // Trim: the task may arrive from a model's tool call, which routinely pads
  // its arguments; the member should not inherit stray whitespace.
  const kickoff = readString(task).trim()
  return [
    `You have joined the team of agent "${ROOT_AGENT_NAME}" as the member "${readString(name)}".`,
    'Your role definition. It states who you are for your whole residency — it is not a task to perform now:',
    '---',
    readString(standing),
    '---',
    ...(kickoff === '' ? [
      'No task has been assigned yet. Nothing you inherited from the session that created you — timeline trees, plans, titles, repository state — is an assignment to you.',
      'Do not explore, read files, or produce reports now, and do not send any message: just reply with one short line confirming that you are ready, then end your turn and wait. Work will reach you through messages from other agents or through the shared task board.',
    ] : [
      'Your first task, assigned by the user when you were added — carry it out now:',
      kickoff,
    ]),
  ].join('\n')
}

/**
 * Resolve one optional host service: the deps bag wins, then the scope's
 * sanctioned name lookup (`scope.get(name)` returns undefined when the
 * service is absent — the same optional-service rule lib/store.js uses for
 * storageDomain). Absence is the CALLER's typed-error decision, not a crash.
 * @param {object} [scope] - plugin ctx or inject scope.
 * @param {object} [deps] - explicit service bag (test seam / DI).
 * @param {string} name - service name.
 */
const service = (scope, deps, name) => (deps?.[name] !== undefined ? deps[name] : scope?.get?.(name))

/**
 * Resolve a template by record id or by EXACT display name — the two forms a
 * callers may pass (the lead sees ids from `roster_template_list`; the
 * `/roster` command receives whatever the user typed).
 * @param {{ all(): Promise<Array<{ id: string, name: string }>>, byId(id: string): Promise<object | undefined> }} store
 * @param {unknown} reference - id or exact name.
 * @returns {Promise<object>} the matching template record.
 * @throws {RemoteError} `roster/bad-request` (empty), `roster/not-found`,
 *   `roster/ambiguous-name`.
 */
export async function resolveTemplateRef(store, reference) {
  const ref = readString(reference)
  if (ref === '') {
    throw new RemoteError('roster/bad-request', 'template is required / template 不能为空', { field: 'template' })
  }
  const byId = await store.byId(ref)
  if (byId !== undefined) return byId
  const matches = (await store.all()).filter((template) => template.name === ref)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new RemoteError('roster/ambiguous-name',
      `${matches.length} templates are named ${JSON.stringify(ref)}; pass the template id instead / 有 ${matches.length} 个同名模板，请改用模板 id`,
      { name: ref, ids: matches.map((template) => template.id) })
  }
  throw new RemoteError('roster/not-found', `Template ${JSON.stringify(ref)} not found / 未找到模板 ${JSON.stringify(ref)}`, { template: ref })
}

/**
 * Spawn one roster member for the CALLING agent (ADR-0011): root the caller's
 * tree, allocate a free sibling name, and hand the rendered template to
 * `subagents.startActivation` with parent delivery.
 *
 * The child's model is resolved by lib/tiers.js: the dialog's explicit choice
 * (object, or `null` to inherit) wins, else the requested `tier` selects the
 * template's stored model (base may inherit). The activation's
 * `result` promise is owned by the runtime for parent delivery; the manager
 * acknowledges it itself (manager.ts:897 `void activation.result.promise.catch`),
 * so not awaiting it here cannot dangle an unhandled rejection.
 *
 * @param {object} scope - plugin ctx; only its get() name lookup is touched.
 * @param {{ subagents?: object, registry?: object }} deps - optional host services
 *   (test seam/DI); `registry` is the lead's created-member registry
 *   (lib/members.js). Without it nothing is ever reused.
 * @param {{ agent?: object, template: object, task?: unknown, tier?: 'base' | 'high', model?: import('./store.js').ModelRef | null }} input - the
 *   calling agent, the resolved template record, the optional task, the
 *   optional tier (default base), and the dialog's optional per-spawn model
 *   choice (object or null; wins over the tier).
 * @returns {Promise<{ name: string, childSessionId?: string, model: object | null, tier: 'base' | 'high' | 'custom', reused: boolean }>}
 *   the activation's model-facing name, the child session id when exposed,
 *   the applied model (null = inherited), the tier it resolved to, and
 *   `reused` (true when an idle resident member took the request).
 * @throws {RemoteError} `roster/no-subagents`, `roster/bad-request`,
 *   `roster/no-high-tier-model`.
 * @throws {Error} when `input.agent` is absent (tool misuse, not a data error).
 */
export async function spawnFromTemplate(scope, deps, input) {
  const subagents = service(scope, deps, 'subagents')
  if (subagents === undefined) {
    throw new RemoteError('roster/no-subagents',
      'subagents runtime is unavailable — cannot create team members / subagents 运行时不可用，无法创建成员')
  }
  const agent = input?.agent
  if (agent === undefined || agent === null) throw new Error('roster_spawn requires a calling agent')
  const template = input?.template
  if (template === undefined || template === null) {
    throw new RemoteError('roster/bad-request', 'template is required / template 不能为空', { field: 'template' })
  }

  // The route comes from the tier (or the dialog's explicit model); an
  // invalid stored model degrades to inherit there, a refused `high` throws
  // before anything starts.
  const { model, tier } = resolveMemberModel(template, { tier: input?.tier, model: input?.model })

  const root = subagents.rootOf(agent)

  // `signal` is a required spec member (types.ts:43) owning cancellation
  // BEFORE publication. A tool call has a caller signal; when it fires, the
  // spawn is abandoned before publication.
  const signal = input?.signal instanceof AbortSignal ? input.signal : new AbortController().signal
  const task = readString(input?.task).trim()

  // Resident reuse (ADR-0013): a role's idle member takes the next task
  // before a sibling is created. Only a registered member of the same
  // template and model route in this tree, listed as inactive by the runtime.
  const registry = service(scope, deps, 'registry')
  if (template.reuse === 'role' && registry !== undefined) {
    const idle = await findIdleMember({
      subagents, registry, rootId: root.id, templateId: template.id, modelKey: modelKeyOf(model),
    })
    if (idle !== null) {
      if (task !== '') {
        // SubagentManager.sendMessage (dsh
        // packages/subagent/subagent/src/manager.ts:568): the sender is the
        // tree's live root Agent, content is a ContentBlock[], and
        // `options.signal` is dereferenced first. A rejected delivery is the
        // caller's error: it is not retried with a second member.
        await subagents.sendMessage(root, idle.childId, [{ type: 'text', text: assembleTaskMessage(task) }], { signal })
      }
      return { name: idle.name, childSessionId: idle.childId, model, tier, reused: true }
    }
  }

  // Free-name allocation against the root's committed direct-child names
  // (listDescendants depth-1 paths — the exact sibling set the runtime's own
  // reservation checks; the list is advisory, the runtime reservation is
  // authoritative and fails loudly on a race).
  const descendants = await subagents.listDescendants(root.id)
  const taken = descendants
    .filter((entry) => entry?.kind === 'child' && entry.depth === 1 && typeof entry.path === 'string')
    .map((entry) => entry.path)
  const name = allocateName(template.name, taken)

  const activation = await subagents.startActivation({
    provider: SPAWN_PROVIDER,
    parent: root,
    label: readString(template.name),
    name,
    prompt: [{ type: 'text', text: assembleMemberOpening(name, template.prompt, task) }],
    ...(model !== null
      ? {
        agentOptions: {
          provider: model.provider,
          model: model.model,
          ...(typeof model.reasoningEffort === 'string' && model.reasoningEffort !== ''
            ? { reasoningEffort: model.reasoningEffort }
            : {}),
        },
      }
      : {}),
    signal,
    // A first task reports to the lead; a standby member settles silently.
    delivery: spawnDeliveryOf(task),
  })
  // A created member is remembered for reuse when its session id is exposed;
  // without one it could never be addressed, so it is not a candidate.
  if (registry !== undefined && typeof activation.childId === 'string') {
    registry.remember(root.id, activation.childId, {
      templateId: template.id, modelKey: modelKeyOf(model), name: activation.name, tier,
    })
  }
  return {
    name: activation.name,
    ...(activation.childId !== undefined ? { childSessionId: activation.childId } : {}),
    model,
    tier,
    // A creation is never a reuse.
    reused: false,
  }
}
