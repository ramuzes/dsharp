/**
 * dsh-chrome-cdp host half. Connection modes and the approval gate are
 * documented in README.md; the spec is docs/specs/2026-10-19-chrome-cdp-design.md.
 * Every Plugins-editable field is volatile except toolCallTimeoutMs;
 * structural fields (mode/endpoint/channel/toolCallTimeoutMs) take effect
 * after plugin reload — behavioral fields (approvalPolicy/readOnlyTools)
 * apply live.
 *
 * Schema constructors verified against the installed @deepseek-ai/schemastery
 * (Schema.array(String), Schema.union([Schema.const(...)]), .pattern/.default/
 * .volatile/.required/.min all parse correctly; volatile fields parse to
 * reference objects read via .get() — see lib/wire.js).
 */
import Schema from '@deepseek-ai/schemastery'
import { wireChromeCdp } from './lib/wire.js'
import { DEFAULT_READ_ONLY_TOOLS, APPROVAL_POLICIES } from './lib/gate.js'

export const name = 'chrome-cdp'
// inject mirrors the in-tree provider set plus nothing else
// (packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts:12);
// mountSessionMcp itself requires workingDirectory at runtime.
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

export const Config = Schema.object({
  mode: Schema.union([Schema.const('auto'), Schema.const('url'), Schema.const('ws')]).required().volatile(),
  endpoint: Schema.string().volatile(),
  channel: Schema.string().pattern(/^[a-z][a-z0-9-]*$/).default('stable').volatile(),
  approvalPolicy: Schema.union(APPROVAL_POLICIES.map((p) => Schema.const(p))).default('sensitive').volatile(),
  readOnlyTools: Schema.array(String).default([...DEFAULT_READ_ONLY_TOOLS]).volatile(),
  toolCallTimeoutMs: Schema.number().min(1),
})

/**
 * Mount the plugin. A structural config error intentionally propagates:
 * "Bad config fails the load with a precise error" (docs/cordis-tutorial/
 * 05-config.md). Everything after validation is contained inside
 * wireChromeCdp / registerStatus / the gate listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config - volatile fields are references; wire.js unwraps per read.
 */
export function apply(ctx, config) {
  wireChromeCdp(ctx, config)
}
