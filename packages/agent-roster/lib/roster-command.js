/**
 * The `/roster` command (2026-11-25): how the "+" dialog creates a member.
 *
 * Why a command and not an injected message: the dialog used to inject its
 * instruction through the composer, which DSH defines as the user speaking —
 * it rendered as a user bubble and cost a lead turn. A command is the host's
 * own "act without a model message" path: `execute()` appends two log-only
 * lifecycle events (`command/run` before the handler, `command/done` at
 * settlement) and never a model message (dsh packages/interaction/commands
 * README: "without turning the command or its result into a model message").
 * `/compact` is the first-party reference (compaction/command-compact).
 *
 * Two ways in, one spawn:
 *   - the dialog: stage the request (lib/staging.js), then run a bare
 *     `/roster` — the handler takes the staged request of its session;
 *   - typed: `/roster <template name or id>` — that template, its default
 *     model, no task (a standby member).
 * A staged request always wins over the typed argument: it is what the user
 * confirmed in the dialog moments earlier.
 *
 * Containment (AGENTS.md): the handler never throws — the commands executor
 * settles a thrown handler as an error too, but its text would be the raw
 * error; every failure here becomes model-safe text through failureText.
 */
import { failureText, readString } from './wire.js'
import { resolveTemplateRef, spawnFromTemplate } from './spawn.js'

const NAME = 'roster'
const USAGE = 'Usage: /roster <template name or id> — adds a member from a role template; it stands by until it is given work. / 用法：/roster <模板名或 id>：按角色模板添加一名成员，待命等待派活。'

/**
 * The command/done text for a created member.
 * @param {{ name: string, model?: object | null }} result - the spawn result.
 * @param {{ name: string }} template - the resolved template.
 * @param {unknown} task - the first task, if any.
 * @returns {string}
 */
function successText(result, template, task) {
  const model = result.model
  const route = model === null || model === undefined
    ? 'inherits the session model'
    : `${model.provider} / ${model.model}` + (model.reasoningEffort ? ` · ${model.reasoningEffort}` : '')
  const what = readString(task).trim() === '' ? 'created and standing by' : 'created and given its first task'
  return `Member "${result.name}" (${template.name}) ${what}. Model: ${route}.`
}

/**
 * Build the `/roster` command definition over explicit collaborators.
 * @param {{ store: object, staging: object, spawn: (input: object) => Promise<object> }} deps
 *   - the roster store (template resolution), the staged-request slots, and
 *     the spawn (lib/spawn.js spawnFromTemplate in production).
 * @returns {{ name: string, description: string, input: { hint: string }, handler: (invocation: object) => Promise<object> }}
 */
export function createRosterCommand({ store, staging, spawn }) {
  return {
    name: NAME,
    description: 'Add a team member from a role template; it stands by until it is given work',
    input: { hint: 'template name or id' },
    async handler(invocation) {
      const sessionId = readString(invocation.agent?.session?.id)
      // Taken BEFORE anything can fail: single use whatever happens next.
      const staged = staging.take(sessionId)
      const ref = (staged === undefined ? readString(invocation.rawInput) : readString(staged.templateRef)).trim()
      if (ref === '') return { kind: 'error', text: USAGE }
      try {
        const template = await resolveTemplateRef(store, ref)
        const result = await spawn({
          agent: invocation.agent,
          template,
          // An unstaged (typed) run leaves both unset: template default model, no task.
          ...(staged === undefined ? {} : { task: readString(staged.task), model: staged.model }),
          signal: invocation.signal,
        })
        return { kind: 'success', text: successText(result, template, staged?.task) }
      } catch (error) {
        if (invocation.signal.aborted) return { kind: 'error', text: 'Member creation cancelled. / 创建成员已取消。' }
        return { kind: 'error', text: failureText(error) }
      }
    },
  }
}

/**
 * Register `/roster` on a scope that injects `commands` and `subagents`.
 * The returned disposer unregisters first (no new invocation can enter) and
 * then waits for started handlers to settle — the `/compact` lifecycle rule
 * (compaction/command-compact/src/index.ts: "composite teardown is LIFO").
 *
 * @param {object} scope - inject scope carrying `commands` and `subagents`
 *   (accessing a service a scope did not inject throws — AGENTS.md 3).
 * @param {{ store: object, staging: object }} deps
 * @returns {() => Promise<void>} disposer for the inject callback.
 */
export function registerRosterCommand(scope, deps) {
  const active = new Set()
  const command = createRosterCommand({
    store: deps.store,
    staging: deps.staging,
    spawn: (input) => spawnFromTemplate(scope, { subagents: scope.subagents }, input),
  })
  const handler = (invocation) => {
    const operation = command.handler(invocation)
    active.add(operation)
    // Both branches retire without rethrowing: the derived promise can never
    // become an unhandled mirror of an expected handler rejection.
    const retire = () => { active.delete(operation) }
    void operation.then(retire, retire)
    return operation
  }
  const off = scope.commands.register({ ...command, handler })
  let unregistered = false
  const unregister = () => {
    if (!unregistered) {
      unregistered = true
      off()
    }
  }
  return async () => {
    unregister()
    await Promise.allSettled([...active])
  }
}
