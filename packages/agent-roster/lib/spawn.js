/**
 * Member spawn and team status: the pure naming/prompt helpers plus the
 * orchestrators the `agentRoster` remote calls (ADR-0008 — members are
 * ordinary subagents started through the subagent runtime, never a parallel
 * mechanism).
 *
 * Every host interface below was verified against the dsh source
 * (/home/ramuz/deepseek-harness, AGENTS.md 2b: the source is the single
 * source of truth for in-process consumers):
 *
 * - `sessionController.resolveAgent(sessionId)` returns `{ agent }` or
 *   `{ error: RemoteError<'session/not-found'|...> }`
 *   (packages/api/session-controller/src/agent.ts:87-92). The schedule
 *   precedent rethrows `resolved.error` as-is
 *   (packages/schedule/schedule/src/index.ts:250-257) — followed verbatim.
 * - `subagents.rootOf(caller)` resolves an exact live Agent's subagent tree
 *   root (packages/subagent/subagent/src/index.ts:296-302); ordinary Session
 *   forks lead independent trees, so spawning parents at the ROOT keeps one
 *   tree's members siblings.
 * - `subagents.startActivation(spec)` is host-side only (no Remote create
 *   API — ADR-0008; implementation index.ts:267-292). `SubagentActivationSpec`
 *   (packages/subagent/subagent/src/types.ts:29-46) requires `provider`
 *   (registered backend name; the in-process provider registers under `spawn`
 *   by default — subagent-spawn-in-process/src/index.ts:24-28,58),
 *   `label`, `signal: AbortSignal`, `delivery: 'parent'|'caller'`, and a
 *   `prompt: ContentBlock[]` — the workflow plugin passes text blocks as
 *   `[{ type: 'text', text }]` (packages/workflow/workflow-ptc/src/host.ts:
 *   218-233), the exact shape used here. `agentOptions?: AgentOptions` fields
 *   are `provider`, `model`, `reasoningEffort`, `maxTokens` —
 *   resolveChildAgentOptions merges them over the parent's options
 *   (packages/subagent/subagent/src/child-agent.ts:98-119), so omitting the
 *   member entirely inherits the parent's current route (ADR-0008).
 * - Child-name uniqueness is enforced per creator among the creator's
 *   committed catalog names plus in-flight reservations
 *   (manager.ts reserveName → names.ts SiblingNameReservations.reserve:
 *   `/^[a-z][a-z0-9-]{0,31}$/` other than `lead`, the root's fixed name).
 *   `subagents.listDescendants(rootSessionId)` exposes the committed rows
 *   (index.ts:421-433; entries carry `kind`/`depth`/`path` — control-types.ts
 *   :42-47 + list-children.ts:17-24): depth-1 `path`s are exactly the root's
 *   direct-child names the runtime compares against. A concurrent spawn that
 *   races this listing loses loudly: the runtime's own reservation throws
 *   `DUPLICATE_AGENT_NAME` rather than silently aliasing.
 * - `agentTeams.isEnabled(caller)` reads the Team selection shared by the
 *   caller's subagent tree (packages/team/agent-team/src/index.ts:93-97); it
 *   is legal from a descendant (it roots internally), while enabling requires
 *   the root (TEAM_LEAD_REQUIRED) — which is why `canEnable` is
 *   `agentTeams present && isRoot`.
 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { readString } from './wire.js'
import { ModelRef } from './store.js'

/**
 * The subagent backend members spawn on. The in-process provider registers
 * under `spawn` unless its host row renames it (subagent-spawn-in-process
 * Config.providerName, default `spawn`); an unavailable/replaced backend
 * fails `startActivation` loudly (PROVIDER_CHANGED) rather than degrading.
 */
export const SPAWN_PROVIDER = 'spawn'

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
 * @param {unknown} base - requested base (display name or memberName).
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
 * @param {string} standing - the template's or custom member's standing prompt.
 * @param {string} [task] - optional task assigned by the user at spawn time.
 * @returns {string} `standing`, or `${standing}\n\n---\n\nInitial task
 *   (assigned by the user at spawn time):\n${task}`.
 */
export function assembleSpawnPrompt(standing, task) {
  const base = readString(standing)
  const kickoff = readString(task)
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
 * Spawn one roster member into the current session's subagent tree (ADR-0008).
 *
 * Resolution order mirrors the remote contract: validate input shapes
 * (`roster/bad-request`), load the template (`roster/not-found`), resolve the
 * session's live Agent, root it, allocate a free sibling name, and hand the
 * rendered member to `subagents.startActivation` with parent delivery — the
 * same semantics a model-driven spawn produces. The activation's `result`
 * promise is owned by the runtime for parent delivery; the manager itself
 * acknowledges it (manager.ts:897 `void activation.result.promise.catch`),
 * so not awaiting it here cannot dangle an unhandled rejection.
 *
 * @param {object} scope - plugin ctx; only its get() name lookup is touched.
 * @param {{ store: object, sessionController?: object, subagents?: object, agentTeams?: object }} deps
 *   - the roster store (required) and optional host services; `agentTeams` is
 *   part of the single service bag but is not consulted by the spawn path.
 * @param {{ sessionId: string, templateId?: string, custom?: { name: string, description: string, prompt: string }, memberName?: string, model?: import('./store.js').ModelRef | null, task?: string }} input
 * @returns {Promise<{ name: string, childSessionId?: string }>} the
 *   activation's model-facing name and (for session-backed children) its
 *   durable child session id.
 * @throws {RemoteError} `roster/bad-request`, `roster/not-found`,
 *   `roster/no-session-controller`, `roster/no-subagents`; the session's own
 *   typed error when the session cannot be resolved; the runtime's typed
 *   SubagentError when the activation is rejected.
 */
export async function spawnFromRoster(scope, deps, input) {
  const store = deps?.store
  if (store === undefined) throw new Error('spawnFromRoster: the roster store is required')
  const sessionController = service(scope, deps, 'sessionController')
  const subagents = service(scope, deps, 'subagents')
  if (sessionController === undefined) {
    throw new RemoteError('roster/no-session-controller',
      'sessionController is unavailable — cannot resolve the session to spawn into / sessionController 不可用，无法解析要加入的会话')
  }
  if (subagents === undefined) {
    throw new RemoteError('roster/no-subagents',
      'subagents runtime is unavailable — cannot spawn team members / subagents 运行时不可用，无法创建成员')
  }

  const sessionId = readString(input?.sessionId)
  if (sessionId === '') {
    throw new RemoteError('roster/bad-request', 'sessionId is required / sessionId 不能为空', { field: 'sessionId' })
  }
  const templateId = readString(input?.templateId)
  const custom = input?.custom
  // custom xor templateId — exactly one member source.
  if ((templateId !== '') === (custom !== undefined)) {
    throw new RemoteError('roster/bad-request',
      'exactly one of templateId or custom is required / templateId 与 custom 必须二选一', { field: 'templateId' })
  }

  /** @type {import('zod').z.infer<typeof import('./store.js').RoleTemplate> | undefined} */
  let template = undefined
  /** @type {{ name: string, prompt: string }} */
  let source
  if (templateId !== '') {
    template = await store.byId(templateId)
    if (template === undefined) {
      throw new RemoteError('roster/not-found', `Template ${templateId} not found / 未找到模板 ${templateId}`, { id: templateId })
    }
    source = { name: template.name, prompt: template.prompt }
  } else {
    const name = readString(custom?.name)
    const prompt = readString(custom?.prompt)
    if (name === '' || prompt === '') {
      throw new RemoteError('roster/bad-request',
        'custom member requires a non-empty name and prompt / custom 成员需要非空的 name 与 prompt', { field: 'custom' })
    }
    source = { name, prompt }
  }

  // Model precedence: an explicit input (including null, which clears) beats
  // the template's defaultModel; none → omit agentOptions entirely so the
  // child inherits the parent's current route (ADR-0008).
  const requestedModel = input?.model === undefined ? template?.defaultModel ?? null : input.model
  /** @type {{ provider: string, model: string, reasoningEffort?: string } | null} */
  let model = null
  if (requestedModel !== null && requestedModel !== undefined) {
    const parsed = ModelRef.safeParse(requestedModel)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      throw new RemoteError('roster/bad-request',
        `model rejected / 模型不合法: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, { issues })
    }
    model = parsed.data
  }

  // Resolve the live Agent, then the tree root it belongs to. schedule
  // precedent: a typed session error rethrows as-is (schedule/src/index.ts:
  // 250-257).
  const resolved = await sessionController.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  const root = subagents.rootOf(resolved.agent)

  // Free-name allocation against the root's committed direct-child names
  // (listDescendants depth-1 paths — the exact sibling set the runtime's own
  // reservation checks; see file header).
  const descendants = await subagents.listDescendants(root.id)
  const taken = descendants
    .filter((entry) => entry?.kind === 'child' && entry.depth === 1 && typeof entry.path === 'string')
    .map((entry) => entry.path)
  const memberName = readString(input?.memberName)
  const name = allocateName(memberName !== '' ? memberName : source.name, taken)

  // `signal` is a required spec member (types.ts:43) owning cancellation
  // BEFORE publication; the Remote spawn call has no cancellation channel, so
  // each spawn carries its own never-fired signal — post-publication
  // cancellation belongs to the activation's dispose, owned by the runtime.
  const signal = new AbortController().signal
  const prompt = assembleSpawnPrompt(source.prompt, input?.task)
  const activation = await subagents.startActivation({
    provider: SPAWN_PROVIDER,
    parent: root,
    label: source.name,
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
  }
}

/**
 * Report the Team status of one session: whether Team mode is enabled for its
 * subagent tree, whether the session is that tree's root, and whether the
 * caller may therefore enable Team mode (`agentTeams present && isRoot` —
 * enabling from a descendant is impossible by construction, agent-team
 * TEAM_LEAD_REQUIRED).
 *
 * @param {object} scope - plugin ctx; only its get() name lookup is touched.
 * @param {{ sessionController?: object, subagents?: object, agentTeams?: object }} deps
 *   - optional host services (test seam / DI); each falls back to the scope.
 * @param {{ sessionId: string }} input
 * @returns {Promise<{ teamMode: boolean, isRoot: boolean, canEnable: boolean }>}
 * @throws {RemoteError} `roster/bad-request`, `roster/no-session-controller`,
 *   `roster/no-subagents`, or the session's own typed resolution error.
 */
export async function teamStatusOf(scope, deps, input) {
  const sessionController = service(scope, deps, 'sessionController')
  const subagents = service(scope, deps, 'subagents')
  if (sessionController === undefined) {
    throw new RemoteError('roster/no-session-controller',
      'sessionController is unavailable — cannot resolve the session / sessionController 不可用，无法解析会话')
  }
  if (subagents === undefined) {
    throw new RemoteError('roster/no-subagents',
      'subagents runtime is unavailable — cannot inspect the session tree / subagents 运行时不可用，无法检查会话树')
  }
  const sessionId = readString(input?.sessionId)
  if (sessionId === '') {
    throw new RemoteError('roster/bad-request', 'sessionId is required / sessionId 不能为空', { field: 'sessionId' })
  }
  const resolved = await sessionController.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  const root = subagents.rootOf(resolved.agent)
  const isRoot = root === resolved.agent
  const agentTeams = service(scope, deps, 'agentTeams')
  const teamMode = agentTeams === undefined ? false : agentTeams.isEnabled(resolved.agent) === true
  return { teamMode, isRoot, canEnable: agentTeams !== undefined && isRoot }
}
