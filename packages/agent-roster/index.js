/**
 * dsh-agent-roster — Host half. Task 1 scaffold: Config schema and staged
 * boot observability; Task 2: the storageDomain-backed template store and
 * the `agentRoster` CRUD remote service mounted on top of it; Task 5: the
 * roster_template_save / roster_template_list agent tools behind the
 * (non-volatile) exposeAgentTools toggle. Config
 * arrives as reactive wrappers and is read exclusively through
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
import { openRosterStore } from './lib/store.js'
import { AgentRosterService } from './lib/roster-service.js'
import { registerRosterTools } from './lib/agent-tools.js'

/** @type {any} */
let serviceFactory = undefined

/**
 * Test seam: substitute the Remote service factory. The real one needs a
 * genuine cordis Context for Service registration, which unit fakes are not
 * — the feishu-gateway setDiagnosticsFactoryForTests precedent
 * (packages/feishu-gateway/index.js:29-36, consumed at index.js:178-183).
 * @param {((ctx: unknown, store: unknown) => unknown) | undefined} factory
 */
export function setServiceFactoryForTests(factory) { serviceFactory = factory }

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
 * Mount the plugin. Stage sequence (status file, engram pattern): apply →
 * wire-ready → (storage-degraded when the host exposes no storageDomain) →
 * service-registered → done → tools-registered (from the tools inject
 * callback, when exposeAgentTools reads true), tools-skipped (false), or
 * tools-failed with the error text (a contained registration failure,
 * rethrown) — or wire-failed with the error text, rethrown
 * so a dead mount stays loud rather than silently degrading
 * (packages/gitlab/index.js noteStage pattern; AGENTS.md containment rule).
 * The tools stage lands AFTER `done` on purpose: the file keeps only the
 * latest record, so a finished mount must still name its tools state.
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
    let store = undefined
    try {
      // The ONLY config read in this file — through the unwrap helper,
      // never raw (a wrapper-typed field must not crash the boot path).
      // Task 5 gates agent-tool registration on this value.
      const exposeAgentTools = readBoolean(config.exposeAgentTools)
      status.write('wire-ready', { exposeAgentTools })

      // Template store over the optional storageDomain service (memory
      // fallback + storage-degraded record when absent — lib/store.js), and
      // the `agentRoster` remote the client calls for CRUD. A cordis Service
      // self-registers with ctx and its lifecycle follows the fiber (the
      // chrome-cdp registerStatus / feishu apply construction pattern).
      store = openRosterStore(ctx, status)
      const factory = serviceFactory ?? ((ctx2, store2) => new AgentRosterService(ctx2, store2))
      const roster = factory(ctx, store)
      status.write('service-registered')
      status.write('done')

      // ---- Task 5: model-facing tools behind the toggle -------------------
      // The toggle is structural (non-volatile Config): edits apply after a
      // plugin reload, not live. 'tools' is injected on purpose — accessing
      // it on a scope that did not inject it throws in cordis ("cannot get
      // property ... without inject") — the airboard/engram registration
      // pattern (packages/airboard/index.js:245, packages/engram/index.js:122).
      // Cordis runs the callback once the tools service is available and
      // runs the returned disposer at that inject fiber's disposal, so the
      // tools unregister with the plugin even though they outlive this
      // effect body.
      if (exposeAgentTools) {
        ctx.inject(['tools'], (toolScope) => {
          // Containment on this entry point (AGENTS.md): a registration
          // failure (duplicate tool name, invalid definition) names its
          // stage with the error text, then rethrows — the status file is
          // the live-mount diagnosability contract, so the last record must
          // never sit at `done` over a dead registration (engram
          // index.js:257-259 / airboard index.js:262-265 pattern).
          try {
            const offTools = registerRosterTools(toolScope, roster)
            status.write('tools-registered')
            return () => { offTools() }
          } catch (error) {
            status.write('tools-failed', String(error))
            throw error
          }
        })
      } else {
        status.write('tools-skipped')
      }

      // Release the opened domain with this fiber (caller-owns-handle,
      // lib/store.js dispose) so a remount never hits 'already-open'.
      return () => { store?.dispose?.() }
    } catch (error) {
      // Same containment as Task 1: name the stage, release what already
      // opened, then rethrow — a dead mount stays loud.
      store?.dispose?.()
      status.write('wire-failed', String(error))
      throw error
    }
  }, 'dsh-agent-roster: store and service wiring')
}
