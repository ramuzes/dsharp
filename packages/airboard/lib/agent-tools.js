/**
 * Agent-facing AirBoard tools + their prompt section.
 *
 * Five tools over the service's published read/write contract: discovery
 * (search, list projects), full reads, and durable authoring (create draft,
 * update content/status). The token stays Host-side (see lib/agent-api.js);
 * failures surface as plain text naming the AirboardError code.
 *
 * Registration follows the standard tool-plugin shape
 * (packages/experimental/tool-session-query/src/index.ts): ctx.tools.register
 * with defineTool, plus one concise system-prompt section — the tools'
 * descriptions stay on the tools, the section only says what AirBoard IS and
 * when to reach for it.
 */
// Resolution note: in-profile this resolves to the plugin's own node_modules copy
// (installed for tests); the HOST supplies its own via the loader.
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plain-text tool output (session-query's TEXT_OUTPUT shape). */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

const KINDS = ['ADR', 'PRD', 'SPEC', 'PLAN', 'ISSUE']
const STATUSES = ['draft', 'active', 'done', 'cancelled']

/** Bounded search: the model can page with offset, not dump the index. */
const SEARCH_LIMIT_DEFAULT = 10
const SEARCH_LIMIT_MAX = 50

export const AIRBOARD_PROMPT_TEXT =
  'AirBoard is the project knowledge base: durable ADR / PRD / SPEC / PLAN / ISSUE documents, '
  + 'each with a draft → active → done/cancelled lifecycle and per-project ids like ADR-42. '
  + 'Before designing or deciding, airboard_search prior decisions and specs; airboard_read_resource for full content. '
  + 'Persist durable outcomes with airboard_create_resource (new resources start as draft), and revise content '
  + '(each update appends a revision) or transition status with airboard_update_resource. '
  + 'airboard_list_projects lists the project keys every other tool addresses.'

/** Map one tool failure to model-facing text; never rethrow into the host. */
function failure(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return `AirBoard request timed out or was cancelled (${String(error?.message ?? error)}).`
  }
  const code = error?.code ?? 'airboard/unreachable'
  return `AirBoard call failed (${code}${error?.status !== undefined ? ` HTTP ${error.status}` : ''}): ${error?.message ?? String(error)}`
}

/**
 * Register the five tools and the prompt section on a context that carries
 * `tools` and `systemPrompt`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ get: Function, post: Function, patch: Function }} client - AirBoard JSON client.
 * @returns {() => void} disposer removing the section and all five tools.
 */
export function registerAgentTools(ctx, client) {
  const offs = []
  offs.push(ctx.systemPrompt.section({
    name: 'tool:airboard',
    // Fixed slot after TOOL_SESSION_QUERY (2300), before TOOL_GOAL (2400):
    // third-party plugins cannot add names to the core order registry.
    order: 2350,
    text: AIRBOARD_PROMPT_TEXT,
  }))

  const register = (tool) => offs.push(ctx.tools.register(tool))

  register(defineTool({
    name: 'airboard_search',
    description: 'Full-text search across every AirBoard project. Returns slim hits '
      + '(id like ADR-42, kind, project_key, title, status, snippet, relevance score) ordered best-first; '
      + 'follow a hit with airboard_read_resource for the full document.',
    parameters: {
      q: { type: 'string', required: true, description: 'FTS query: bare terms (implicit AND), "quoted phrases", term OR term, prefix*. Substring matching works incl. CJK.' },
      kind: { type: 'string', enum: KINDS, description: 'Restrict to one resource kind.' },
      status: { type: 'string', enum: STATUSES, description: 'Restrict to one lifecycle state.' },
      project_key: { type: 'string', description: 'Restrict to one project.' },
      limit: { type: 'integer', description: `Hits per page (default ${SEARCH_LIMIT_DEFAULT}, capped at ${SEARCH_LIMIT_MAX}).` },
      offset: { type: 'integer', description: 'Pagination offset (default 0).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const hits = await client.get('/api/search', {
          q: args.q, kind: args.kind, status: args.status, project_key: args.project_key,
          limit: Math.min(Number(args.limit) || SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX),
          offset: Math.max(Number(args.offset) || 0, 0),
        }, exec?.signal)
        return JSON.stringify(hits)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'airboard_read_resource',
    description: 'Read one resource\'s full markdown content, title, and status.',
    parameters: {
      project_key: { type: 'string', required: true, description: 'Project key (see airboard_list_projects).' },
      id: { type: 'string', required: true, description: 'Resource id, e.g. ADR-42.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const r = await client.get(`/api/projects/${encodeURIComponent(args.project_key)}/resources/${encodeURIComponent(args.id)}`, undefined, exec?.signal)
        return `${r.title ?? r.id} [${r.id} · ${r.status ?? '?'}]\n\n${r.content_markdown ?? ''}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'airboard_list_projects',
    description: 'List AirBoard projects (key, name). Every other airboard tool addresses resources by project key.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      try {
        const projects = await client.get('/api/projects', undefined, exec?.signal)
        return JSON.stringify(projects.map(p => ({ key: p.key, name: p.name })))
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'airboard_create_resource',
    description: 'Create a new resource in a project. The server allocates the id (KIND-number) and the resource starts as draft.',
    parameters: {
      project_key: { type: 'string', required: true, description: 'Project key.' },
      kind: { type: 'string', required: true, enum: KINDS, description: 'Document kind.' },
      title: { type: 'string', required: true, description: 'Document title (minLength 1).' },
      markdown: { type: 'string', required: true, description: 'Full markdown body.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const created = await client.post(`/api/projects/${encodeURIComponent(args.project_key)}/resources`,
          { kind: args.kind, title: args.title, markdown: args.markdown }, exec?.signal)
        return `Created ${created?.id ?? '?'} (status ${created?.status ?? 'draft'}) in ${args.project_key}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'airboard_update_resource',
    description: 'Revise one resource: update the markdown body (appends a revision), retitle, or transition status '
      + '(draft → active/cancelled; active → done/cancelled).',
    parameters: {
      project_key: { type: 'string', required: true, description: 'Project key.' },
      id: { type: 'string', required: true, description: 'Resource id, e.g. SPEC-7.' },
      title: { type: 'string', description: 'New title (omit to keep).' },
      markdown: { type: 'string', description: 'Replacement markdown body (omit to keep; updating appends a revision).' },
      status: { type: 'string', enum: STATUSES, description: 'Lifecycle transition to apply.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const body = {}
      if (args.title !== undefined) body.title = args.title
      if (args.markdown !== undefined) body.content_markdown = args.markdown
      if (args.status !== undefined) body.status = args.status
      if (Object.keys(body).length === 0) {
        return 'Nothing to update: provide at least one of title, markdown, status.'
      }
      try {
        const updated = await client.patch(`/api/projects/${encodeURIComponent(args.project_key)}/resources/${encodeURIComponent(args.id)}`, body, exec?.signal)
        return `Updated ${updated?.id ?? args.id} (status ${updated?.status ?? '?'})`
      } catch (error) { return failure(error) }
    },
  }))

  return () => { for (const off of offs.reverse()) off() }
}
