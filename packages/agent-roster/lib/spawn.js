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
import { ModelRef } from './store.js'
import { readString } from './wire.js'

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
 * Assemble the child's initial prompt: the standing instructions alone, or
 * the standing instructions plus the kickoff task under the exact separator
 * contract pinned by the plan (verbatim).
 * @param {string} standing - the template's standing prompt.
 * @param {string} [task] - optional task assigned by the user at spawn time.
 * @returns {string} `standing`, or `${standing}\n\n---\n\nInitial task
 *   (assigned by the user at spawn time):\n${task}`.
 */
export function assembleSpawnPrompt(standing, task) {
  const base = readString(standing)
  // Trim: the task now arrives from a model's tool call, which routinely
  // pads arguments; the child should not inherit stray whitespace.
  const kickoff = readString(task).trim()
  return kickoff === ''
    ? base
    : `${base}\n\n---\n\nInitial task (assigned by the user at spawn time):\n${kickoff}`
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
 * model may pass (it sees ids from `roster_template_list` and names from the
 * injected instruction).
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
 * The child's model: an explicit per-spawn choice wins — an object names the
 * route, `null` clears the template default so the child inherits the parent's
 * current route — then the template's `defaultModel`, otherwise omitted
 * (inherit). The activation's
 * `result` promise is owned by the runtime for parent delivery; the manager
 * acknowledges it itself (manager.ts:897 `void activation.result.promise.catch`),
 * so not awaiting it here cannot dangle an unhandled rejection.
 *
 * @param {object} scope - plugin ctx; only its get() name lookup is touched.
 * @param {{ subagents?: object }} deps - optional host services (test seam/DI).
 * @param {{ agent?: object, template: object, task?: unknown, model?: import('./store.js').ModelRef | null }} input - the
 *   calling agent, the resolved template record, the optional task, and the
 *   optional per-spawn model choice (object or null; omitted = template default).
 * @returns {Promise<{ name: string, childSessionId?: string, model: object | null }>}
 *   the activation's model-facing name, the child session id when exposed,
 *   and the applied model (null = inherited).
 * @throws {RemoteError} `roster/no-subagents`, `roster/bad-request`.
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

  // The template's model, validated defensively (stored data can predate a
  // schema change). An invalid stored ref degrades to "inherit" — a spawn
  // must not fail because a model was retired.
  /** @type {{ provider: string, model: string, reasoningEffort?: string } | null} */
  let model = null
  if (template.defaultModel !== null && template.defaultModel !== undefined) {
    const parsed = ModelRef.safeParse(template.defaultModel)
    // Empty provider/model strings are schema-legal but not a usable route;
    // treating them as a selection would send the child a broken route.
    if (parsed.success && parsed.data.provider !== '' && parsed.data.model !== '') model = parsed.data
  }
  // Per-spawn override: an explicit choice — an object, or `null` which
  // clears the template default — beats the template; an omitted choice keeps
  // it. Unlike stored data an explicit choice is REFUSED when invalid: the
  // caller asked for one particular route, so silently running another would
  // create the wrong member.
  const explicit = input?.model
  if (explicit !== undefined) {
    const parsedChoice = explicit === null ? undefined : ModelRef.safeParse(explicit)
    if (explicit === null) {
      model = null
    } else if (!parsedChoice.success || parsedChoice.data.provider === '' || parsedChoice.data.model === '') {
      const issues = parsedChoice.success
        ? [{ path: 'provider, model', message: 'provider and model must be non-empty' }]
        : parsedChoice.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      throw new RemoteError('roster/bad-request',
        `model rejected / 模型不合法: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, { issues })
    } else {
      model = parsedChoice.data
    }
  }

  const root = subagents.rootOf(agent)
  // Free-name allocation against the root's committed direct-child names
  // (listDescendants depth-1 paths — the exact sibling set the runtime's own
  // reservation checks; the list is advisory, the runtime reservation is
  // authoritative and fails loudly on a race).
  const descendants = await subagents.listDescendants(root.id)
  const taken = descendants
    .filter((entry) => entry?.kind === 'child' && entry.depth === 1 && typeof entry.path === 'string')
    .map((entry) => entry.path)
  const name = allocateName(template.name, taken)

  // `signal` is a required spec member (types.ts:43) owning cancellation
  // BEFORE publication. A tool call has a caller signal; when it fires, the
  // spawn is abandoned before publication.
  const signal = input?.signal instanceof AbortSignal ? input.signal : new AbortController().signal
  const prompt = assembleSpawnPrompt(template.prompt, input?.task)
  const activation = await subagents.startActivation({
    provider: SPAWN_PROVIDER,
    parent: root,
    label: readString(template.name),
    name,
    prompt: [{ type: 'text', text: prompt }],
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
    delivery: 'parent',
  })
  return {
    name: activation.name,
    ...(activation.childId !== undefined ? { childSessionId: activation.childId } : {}),
    model,
  }
}