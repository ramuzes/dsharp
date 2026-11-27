/**
 * Resident members (ADR-0013): the lead's registry of the members it created,
 * and the lookup that hands a role's next task to a member already standing by
 * instead of starting another one.
 *
 * A member is reusable when it was created from the same template, on the same
 * model route, in the same tree, and the subagent runtime lists it as an idle
 * child. The runtime is the authority on liveness: `listDescendants(rootId)`
 * rows are `{ kind: 'child', id, activity: 'running' | 'inactive', … }` or
 * `{ kind: 'diagnostic', id, reason }` (dsh
 * packages/subagent/subagent/src/control-types.ts), and only an `inactive`
 * child qualifies — a busy member must not be interrupted, and a diagnostic
 * row names a member that cannot be reached.
 */
import { readString } from './wire.js'

/**
 * The registry key of a member's model route: `inherit` is one route, any
 * other is `provider/model@effort`. Two members of one template share a key
 * when they run the same way, whatever tier selection produced it.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null | undefined} model
 * @returns {string}
 */
export function modelKeyOf(model) {
  if (model === null || model === undefined) return 'inherit'
  return `${model.provider}/${model.model}@${model.reasoningEffort ?? ''}`
}

/**
 * An in-memory registry of created members, scoped to the tree root that
 * created them: one tree's lead never reaches another tree's members. Child
 * ids keep insertion order per (root, template, model key).
 * @returns {{
 *   remember(rootId: string, childId: string, entry: { templateId: string, modelKey: string, name: string, tier: string }): void,
 *   candidates(rootId: string, templateId: string, modelKey: string): string[],
 *   entryOf(rootId: string, childId: string): { templateId: string, modelKey: string, name: string, tier: string } | undefined,
 * }}
 */
export function createMemberRegistry() {
  /** @type {Map<string, Map<string, Map<string, Map<string, { templateId: string, modelKey: string, name: string, tier: string }>>>>} */
  const members = new Map()
  const bucketOf = (rootId, templateId, modelKey) => {
    let root = members.get(rootId)
    if (root === undefined) members.set(rootId, (root = new Map()))
    let template = root.get(templateId)
    if (template === undefined) root.set(templateId, (template = new Map()))
    let bucket = template.get(modelKey)
    if (bucket === undefined) template.set(modelKey, (bucket = new Map()))
    return bucket
  }
  return {
    remember(rootId, childId, entry) {
      bucketOf(rootId, entry.templateId, entry.modelKey).set(childId, entry)
    },
    candidates(rootId, templateId, modelKey) {
      return [...(members.get(rootId)?.get(templateId)?.get(modelKey)?.keys() ?? [])]
    },
    entryOf(rootId, childId) {
      for (const bucket of members.get(rootId)?.values() ?? []) {
        for (const entries of bucket.values()) {
          if (entries.has(childId)) return entries.get(childId)
        }
      }
      return undefined
    },
  }
}

/**
 * The message a standby member receives with its next task — the reuse
 * counterpart of `assembleMemberOpening` (lib/spawn.js): the role is already
 * in place, so only the work is new. The task is passed verbatim and trimmed.
 * @param {unknown} task - the task assigned by the lead.
 * @returns {string}
 */
export function assembleTaskMessage(task) {
  return 'A new task from the lead of your team. Your standing role is unchanged; this task is what to do now:\n\n' + readString(task).trim()
}

/**
 * The first member registered for (root, template, model route) that the
 * runtime lists as an idle child — or null when none stands by.
 * @param {{ subagents: object, registry: ReturnType<createMemberRegistry>, rootId: string, templateId: string, modelKey: string }} query
 *   - the subagents runtime, the lead's member registry, and the tree root,
 *     template and model route to reuse under.
 * @returns {Promise<{ childId: string, name: string } | null>}
 */
export async function findIdleMember({ subagents, registry, rootId, templateId, modelKey }) {
  const candidates = registry.candidates(rootId, templateId, modelKey)
  if (candidates.length === 0) return null
  const idle = new Set(
    (await subagents.listDescendants(rootId))
      .filter((entry) => entry?.kind === 'child' && entry.activity === 'inactive')
      .map((entry) => entry.id),
  )
  // Insertion order: the longest-standing member is offered first.
  for (const childId of candidates) {
    if (idle.has(childId)) return { childId, name: registry.entryOf(rootId, childId)?.name }
  }
  return null
}
