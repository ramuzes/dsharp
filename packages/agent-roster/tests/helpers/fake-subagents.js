/**
 * The strict fake subagents runtime shared by the spec files (spawn,
 * command): ONE definition, so a looser copy can never drift in beside it.
 * AGENTS.md §1: a fake more forgiving than the real interface makes the
 * suite lie.
 *
 * `startActivation` fake mirrors SubagentRuntime.startActivation (dsh
 * packages/subagent/subagent/src/index.ts:274-299): requires a registered
 * provider name, the EXACT live parent agent, a text ContentBlock[] prompt,
 * an AbortSignal, and a 'parent'|'caller' delivery; it also reserves the
 * requested name like the real sibling-name reservation
 * (packages/subagent/subagent/src/names.ts SiblingNameReservations.reserve:
 * 1–32 lower-case letters/digits/hyphens starting with a letter, other than
 * `lead`, unique among the creator's children — duplicate → error), and
 * returns the full SubagentActivation shape (childId, name, messageId,
 * result, dispose).
 * - `sendMessage` fake mirrors SubagentManager.sendMessage (manager.ts:568):
 *   the exact live root as sender, a text ContentBlock[], and `options.signal`
 *   dereferenced first; it records the call and returns a message id.
 * - `rootOf` fake throws for an unknown caller, mirroring "when the caller or
 *   its runtime owner is unavailable" (subagent src/index.ts:296-302).
 */
/** The in-process provider's default registry name (spawn-in-process Config). */
export const SPAWN = 'spawn'

/** The root agent's reserved name (subagent src/names.ts ROOT_AGENT_NAME). */
export const LEAD = 'lead'

/** Name grammar the runtime enforces (names.ts NAME_PATTERN + ROOT_AGENT_NAME). */
export const isValidChildName = (value) => /^[a-z][a-z0-9-]{0,31}$/u.test(value) && value !== LEAD

/**
 * Fake subagents runtime. `children` mirrors listDescendants rows
 * (SubagentDescendantListEntry: kind/id/activity/parentId/depth/path —
 * control-types.ts:42-47 + list-children.ts:17-24); depth-1 `path`s are the
 * root's direct-child names. `startActivation` records every spec and applies
 * the real admission strictness (see file header).
 */
export function fakeSubagents({ root, known = [root], children = [], activations = [], messages = [], activityOf, childIdOf }) {
  // Default: a created member stands by (inactive) until something wakes it.
  const activity = activityOf ?? ((childId) => (children.some((entry) => entry.id === childId) ? 'inactive' : undefined))
  const idOf = childIdOf ?? ((ordinal) => `cs-${ordinal}`)
  return {
    activations,
    messages,
    children,
    rootOf(caller) {
      if (!known.includes(caller)) throw new Error(`rootOf: unknown caller ${String(caller?.id)}`)
      return root
    },
    async listDescendants(rootSessionId) {
      if (rootSessionId !== root.id) throw new Error('listDescendants: not the root session')
      return children.map((entry) => (entry.kind === 'child' ? { ...entry, activity: activity(entry.id) ?? entry.activity } : entry))
    },
    async startActivation(spec) {
      // Mirror the real admission checks before recording success.
      if (spec.provider !== SPAWN) throw new Error(`unknown provider ${String(spec.provider)}`)
      if (spec.parent !== root) {
        throw new Error('UNAUTHORIZED: subagent creation requires the exact live parent agent')
      }
      if (!(spec.signal instanceof AbortSignal)) throw new Error('signal is required')
      if (spec.delivery !== 'parent' && spec.delivery !== 'caller') throw new Error('bad delivery')
      if (!Array.isArray(spec.prompt) || spec.prompt.some((block) => block?.type !== 'text' || typeof block.text !== 'string')) {
        throw new Error('prompt must be an array of text ContentBlocks')
      }
      if (typeof spec.label !== 'string' || spec.label === '') throw new Error('label is required')
      if (spec.name !== undefined && !isValidChildName(spec.name)) throw new Error('INVALID_AGENT_NAME')
      const taken = children.filter((e) => e.depth === 1 && typeof e.path === 'string').map((e) => e.path)
      if (spec.name !== undefined && taken.includes(spec.name)) throw new Error('DUPLICATE_AGENT_NAME')
      activations.push(spec)
      const childId = idOf(activations.length)
      // As in the runtime, a local child enters the parent catalog at once.
      if (childId !== undefined) children.push(child1(spec.name, childId))
      return {
        ...(childId !== undefined ? { childId } : {}),
        name: spec.name,
        messageId: `m-${activations.length}`,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
    // Mirrors SubagentManager.sendMessage (manager.ts:568): the sender is the
    // exact live tree root, the content is a text ContentBlock[], and
    // `options.signal` is a required member (it is dereferenced first).
    async sendMessage(sender, targetId, content, options) {
      options.signal.throwIfAborted()
      if (!known.some((agent) => agent.id === root.id) || sender !== root) {
        throw new Error('UNAUTHORIZED: sendMessage requires the exact live root agent')
      }
      if (typeof targetId !== 'string' || targetId === '') throw new Error('send_message requires another agent in the subagent tree')
      if (!Array.isArray(content) || content.some((block) => block?.type !== 'text' || typeof block.text !== 'string')) {
        throw new Error('content must be an array of text ContentBlocks')
      }
      messages.push({ sender, targetId, content, options })
      return 'm1'
    },
  }
}

/** One depth-1 descendant row (listDescendants entry shape). */
export const child1 = (path, id = `c-${path}`) => ({ kind: 'child', id, activity: 'inactive', parentId: 'root-1', depth: 1, path })
