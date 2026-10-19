/**
 * Host-half wiring: exclusive per-Session MCP mount + approval gate + status.
 * mountSessionMcp owns browserUse.register, per-Agent scopes, exclusivity,
 * busy-session masking, and creation-time discovery
 * (packages/experimental/browser-use-runtime/src/mcp.ts:102-194).
 * deps is injectable so tests never spawn real processes.
 *
 * Volatile wiring: the Loader parses `.volatile()` fields as stable reference
 * objects read via `.get()` — NOT plain values (docs/cordis-tutorial/
 * 05-config.md "Volatile fields"; @deepseek-ai/schemastery src/index.ts:521-526).
 * A volatile-only edit is committed INTO those same references without a
 * remount — the config object is never swapped (vendor/loader/src/config/
 * entry.ts:146-197 `_commitVolatile`, which calls cosmokit src/volatile.ts:84-85
 * `updateVolatile` on the running fiber's refs), and the emitted
 * 'loader/volatile-update' event is notification-only. So readVolatile()
 * re-reads each reference on every call and approvalPolicy/readOnlyTools
 * edits apply live with NO subscription. Structural fields (mode/endpoint/
 * channel/toolCallTimeoutMs) are bound at activation — mount args are static
 * (mcp.ts:102-107) — and apply after plugin reload.
 */
import { buildSpawn } from './args.js'
import { registerApprovalGate, DEFAULT_READ_ONLY_TOOLS } from './gate.js'
import { registerStatus } from './status.js'

/**
 * Cached lazy runtime import (controller ruling; the feishu-gateway loadSdk
 * pattern, packages/feishu-gateway/index.js:48-50). Fires only when
 * deps.mountSessionMcp is not injected, so unit tests never load it.
 */
let runtimePromise
function loadRuntime() {
  runtimePromise ??= import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')
  return runtimePromise
}

/**
 * Read a config field that is a plain value (unit tests, non-volatile fields)
 * or a Volatile reference (volatile fields on the host). Returns the current
 * snapshot — never retains it across operations (05-config.md:91).
 */
function readVolatile(value, fallback) {
  if (value === undefined || value === null) return fallback
  return typeof value.get === 'function' ? value.get() : value
}

export function wireChromeCdp(ctx, config, deps = {}) {
  // Structural settings are validated here so bad config fails the load
  // ("Bad config fails the load with a precise error", docs/cordis-tutorial/05-config.md).
  // Unwrap BEFORE buildSpawn: on the host these arrive as Volatile references.
  const structural = {
    mode: readVolatile(config.mode, undefined),
    endpoint: readVolatile(config.endpoint, undefined),
    channel: readVolatile(config.channel, undefined),
    toolCallTimeoutMs: readVolatile(config.toolCallTimeoutMs, undefined),
  }
  const spawn = buildSpawn({ mode: structural.mode, endpoint: structural.endpoint, channel: structural.channel })
  const mountOptions = {
    name: 'chrome-cdp',
    exclusive: true,
    command: spawn.command,
    args: spawn.args,
    ...structural.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: structural.toolCallTimeoutMs },
  }
  if (deps.mountSessionMcp !== undefined) {
    deps.mountSessionMcp(ctx, mountOptions)
  } else {
    // Contained: a failed runtime import or mount must never leave a dangling
    // rejection that kills the host (AGENTS.md fatal-load-failure rule).
    loadRuntime()
      .then((Runtime) => Runtime.mountSessionMcp(ctx, mountOptions))
      .catch((error) => { ctx.logger?.error?.(`chrome-cdp: session MCP mount failed: ${String(error)}`) })
  }
  const getSettings = () => ({
    policy: readVolatile(config.approvalPolicy, 'sensitive'),
    readOnlyTools: readVolatile(config.readOnlyTools, DEFAULT_READ_ONLY_TOOLS),
  })
  registerApprovalGate(ctx, getSettings)
  const getState = () => {
    const settings = getSettings()
    return {
      // Structural truth of what is actually mounted (bound at wiring time;
      // edits take effect after plugin reload).
      mode: structural.mode,
      ...structural.endpoint === undefined ? {} : { endpoint: structural.endpoint },
      channel: structural.channel ?? 'stable',
      approvalPolicy: settings.policy,
      readOnlyToolCount: settings.readOnlyTools.length,
      serverEntry: spawn.args[0],
      exclusive: true,
    }
  }
  registerStatus(ctx, getState)
}
