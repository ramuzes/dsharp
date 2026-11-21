/**
 * Agent-facing engram tools + their prompt section (Task 5).
 *
 * Seven curated memory tools over the engram daemon (lib/engram-api.js),
 * mirroring packages/gitlab/lib/agent-tools.js structure: defineTool from
 * '@deepseek-ai/dsh-tools', TEXT_OUTPUT-style plain-text output, a `register`
 * helper pushing disposers, and a `failure()` mapper that never rethrows a
 * raw error into the host. Read-only tools declare isConcurrencySafe; the
 * mutating engram_save does not.
 *
 * Every execute flow: ensureReady() -> resolveProject(session, explicit) ->
 * client call -> bounded output (JSON trimmed at 8000 chars). engram_save
 * additionally registers the session via deps.ensureSession, retrying once
 * before surfacing the failure (daemon stewardship can re-create it).
 *
 * The prompt section carries the save-worthiness policy from the spec:
 * what is durable (decisions + rationale, preferences and constraints,
 * costly environment facts, investigation conclusions, corrections) and
 * what is not (transient state, re-derivable content, conversation echo,
 * secrets never), plus search-before-saving discipline and the automatic
 * project resolution contract.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { EngramError } from './engram-api.js'
import { ProjectAmbiguousError, ProjectExplicitRequiredError } from './project-resolution.js'

/** Plain-text tool output (session-query's TEXT_OUTPUT shape). */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** Output bound: JSON.stringify payload truncated here + a visible marker. */
const MAX_OUTPUT_CHARS = 8000
const TRUNCATION_MARKER = '…[truncated]'

/** Clamp a limit param: default 20, bounded to [1, 50]. */
function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 20
  return Math.min(50, Math.max(1, Math.trunc(n)))
}

/** Bounded tool output: trimmed JSON, truncated with a visible marker. */
function bounded(payload) {
  const text = JSON.stringify(payload)
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_MARKER
}

export const ENGRAM_PROMPT_TEXT =
  'Memory tools (engram_*): durable agent memory served by the engram daemon, Host-side, so no bash or CLI is involved — never run the engram CLI in bash (the session sandbox blocks it). '
  + 'Project resolution is automatic from the session\'s working directory; pass `project` only after an ambiguity error listed the options. '
  + 'Worth saving: decisions and their rationale, user preferences and constraints, costly-to-learn environment facts, investigation conclusions, and corrections superseding earlier memories. '
  + 'Not worth saving: transient state, content re-derivable from the repo, conversation echo — and secrets never. '
  + 'Discipline: search before saving to avoid near-duplicates; when a new observation contradicts a prior one, save the correction referencing the earlier observation (update/conflict tools arrive in v2).'

/** Map one tool failure to model-facing text; never rethrow into the host. */
function failure(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return `engram request timed out or was cancelled (${String(error?.message ?? error)}).`
  }
  if (error instanceof ProjectAmbiguousError || error?.name === 'ProjectAmbiguousError') {
    const available = Array.isArray(error.available) ? error.available.join(', ') : ''
    return `engram project is ambiguous for this working directory (candidates: ${available}). `
      + 'Retry with an explicit `project` parameter set to one of the listed options.'
  }
  if (error instanceof ProjectExplicitRequiredError || error?.name === 'ProjectExplicitRequiredError') {
    return `${error.message}. Set an explicit project in the plugin configuration (project map or fixed project).`
  }
  if (error instanceof EngramError) {
    return `${error.code}${error.status !== undefined ? ` HTTP ${error.status}` : ''}: ${error.message}`
  }
  return `engram call failed: ${error?.message ?? String(error)}`
}

/**
 * Register the tools and the prompt section.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with tools+systemPrompt injected.
 * @param {{
 *   client: { get(path: string, query?: object, signal?: AbortSignal): Promise<any>,
 *             post(path: string, body?: unknown, signal?: AbortSignal): Promise<any> },
 *   resolveProject: (session: object|undefined, explicit?: string) => Promise<{ project: string, source: string }>,
 *   ensureReady: () => Promise<void>,
 *   ensureSession: (exec?: object) => Promise<void>,
 *   sessionIdOf?: (agent?: object) => string,
 * }} deps
 * @returns {() => void} disposer removing the section and all tools.
 */
export function registerAgentTools(ctx, deps) {
  const ensureReady = deps.ensureReady
  const ensureSession = deps.ensureSession
  const sessionIdOf = deps.sessionIdOf ?? ((agent) => agent?.session?.id ?? '')

  const offs = []
  offs.push(ctx.systemPrompt.section({
    name: 'tool:engram',
    order: 2370, // after gitlab (2360), before TOOL_GOAL (2400)
    text: ENGRAM_PROMPT_TEXT,
  }))

  const register = (tool) => offs.push(ctx.tools.register(tool))

  /** Shared prologue: daemon readiness + per-session project resolution. */
  const resolve = async (exec, explicit) => {
    await ensureReady()
    return deps.resolveProject(exec?.agent?.session, explicit)
  }

  /** Save-only: register the session, retrying stewardship once. */
  const registerSessionWithRetry = async (exec) => {
    try {
      await ensureSession(exec)
    } catch (first) {
      try {
        await ensureSession(exec)
      } catch (second) {
        throw new Error(`session registration failed twice (last error: ${second?.message ?? second})`)
      }
      void first
    }
  }

  // ---- search --------------------------------------------------------------
  register(defineTool({
    name: 'engram_search',
    description: 'Search durable engram memory (observations). Read-only; search before saving to avoid near-duplicates.',
    parameters: {
      q: { type: 'string', required: true, description: 'Free-text query.' },
      type: { type: 'string', description: 'Observation type filter.' },
      scope: { type: 'string', description: 'Observation scope filter.' },
      limit: { type: 'number', description: 'Max results (default 20, max 50).' },
      all_projects: { type: 'boolean', description: 'Search across all projects instead of the resolved one.' },
      project: { type: 'string', description: 'Explicit engram project; pass only after an ambiguity error listed the options.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const { project } = await resolve(exec, args.project)
        const query = {
          q: args.q,
          type: args.type,
          scope: args.scope,
          limit: clampLimit(args.limit),
          all_projects: args.all_projects,
          project: args.all_projects ? undefined : project,
        }
        return bounded(await deps.client.get('/search', query, exec?.signal))
      } catch (error) { return failure(error) }
    },
  }))

  // ---- save ----------------------------------------------------------------
  register(defineTool({
    name: 'engram_save',
    description: 'Save a durable observation to engram memory. Save only durable knowledge — decisions and their rationale, user preferences and constraints, costly-to-learn environment facts, investigation conclusions, corrections superseding earlier memories; not transient state, not re-derivable content, not conversation echo, and secrets never. Search first; cite the contradicted prior observation when correcting.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short observation title.' },
      content: { type: 'string', required: true, description: 'Observation body.' },
      type: { type: 'string', description: 'Observation type (e.g. decision, preference, fact).' },
      project: { type: 'string', description: 'Explicit engram project; pass only after an ambiguity error listed the options.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const { project } = await resolve(exec, args.project)
        await registerSessionWithRetry(exec)
        const body = {
          session_id: sessionIdOf(exec?.agent),
          title: args.title,
          content: args.content,
          type: args.type,
          project,
          operation_id: exec?.callId,
        }
        return bounded(await deps.client.post('/observations', body, exec?.signal))
      } catch (error) { return failure(error) }
    },
  }))

  // ---- context ---------------------------------------------------------------
  register(defineTool({
    name: 'engram_context',
    description: 'Read the assembled memory context for the resolved project. Read-only.',
    parameters: {
      compact: { type: 'boolean', description: 'Compact form (default true).' },
      max_bytes: { type: 'number', description: 'Size cap for the returned context.' },
      project: { type: 'string', description: 'Explicit engram project; pass only after an ambiguity error listed the options.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const { project } = await resolve(exec, args.project)
        return bounded(await deps.client.get('/context', {
          compact: args.compact,
          max_bytes: args.max_bytes,
          project,
        }, exec?.signal))
      } catch (error) { return failure(error) }
    },
  }))

  // ---- timeline --------------------------------------------------------------
  register(defineTool({
    name: 'engram_timeline',
    description: 'Read observations around one observation id (before/after neighbors). Read-only.',
    parameters: {
      observation_id: { type: 'string', required: true, description: 'Anchor observation id.' },
      before: { type: 'number', description: 'How many observations before the anchor.' },
      after: { type: 'number', description: 'How many observations after the anchor.' },
      project: { type: 'string', description: 'Explicit engram project; pass only after an ambiguity error listed the options.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const { project } = await resolve(exec, args.project)
        return bounded(await deps.client.get('/timeline', {
          observation_id: args.observation_id,
          before: args.before,
          after: args.after,
          project,
        }, exec?.signal))
      } catch (error) { return failure(error) }
    },
  }))

  // ---- stats -----------------------------------------------------------------
  register(defineTool({
    name: 'engram_stats',
    description: 'Read memory statistics for the resolved project (or all projects). Read-only.',
    parameters: {
      all_projects: { type: 'boolean', description: 'Aggregate across all projects.' },
      project: { type: 'string', description: 'Explicit engram project; pass only after an ambiguity error listed the options.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const { project } = await resolve(exec, args.project)
        return bounded(await deps.client.get('/stats', {
          all_projects: args.all_projects,
          project,
        }, exec?.signal))
      } catch (error) { return failure(error) }
    },
  }))

  // ---- projects ----------------------------------------------------------------
  register(defineTool({
    name: 'engram_projects',
    description: 'List the engram projects known to the daemon. Read-only.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      try {
        await ensureReady()
        return bounded(await deps.client.get('/projects', undefined, exec?.signal))
      } catch (error) { return failure(error) }
    },
  }))

  // ---- sync status ----------------------------------------------------------
  register(defineTool({
    name: 'engram_cloud_status',
    description: 'Read the cloud-sync status for the resolved project. Read-only.',
    parameters: {
      project: { type: 'string', description: 'Explicit engram project; pass only after an ambiguity error listed the options.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const { project } = await resolve(exec, args.project)
        return bounded(await deps.client.get('/sync/status', { project }, exec?.signal))
      } catch (error) { return failure(error) }
    },
  }))

  return () => {
    for (const off of offs) {
      try { off() } catch { /* disposer of an already-torn-down fiber */ }
    }
  }
}
