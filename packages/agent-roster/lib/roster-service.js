/**
 * Agent roster Remote service: the `agentRoster` Typert namespace the client
 * half (the Settings roster manager) calls for template CRUD. Member creation
 * is NOT here: it is the `roster_spawn` agent tool (ADR-0011), so the remote
 * surface stays read/write-only on templates.
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
import { parseModelChoice, resolveTemplateRef } from './spawn.js'
import { nonEmptyModel, usableModel } from './tiers.js'

/**
 * Refusal message of the WRITE schema's model refines. The rule itself is
 * stated once (`nonEmptyModel`, lib/tiers.js) and shared with `usableModel`,
 * which applies it when READing stored data (an unusable ref degrades to
 * inherit); here it is a refusal. Each field carries its own refine, so a
 * refused issue still names the offending field.
 */
const MODEL_PARTS_MESSAGE = 'provider and model must be non-empty'

/**
 * The WRITE schema: the stored record shape plus the rule that a default model
 * is a usable route — empty provider or model parts are refused here, where
 * both callers (the Settings editor and roster_template_save) meet, instead of
 * being stored and refused only at spawn time. Deliberately stricter than the
 * READ schema (`RoleTemplate`): a record written before this rule must still
 * load, and one bad record must never take the whole roster listing down.
 */
const RoleTemplateInput = RoleTemplate.extend({
  defaultModel: ModelRef.refine(nonEmptyModel, MODEL_PARTS_MESSAGE).nullable().default(null),
  highTierModel: ModelRef.refine(nonEmptyModel, MODEL_PARTS_MESSAGE).nullable().default(null),
})

/** Prototype marker key the protocol reads (REMOTE_METHOD_DESCRIPTOR). */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export class AgentRosterService extends TypertRemoteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context; a
   *   genuine cordis Context, since the Service base registers with it (unit
   *   tests drive methods via Object.create(prototype), the feishu
   *   diagnostics.spec precedent).
   * @param {ReturnType<typeof import('./store.js').openRosterStore>} store
   * @param {ReturnType<typeof import('./staging.js').createStaging>} staging - the
   *   dialog's one-shot member requests, consumed by the `/roster` command.
   */
  constructor(ctx, store, staging) {
    super(ctx, 'agentRoster', { namespace: 'agentRoster' })
    this.store = store
    this.staging = staging
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
   * The tier fields follow the same rule. One pair-level rule is enforced on
   * the EFFECTIVE values after the merge: a high-tier model needs a usable
   * base model (`roster/bad-request`, field `highTierModel`), so the high
   * tier is always an escalation FROM a configured route — never off the
   * inherited parent model.
   * @param {{ id?: string, name: string, description?: string, prompt: string, defaultModel?: import('zod').z.infer<typeof ModelRef> | null, highTierModel?: import('zod').z.infer<typeof ModelRef> | null, reuse?: 'role' | 'task' }} input
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
    // Patch semantics: an omitted key keeps the stored value, an explicit
    // value (null included) always applies — same as defaultModel.
    const highTierModel = input?.highTierModel === undefined ? existing?.highTierModel ?? null : input.highTierModel
    const defaultModel = input?.defaultModel === undefined ? existing?.defaultModel ?? null : input.defaultModel
    // usableModel is the spawn's own "is this a route" read (lib/tiers.js):
    // a legacy record whose stored base has empty parts counts as no base.
    if (usableModel(highTierModel) !== null && usableModel(defaultModel) === null) {
      throw new RemoteError('roster/bad-request',
        'a high-tier model requires a base model / 配置高阶模型前请先配置基础模型', { field: 'highTierModel' })
    }
    let record
    try {
      record = RoleTemplateInput.parse({
        ...(existing ?? {}),
        name,
        description: input?.description === undefined ? existing?.description ?? '' : readString(input.description),
        prompt,
        defaultModel,
        highTierModel,
        reuse: input?.reuse === undefined ? existing?.reuse ?? 'role' : input.reuse,
        id: targetId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
    } catch (error) {
      // Shape/length failures (name > 64, malformed defaultModel or
      // highTierModel, reuse outside the enum, …).
      const issues = error?.issues?.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      throw new RemoteError('roster/bad-request',
        `Template fields rejected / 模板字段不合法: ${issues?.map((i) => `${i.path}: ${i.message}`).join('; ') ?? String(error)}`,
        { issues })
    }
    await this.store.put(record)
    return record
  }

  /**
   * The newest high-tier dispatch records (template, member, reason), as the
   * Settings card lists them: a fixed 50-row window straight from the store
   * log, which already returns newest first.
   * @returns {Promise<import('./store.js').HighTierUse[]>}
   * @Remote
   */
  async listHighTierUse() {
    return this.store.log.list(50)
  }

  /**
   * Stage the "+" dialog's member request for one session (ADR-0012). The
   * `/roster` command takes it from here; nothing is spawned through this
   * Remote. The template is resolved NOW, so an unknown one fails in the
   * dialog instead of inside the command node, and the model is validated by
   * the same rule the spawn applies.
   * @param {{ sessionId: string, templateId: string, model?: import('./store.js').ModelRef | null, task?: string }} input
   * @returns {Promise<{ staged: true }>}
   * @Remote
   */
  async stageSpawn(input) {
    const sessionId = readString(input?.sessionId)
    const templateRef = readString(input?.templateId).trim()
    if (sessionId === '' || templateRef === '') {
      throw new RemoteError('roster/bad-request',
        'sessionId and templateId are required / sessionId 与 templateId 不能为空', { field: 'sessionId, templateId' })
    }
    const model = input?.model === undefined || input?.model === null ? null : parseModelChoice(input.model)
    await resolveTemplateRef(this.store, templateRef)
    this.staging.put(sessionId, { templateRef, model, task: readString(input?.task).trim() })
    return { staged: true }
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
        Object.freeze({ method: 'stageSpawn', invocation: direct }),
        Object.freeze({ method: 'listHighTierUse', invocation: direct }),
      ]),
    }),
  })
}
