/**
 * dsh-agent-roster — Host half. Task 1 scaffold: Config schema, staged boot
 * observability, and the wire helpers everything later wires through.
 *
 * Later tasks mount the real contributions here: the storageDomain-backed
 * template store and CRUD remote (Task 2), member spawn via the subagent
 * runtime (Task 3), the reusable draft session (Task 4), and the
 * roster_template_save / roster_template_list agent tools (Task 5). This file
 * deliberately registers none of them yet — it only proves the boot path:
 * config arrives as reactive wrappers and is read exclusively through
 * readBoolean (AGENTS.md, "Config values arrive wrapped"), and every mount
 * stage lands in the status file so a dead mount names its stage.
 *
 * Structure follows the repo's apply() precedents (engram/airboard index.js):
 * stage 1 lands synchronously before any service is available; the wiring
 * body runs inside ctx.effect — cordis runs the body synchronously and runs
 * the returned disposer at fiber disposal (cordis fiber.d.ts
 * `effect(execute, label?)`; repo usage precedent packages/chrome-cdp/lib/wire.js:102)
 * — so anything registered below is disposed with this fiber (cleanup-safe).
 */
import Schema from '@deepseek-ai/schemastery'
import { readBoolean } from './lib/wire.js'
import { openStatus } from './lib/status.js'

/**
 * Row configuration. `exposeAgentTools` is deliberately NON-volatile: it
 * changes mount-time structure (which agent tools register), so edits take
 * effect after a plugin reload rather than live — the same ruling as engram's
 * daemonMode. No secrets and no deployment values live here.
 */
export const Config = Schema.object({
  exposeAgentTools: Schema.boolean().default(true)
    .description('Expose roster_template_save and roster_template_list tools to the model'),
})

/**
 * Mount the plugin (Task 1 wiring). Stage sequence (status file, engram
 * pattern): apply → wire-ready → done — or wire-failed with the error text,
 * rethrown so a dead mount stays loud rather than silently degrading
 * (packages/gitlab/index.js noteStage pattern; AGENTS.md containment rule).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ exposeAgentTools?: unknown }} config - validated row config
 *   (fields may arrive as schemastery reactive wrappers).
 */
export function apply(ctx, config) {
  const status = openStatus(ctx)
  // Stage 1 lands synchronously, before any service is available.
  status.write('apply')

  ctx.effect(() => {
    try {
      // The ONLY config read in this scaffold — through the unwrap helper,
      // never raw (a wrapper-typed field must not crash the boot path).
      // Task 5 gates agent-tool registration on this value.
      const exposeAgentTools = readBoolean(config.exposeAgentTools)

      status.write('wire-ready', { exposeAgentTools })
      // Nothing registered yet: Task 2 opens the store + remote service,
      // Task 5 the agent tools.
      status.write('done')
      return () => { /* nothing to dispose yet */ }
    } catch (error) {
      status.write('wire-failed', String(error))
      throw error
    }
  }, 'dsh-agent-roster: scaffold wiring')
}
