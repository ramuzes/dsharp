/**
 * dsh-chrome-cdp host half. Connection modes, servers, and the approval gate
 * are documented in README.md; the spec is
 * docs/specs/2026-10-19-chrome-cdp-design.md (ADR-0004 revision 2026-11-20:
 * no browser-use dependency - the mount is self-contained and the MCP engine
 * is selectable).
 *
 * Every Plugins-editable field is volatile except toolCallTimeoutMs;
 * structural fields (server/mode/endpoint/channel/headless/browser/
 * toolCallTimeoutMs) take effect after plugin reload - behavioral fields
 * (approvalPolicy/readOnlyTools) apply live.
 *
 * Schema constructors verified against the installed @deepseek-ai/schemastery
 * (Schema.array(String), Schema.union([Schema.const(...)]), .pattern/.default/
 * .volatile/.required/.min all parse correctly; volatile fields parse to
 * reference objects read via .get() - see lib/wire.js).
 */
import Schema from '@deepseek-ai/schemastery'
import { wireChromeCdp } from './lib/wire.js'
import { APPROVAL_POLICIES } from './lib/gate.js'
import { SERVERS } from './lib/servers.js'

export const name = 'chrome-cdp'
// Self-contained mount: no browser-use subsystem required (desktop parity).
// The per-Session mount needs agents; the gate and projection need tools.
export const inject = ['agents', 'tools']

export const Config = Schema.object({
  // Server + mode + endpoint are validated together at wiring time
  // (lib/servers.js) so an illegal combination fails the load.
  server: Schema.union(SERVERS.map((s) => Schema.const(s))).default('playwright').volatile(),
  mode: Schema.union(['auto', 'url', 'ws', 'launch', 'extension'].map((m) => Schema.const(m))).volatile(),
  endpoint: Schema.string().volatile(),
  channel: Schema.string().pattern(/^[a-z][a-z0-9-]*$/).default('stable').volatile(),
  headless: Schema.boolean().default(false).volatile(),
  browser: Schema.string().pattern(/^[a-z][a-z0-9-]*$/).default('chrome').volatile(),
  // Extra env merged into the MCP child's scrubbed environment (e.g.
  // PLAYWRIGHT_BROWSERS_PATH for non-default browser installs).
  env: Schema.dict(String).default({}).volatile(),
  approvalPolicy: Schema.union(APPROVAL_POLICIES.map((p) => Schema.const(p))).default('sensitive').volatile(),
  // Empty = the configured server's documented read-only defaults; a
  // non-empty list replaces them wholesale (see lib/servers.js).
  readOnlyTools: Schema.array(String).default([]).volatile(),
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
