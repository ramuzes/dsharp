/**
 * Host-half wiring: exclusive per-Session MCP mount + approval gate + status.
 * Since the 2026-11-20 revision (ADR-0004) the mount is self-contained
 * (lib/mount.js) - the desktop distribution does not carry the browser-use
 * subsystem - and the MCP server engine is selectable (lib/servers.js).
 * deps is injectable so tests never spawn real processes.
 *
 * Volatile wiring: the Loader parses .volatile() fields as stable reference
 * objects read via .get() - NOT plain values (docs/cordis-tutorial/
 * 05-config.md "Volatile fields"; @deepseek-ai/schemastery src/index.ts:521-526).
 * A volatile-only edit is committed INTO those same references without a
 * remount - the config object is never swapped (vendor/loader/src/config/
 * entry.ts:146-197 _commitVolatile, which calls cosmokit src/volatile.ts:84-85
 * updateVolatile on the running fiber's refs), and the emitted
 * 'loader/volatile-update' event is notification-only. So readVolatile()
 * re-reads each reference on every call and approvalPolicy/readOnlyTools
 * edits apply live with NO subscription. Structural fields (server/mode/
 * endpoint/channel/headless/browser/toolCallTimeoutMs) are bound at
 * activation and apply after plugin reload.
 */
import { buildSpawn, READ_ONLY_BY_SERVER, DEFAULT_SERVER, serverVersion } from './servers.js'
import { registerApprovalGate } from './gate.js'
import { registerStatus } from './status.js'
import { mountPerSession } from './mount.js'

/**
 * Read a config field that is a plain value (unit tests, non-volatile fields)
 * or a Volatile reference (volatile fields on the host). Returns the current
 * snapshot - never retains it across operations (05-config.md:91).
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
    server: readVolatile(config.server, DEFAULT_SERVER),
    mode: readVolatile(config.mode, undefined),
    endpoint: readVolatile(config.endpoint, undefined),
    channel: readVolatile(config.channel, undefined),
    headless: readVolatile(config.headless, false),
    browser: readVolatile(config.browser, undefined),
    env: readVolatile(config.env, undefined),
    toolCallTimeoutMs: readVolatile(config.toolCallTimeoutMs, undefined),
  }
  const spawn = buildSpawn(structural.server, {
    mode: structural.mode,
    endpoint: structural.endpoint,
    channel: structural.channel,
    headless: structural.headless,
    browser: structural.browser,
  })
  // An empty readOnlyTools list means "the server's documented defaults";
  // a non-empty list replaces them wholesale.
  const resolveList = () => {
    const list = readVolatile(config.readOnlyTools, undefined)
    return Array.isArray(list) && list.length > 0 ? list : [...READ_ONLY_BY_SERVER[structural.server]]
  }
  const mountOptions = {
    name: 'chrome-cdp',
    command: spawn.command,
    args: spawn.args,
    // Volatile dict fields wrap their VALUES as references too - JSON shows
    // strings while schemastery sees objects (deep-wrapped env rejected the
    // mcp-client Config once already). Unwrap per entry.
    ...(structural.env === undefined ? {} : { env: Object.fromEntries(Object.entries(structural.env).map(([k, v]) => [k, typeof v?.get === 'function' ? v.get() : v])) }),
    ...structural.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: structural.toolCallTimeoutMs },
  }
  const mount = deps.mountPerSession ?? mountPerSession
  mount(ctx, mountOptions, deps)
  const getSettings = () => ({
    policy: readVolatile(config.approvalPolicy, 'sensitive'),
    readOnlyTools: resolveList(),
  })
  registerApprovalGate(ctx, getSettings)
  const getState = () => {
    const settings = getSettings()
    return {
      // Structural truth of what is actually mounted (bound at wiring time;
      // edits take effect after plugin reload).
      server: structural.server,
      mode: structural.mode,
      ...structural.endpoint === undefined ? {} : { endpoint: structural.endpoint },
      ...(structural.server === 'chrome-devtools' ? { channel: structural.channel ?? 'stable' } : {}),
      approvalPolicy: settings.policy,
      readOnlyToolCount: settings.readOnlyTools.length,
      serverVersion: serverVersion(structural.server),
      serverEntry: spawn.args[0],
      exclusive: true,
    }
  }
  // The commands runtime owns register()'s effect on ITS OWN ctx
  // (packages/interaction/commands/src/index.ts:285-292), so an unwrapped
  // /cdc registration SURVIVES plugin unload and the re-load throws a
  // duplicate-name error that status.js would swallow - stale /cdc forever
  // (final review I1). Route the disposer through the plugin's own fiber so
  // unload unregisters it.
  ctx.effect(() => registerStatus(ctx, getState), 'chrome-cdp: status')
}
