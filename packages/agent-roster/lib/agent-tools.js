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
 * values (service patch semantics), default_model null clears them.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
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
 * Map the tool-facing default_model parameter to the service's ModelRef key
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
 *   saveTemplate(input: { id?: string, name: string, description?: string, prompt: string, defaultModel?: import('./store.js').ModelRef | null }): Promise<import('./store.js').RoleTemplate>,
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
    description: 'Create one team member from a configured role template. The template carries the member\'s standing instruction (its responsibility boundary and main goal) and an optional model; pass the template id from the instruction that asked for this member, or its exact display name. The optional task points this member at the current work. Returns the created member\'s name. Do not restate the template yourself — the template text is used verbatim.',
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
      model: {
        description: 'Model for this member only, overriding the template default. Pass exactly the object the instruction gave; null makes the member inherit the session model. Omit only when the instruction gives no model.',
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
        const template = await resolveTemplateRef(store, args?.template)
        const result = await spawnFromTemplate(scope, deps, {
          agent,
          template,
          task: args?.task,
          // `undefined` (omitted) must stay omitted: it means "keep the
          // template default", while `null` means "inherit the session model".
          ...(args?.model === undefined ? {} : { model: toModelRef(args.model) }),
          signal: exec?.signal,
        })
        return bounded({
          created: result.name,
          template: template.name,
          model: result.model ?? 'inherited from the parent agent',
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
    description: 'Create or update one roster role template (upsert by exact name: an existing template with the same name is updated in place, reusing its id). Omitted optional fields keep their stored values on update; default_model null clears the stored model.',
    parameters: {
      name: { type: 'string', required: true, description: 'Template name, unique across the roster.' },
      description: { type: 'string', description: 'Short human-facing description. Omit to keep the stored value when updating.' },
      prompt: { type: 'string', required: true, description: 'The system prompt members spawned from this template run with.' },
      default_model: {
        description: 'Default model for members spawned from this template. Omit to keep the stored value when updating; null clears it.',
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
        })
        return bounded({ id: saved.id, name: saved.name, updatedAt: saved.updatedAt })
      } catch (error) { return failure(error) }
    },
  }))

  // ---- list (prompt omitted) ------------------------------------------------
  register(defineTool({
    name: 'roster_template_list',
    description: "List the roster's role templates as { id, name, description, defaultModel, updatedAt } — prompt is deliberately omitted to keep context light. Read-only.",
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
