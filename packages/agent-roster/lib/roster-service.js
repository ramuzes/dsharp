/**
 * Agent roster Remote service: the `agentRoster` Typert namespace the client
 * half (settings card, spawn modal) and later tasks call for template CRUD.
 *
 * TypertRemoteService precedent: chrome-cdp lib/status.js:15-40 — the class
 * extends TypertRemoteService from @deepseek-ai/dsh-typert-protocol (static
 * peer import; the package is declared as a peerDependency like chrome-cdp
 * and feishu-gateway do), and because decorator syntax is unavailable in
 * plain Node ESM the version-1 remote-methods descriptor is attached
 * manually below — the exact shape Remote() persists (protocol lib/index.js
 * mark(); same hand-attachment in feishu-gateway lib/diagnostics.js:53-67).
 *
 * Failures are RemoteError with stable `roster/`-prefixed codes consumers
 * switch on; messages are bilingual (en / zh) because they render in the UI
 * (modal error lines, settings card rows).
 */
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readString } from './wire.js'
import { ModelRef, RoleTemplate, freshId } from './store.js'
import { spawnFromRoster, teamStatusOf } from './spawn.js'
import { runDraft } from './drafter.js'

/** Prototype marker key the protocol reads (REMOTE_METHOD_DESCRIPTOR). */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export class AgentRosterService extends TypertRemoteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context; a
   *   genuine cordis Context, since the Service base registers with it (unit
   *   tests drive methods via Object.create(prototype), the feishu
   *   diagnostics.spec precedent).
   * @param {ReturnType<typeof import('./store.js').openRosterStore>} store
   */
  constructor(ctx, store) {
    super(ctx, 'agentRoster', { namespace: 'agentRoster' })
    this.store = store
  }

  /** Every stored template, insertion order. @Remote */
  async listTemplates() {
    return this.store.all()
  }

  /**
   * Create (no `id` → fresh id, timestamps set) or update one template.
   * Rejects a name already used by a different record (`roster/name-taken`)
   * and an unknown `id` (`roster/not-found`); `updatedAt` bumps on every
   * write while `id` and `createdAt` stay stable. Optional fields are
   * patch-semantics: omitted keys keep their stored values on update (an
   * explicit value — including `null` — always applies), so a caller that
   * sends only `prompt` does not silently reset `description`/`defaultModel`.
   * @param {{ id?: string, name: string, description?: string, prompt: string, defaultModel?: import('zod').z.infer<typeof ModelRef> | null }} input
   * @Remote
   */
  async saveTemplate(input) {
    // Wire inputs are plain JSON; readString's wrapper-tolerant coercion
    // doubles as the defensive string read (wrong type → '' → caught below).
    const name = readString(input?.name)
    const prompt = readString(input?.prompt)
    if (name === '') throw new RemoteError('roster/bad-request', 'name is required / name 不能为空', { field: 'name' })
    if (prompt === '') throw new RemoteError('roster/bad-request', 'prompt is required / prompt 不能为空', { field: 'prompt' })
    const id = readString(input?.id)
    const existing = id === '' ? undefined : await this.store.byId(id)
    if (id !== '' && existing === undefined) {
      throw new RemoteError('roster/not-found', `Template ${id} not found / 未找到模板 ${id}`, { id })
    }
    const targetId = existing?.id ?? freshId()
    const clash = await this.store.byName(name)
    if (clash !== undefined && clash.id !== targetId) {
      throw new RemoteError('roster/name-taken',
        `Template name "${name}" is already taken / 模板名称 "${name}" 已被占用`, { name })
    }
    const now = new Date().toISOString()
    let record
    try {
      record = RoleTemplate.parse({
        ...(existing ?? {}),
        name,
        description: input?.description === undefined ? existing?.description ?? '' : readString(input.description),
        prompt,
        defaultModel: input?.defaultModel === undefined ? existing?.defaultModel ?? null : input.defaultModel,
        id: targetId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
    } catch (error) {
      // Shape/length failures (name > 64, malformed defaultModel, …).
      const issues = error?.issues?.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      throw new RemoteError('roster/bad-request',
        `Template fields rejected / 模板字段不合法: ${issues?.map((i) => `${i.path}: ${i.message}`).join('; ') ?? String(error)}`,
        { issues })
    }
    await this.store.put(record)
    return record
  }

  /**
   * Delete one template by id.
   * @param {string} id
   * @returns {Promise<{ deleted: true }>} — `roster/not-found` otherwise.
   * @Remote
   */
  async deleteTemplate(id) {
    const key = readString(id)
    const removed = await this.store.delete(key)
    if (removed !== true) {
      throw new RemoteError('roster/not-found', `Template ${key} not found / 未找到模板 ${key}`, { id: key })
    }
    return { deleted: true }
  }

  /**
   * Spawn one roster member into the current session's subagent tree
   * (ADR-0008). The optional host services are resolved from the service's
   * ctx at CALL time through the sanctioned get() name lookup — the same
   * optional-service rule lib/store.js applies to storageDomain — so a host
   * without sessionController/subagents answers with typed
   * `roster/no-session-controller` / `roster/no-subagents` errors instead of
   * crashing. Semantics and citations live in lib/spawn.js.
   * @param {{ sessionId: string, templateId?: string, custom?: { name: string, description: string, prompt: string }, memberName?: string, model?: import('./store.js').ModelRef | null, task?: string }} input
   * @returns {Promise<{ name: string, childSessionId?: string }>}
   * @Remote
   */
  async spawnMember(input) {
    return spawnFromRoster(this.ctx, { store: this.store }, input)
  }

  /**
   * Report Team status for one session: `teamMode` (the selection shared by
   * its subagent tree), `isRoot`, and `canEnable = agentTeams present &&
   * isRoot` — enabling Team mode requires the root (agent-team
   * TEAM_LEAD_REQUIRED), so a member session can never offer it.
   * @param {{ sessionId: string }} input
   * @returns {Promise<{ teamMode: boolean, isRoot: boolean, canEnable: boolean }>}
   * @Remote
   */
  async teamStatus(input) {
    return teamStatusOf(this.ctx, {}, input)
  }

  /**
   * Draft one member definition with model assistance over the reusable
   * per-workspace draft session (ADR-0010). The result is a PROPOSAL: this
   * call never saves anything — the user reviews and saves (or drops) it in
   * the modal. Semantics, host-interface citations, and the timeout live in
   * lib/drafter.js.
   * @param {{ sessionId: string, brief: string, model?: import('./store.js').ModelRef | null }} input
   * @returns {Promise<{ name: string, description: string, prompt: string, parsed: boolean }>}
   * @Remote
   */
  async draft(input) {
    return runDraft(this.ctx, { store: this.store }, input)
  }
}

// Manual remote-method markers: decorator syntax is unavailable in plain
// Node ESM, so replicate the version-1 descriptor Remote() would write
// (chrome-cdp lib/status.js:31-40 pattern).
{
  const direct = Object.freeze({ kind: 'direct' })
  Object.defineProperty(AgentRosterService.prototype, REMOTE_METHODS, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        Object.freeze({ method: 'listTemplates', invocation: direct }),
        Object.freeze({ method: 'saveTemplate', invocation: direct }),
        Object.freeze({ method: 'deleteTemplate', invocation: direct }),
        Object.freeze({ method: 'spawnMember', invocation: direct }),
        Object.freeze({ method: 'teamStatus', invocation: direct }),
        Object.freeze({ method: 'draft', invocation: direct }),
      ]),
    }),
  })
}
