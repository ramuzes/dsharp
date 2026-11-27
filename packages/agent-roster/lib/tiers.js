/**
 * Model tiers (ADR-0013): the lead names a tier — `base` or `high` — and the
 * plugin resolves it from the template's stored models, so the agent can no
 * longer pick an arbitrary route or inherit its own. The user's per-spawn
 * choice in the "+" dialog (an explicit model object, or `null` for inherit)
 * is unchanged; it is classified against the stored models so reuse (ADR-0013)
 * can key a member by route regardless of who chose it.
 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ModelRef } from './store.js'
import { parseModelChoice } from './spawn.js'
import { readString } from './wire.js'

/** The tiers a lead may request, weakest first. */
export const TIERS = Object.freeze(['base', 'high'])

/** An absent reasoning effort and an empty one name the same route. */
const effortOf = (model) => (typeof model?.reasoningEffort === 'string' ? model.reasoningEffort : '')

/**
 * A stored model as a usable route, or null. Stored data is defensive (it can
 * predate a schema change): an absent ref, or one with an empty provider or
 * model, is schema-legal but not a route a child could run on, so it degrades
 * to "inherit" instead of failing the spawn.
 * @param {unknown} value - stored `{ provider, model, reasoningEffort? }` or null.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null}
 */
export function usableModel(value) {
  if (value === null || value === undefined) return null
  const parsed = ModelRef.safeParse(value)
  if (!parsed.success || parsed.data.provider === '' || parsed.data.model === '') return null
  return parsed.data
}

/**
 * Whether two routes are the same model: exact on provider, model and effort.
 * @param {object | null} a
 * @param {object | null} b
 * @returns {boolean}
 */
export function sameModel(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return (a === null || a === undefined) && (b === null || b === undefined)
  return a.provider === b.provider && a.model === b.model && effortOf(a) === effortOf(b)
}

/**
 * Resolve the route one member runs on.
 *
 * Precedence: an explicit `model` — the dialog path — wins and is REFUSED when
 * invalid (the user asked for one particular route); `null` inherits the
 * parent's route. Its tier is `high` or `base` when it equals that stored
 * model, else `custom`; inherit is the `base` tier, so a dialog member and a
 * base member of a model-less template share one route. Otherwise the
 * requested `tier` (default `base`) selects the stored model; `base` on a
 * template without one inherits, while `high` without a usable high-tier
 * model is refused — the lead asked to escalate and must learn it did not.
 *
 * @param {{ id: string, name: string, defaultModel?: unknown, highTierModel?: unknown }} template
 * @param {{ tier?: unknown, model?: unknown }} [choice]
 * @returns {{ model: object | null, tier: 'base' | 'high' | 'custom' }}
 * @throws {RemoteError} `roster/bad-request` (unknown tier, invalid model),
 *   `roster/no-high-tier-model`.
 */
export function resolveMemberModel(template, { tier, model } = {}) {
  const base = usableModel(template.defaultModel)
  const high = usableModel(template.highTierModel)
  if (model === null) return { model: null, tier: 'base' }
  if (model !== undefined) {
    const explicit = parseModelChoice(model)
    return { model: explicit, tier: sameModel(explicit, high) ? 'high' : sameModel(explicit, base) ? 'base' : 'custom' }
  }
  if (tier === undefined) tier = 'base'
  if (!TIERS.includes(tier)) {
    throw new RemoteError('roster/bad-request', `tier must be one of ${TIERS.join(', ')} / tier 只能是 ${TIERS.join(', ')}`, { field: 'tier', tier })
  }
  if (tier === 'high') {
    if (high === null) {
      throw new RemoteError('roster/no-high-tier-model',
        `Template "${readString(template.name)}" has no high-tier model; add one in Settings or use the base tier / 模板「${readString(template.name)}」未配置高阶模型，请在设置中添加或改用 base 档位`,
        { template: template.id })
    }
    return { model: high, tier: 'high' }
  }
  return { model: base, tier: 'base' }
}

/**
 * The lead's basis for a `high` dispatch, trimmed. Required: every escalation
 * must be explainable against the plan.
 * @param {unknown} reason
 * @returns {string} the non-empty reason.
 * @throws {RemoteError} `roster/bad-request` when blank.
 */
export function requireReason(reason) {
  const trimmed = readString(reason).trim()
  if (trimmed === '') {
    throw new RemoteError('roster/bad-request',
      'reason is required with tier "high" — state the escalation basis / 使用 high 档位必须填写理由', { field: 'reason' })
  }
  return trimmed
}
