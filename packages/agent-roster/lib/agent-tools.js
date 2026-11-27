/**
 * Agent-facing roster tools: `roster_spawn` (the single creation path,
 * ADR-0011 — always registered) plus the authoring pair
 * `roster_template_save` / `roster_template_list` over the `agentRoster`
 * remote service (lib/roster-service.js), gated by the `exposeAgentTools`
 * Config toggle.
 *
 * Registration API mirrors this repo's precedent, engram's
 * packages/engram/lib/agent-tools.js (itself mirroring
 * packages/gitlab/lib/agent-tools.js): defineTool from
 * '@deepseek-ai/dsh-tools', TEXT_OUTPUT-style plain-text output (the
 * session-query shape), a `register` helper pushing disposers, and a
 * `failure()` mapper that never rethrows a raw error into the host. The
 * read-only tool declares isConcurrencySafe; the mutating save does not.
 *
 * One operation, two callers (the dsh user-actions doctrine): the tools call
 * the SAME service methods the Web GUI client half calls — saveTemplate /
 * listTemplates — and duplicate no roster logic here. roster_template_save
 * is an UPSERT by exact name: the name is resolved through the service's
 * own read (listTemplates + exact match, the store's byName semantics) and
 * a match reuses the existing record's id, so the save updates instead of
 * tripping roster/name-taken; omitted optional fields keep their stored
 * values (service patch semantics), default_model / high_tier_model null
 * clears them.
 *
 * roster_spawn takes a model TIER, never a model (ADR-0013): the lead names
 * `base` or `high` and, for `high`, states the escalation basis; the route
 * itself is resolved from the template's stored models by lib/tiers.js, so
 * the lead can no longer pick an arbitrary route or inherit its own.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireReason } from './tiers.js'
import { resolveTemplateRef, spawnFromTemplate } from './spawn.js'
import { failureText as failure } from './wire.js'

/** Plain-text tool output (session-query's TEXT_OUTPUT shape). */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** Output bound: JSON.stringify payload truncated here + a visible marker. */
const MAX_OUTPUT_CHARS = 8000
const TRUNCATION_MARKER = '…[truncated]'

/** Bounded tool output: trimmed JSON, truncated with a visible marker. */
function bounded(payload) {
  const text = JSON.stringify(payload)
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_MARKER
}


/**
 * Map a tool-facing model parameter (default_model, high_tier_model) to the service's ModelRef key
 * spelling (reasoning_effort → reasoningEffort). undefined stays undefined
 * (omit → patch-semantics preserve) and null stays null (explicit clear).
 */
function toModelRef(value) {
  if (value === undefined || value === null) return value
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoning_effort === undefined ? {} : { reasoningEffort: value.reasoning_effort }),
  }
}

/**
 * Register the roster tools: `roster_spawn` always (the "+" flow depends on
 * it), and the authoring pair when `authoring` is true.
 *
 * @param {object} scope - inject scope with `tools` injected (accessing it
 *   on a scope that did not inject it throws in cordis — AGENTS.md 3).
 * @param {{
 *   saveTemplate(input: { id?: string, name: string, description?: string, prompt: string, defaultModel?: import('./store.js').ModelRef | null, highTierModel?: import('./store.js').ModelRef | null, reuse?: 'role' | 'task' }): Promise<import('./store.js').RoleTemplate>,
 *   listTemplates(): Promise<import('./store.js').RoleTemplate[]>,
 * }} service - the `agentRoster` remote (lib/roster-service.js); only the
 *   two methods above are called.
 * @param {{ store: { all(): Promise<object[]>, byId(id: string): Promise<object | undefined> }, subagents: object }} deps
 *   - the roster store (template resolution) and the subagents runtime the
 *     spawn tool creates members through. Both are passed explicitly because
 *     this callback's inject list is `['tools', 'subagents']` — services not
 *     injected on a scope throw on access (AGENTS.md 3).
 * @param {{ authoring?: boolean }} [options] - whether the authoring pair is
 *   registered (the `exposeAgentTools` toggle).
 * @returns {() => void} disposer unregistering every registered tool (each
 *   off is the exact disposer tools.register returned — dsh
 *   packages/core/tools/src/index.ts:128).
 */
export function registerRosterTools(scope, service, deps, options = {}) {
  const offs = []
  const register = (tool) => offs.push(scope.tools.register(tool))
  const authoring = options.authoring !== false
  const store = deps?.store

  // ---- spawn (the single creation path, ADR-0011) ---------------------------
  register(defineTool({
    name: 'roster_spawn',
    description: 'Give a task to a team member of a configured role template, creating the member when the role has no idle one. The template carries the member\'s standing instruction and its models; pass the template id from the instruction that asked for this member, or its exact display name. Model tier — every new task starts on the base model; move to high only after one rework on the base model failed to pass, or when the task brief itself names the high tier. The tier follows the task, never the role. Do not restate the template yourself — the template text is used verbatim. Once nothing is left but waiting for members, end your turn: a member\'s completion notice starts your next turn, so do not poll with wait_agent.',
    parameters: {
      template: {
        type: 'string',
        required: true,
        description: 'Template id (preferred) or exact template name.',
      },
      task: {
        type: 'string',
        description: 'Optional one-off task for this member, taken from the current conversation (e.g. "review the payments module").',
      },
      tier: {
        type: 'string',
        enum: ['base', 'high'],
        description: 'Model tier for this task. Default base. high requires reason.',
      },
      reason: {
        type: 'string',
        description: 'One line stating the escalation basis (required with tier high).',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: false,
    async execute(args, exec) {
      try {
        const agent = exec?.agent
        if (agent === undefined || agent === null) {
          return 'roster_spawn failed: it requires a calling agent (this tool runs inside an agent only)'
        }
        if (store === undefined) throw new Error('roster store is unavailable')
        // A high dispatch is refused before anything is looked up or
        // spawned: the basis is checked first, so nothing runs unexplained.
        const reason = args?.tier === 'high' ? requireReason(args?.reason) : undefined
        const template = await resolveTemplateRef(store, args?.template)
        const result = await spawnFromTemplate(scope, deps, {
          agent,
          template,
          task: args?.task,
          // Omitted stays omitted: spawnFromTemplate defaults it to `base`.
          ...(args?.tier === undefined ? {} : { tier: args.tier }),
          signal: exec?.signal,
        })
        return bounded({
          name: result.name,
          template: template.name,
          tier: result.tier,
          reused: result.reused,
          model: result.model ?? 'inherited from the parent agent',
          ...(reason === undefined ? {} : { reason }),
        })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  if (!authoring) return () => { for (const off of offs) { try { off?.() } catch {} } }

  // ---- save (upsert by exact name) -----------------------------------------
  register(defineTool({
    name: 'roster_template_save',
    description: 'Create or update one roster role template (upsert by exact name: an existing template with the same name is updated in place, reusing its id). Omitted optional fields keep their stored values on update; default_model / high_tier_model null clears the stored model.',
    parameters: {
      name: { type: 'string', required: true, description: 'Template name, unique across the roster.' },
      description: { type: 'string', description: 'Short human-facing description. Omit to keep the stored value when updating.' },
      prompt: { type: 'string', required: true, description: 'The system prompt members spawned from this template run with.' },
      default_model: {
        description: 'Default (base tier) model for members spawned from this template. Omit to keep the stored value when updating; null clears it.',
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true, description: 'Provider id.' },
              model: { type: 'string', required: true, description: 'Model id within the provider.' },
              reasoning_effort: { type: 'string', description: 'Optional reasoning effort id.' },
            },
          },
          { type: 'null' },
        ],
      },
      high_tier_model: {
        description: 'High-tier model a member runs on when the lead escalates a task to tier high. Omit to keep the stored value when updating; null clears it.',
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true, description: 'Provider id.' },
              model: { type: 'string', required: true, description: 'Model id within the provider.' },
              reasoning_effort: { type: 'string', description: 'Optional reasoning effort id.' },
            },
          },
          { type: 'null' },
        ],
      },
      reuse: {
        type: 'string',
        enum: ['role', 'task'],
        description: 'What an idle member of this role is reused for: role (any task of this template, the default) or task (one task, then a new member per task). Omit to keep the stored value when updating.',
      },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      try {
        // Upsert-by-name: resolve through the service's own read (one
        // operation, two callers — no duplicated lookup logic) and reuse
        // the matched record's id; no match creates fresh.
        const existing = (await service.listTemplates()).find((rec) => rec.name === args.name)
        const saved = await service.saveTemplate({
          ...(existing === undefined ? {} : { id: existing.id }),
          name: args.name,
          description: args.description,
          prompt: args.prompt,
          defaultModel: toModelRef(args.default_model),
          ...(args.high_tier_model === undefined ? {} : { highTierModel: toModelRef(args.high_tier_model) }),
          ...(args.reuse === undefined ? {} : { reuse: args.reuse }),
        })
        return bounded({ id: saved.id, name: saved.name, updatedAt: saved.updatedAt })
      } catch (error) { return failure(error) }
    },
  }))

  // ---- list (prompt omitted) ------------------------------------------------
  register(defineTool({
    name: 'roster_template_list',
    description: "List the roster's role templates as { id, name, description, defaultModel, highTierModel, reuse, updatedAt } — prompt is deliberately omitted to keep context light. Read-only.",
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async () => {
      try {
        const records = await service.listTemplates()
        return bounded(records.map((rec) => ({
          id: rec.id,
          name: rec.name,
          description: rec.description,
          defaultModel: rec.defaultModel,
          highTierModel: rec.highTierModel,
          reuse: rec.reuse,
          updatedAt: rec.updatedAt,
        })))
      } catch (error) { return failure(error) }
    },
  }))

  return () => {
    for (const off of offs) {
      try { off() } catch { /* disposer of an already-torn-down fiber */ }
    }
  }
}
