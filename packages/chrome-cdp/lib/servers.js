/**
 * Per-server descriptors for the two supported MCP browser engines. Each
 * server ships its own npm package (pinned exactly - the approval read-only
 * lists are maintained against its tool-name surface) and its own flag
 * dialect. Pure module: no I/O besides entry resolution.
 *
 * Playwright MCP (@playwright/mcp, Microsoft): --cdp-endpoint / --endpoint /
 * --extension / launch. No Chrome-144 auto-connect equivalent - that flag is
 * chrome-devtools-mcp-only.
 * Chrome DevTools MCP (chrome-devtools-mcp, Google): --auto-connect (Chrome
 * >=144 approval mode), --browser-url, --ws-endpoint. Dual-bin trap: the MCP
 * server entry is build/src/bin/chrome-devtools-mcp.js, never the CLI twin
 * chrome-devtools.js (research note section 7).
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const SERVERS = ['playwright', 'chrome-devtools']
export const DEFAULT_SERVER = 'playwright'
// A fresh profile has no config row at all (the bundle patch inserts the row
// without one), so an unconfigured mode must not fail the load: default to the
// one mode that needs neither a debug endpoint nor a Playwright-managed
// browser. Valid for the default server (playwright); a server/mode mismatch
// still fails loudly at wiring time (buildServerArgs below).
export const DEFAULT_MODE = 'extension'

const ENTRIES = {
  // playwright's exports map hides ./cli.js, so resolve the package root
  // ('.') and join the bin-relative entry afterwards.
  playwright: { spec: '@playwright/mcp', join: 'cli.js' },
  'chrome-devtools': { spec: 'chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js', join: '' },
}

/** Observation-only tools per server; everything else is a sensitive action. */
export const READ_ONLY_BY_SERVER = Object.freeze({
  playwright: Object.freeze([
    'browser_snapshot', 'browser_console', 'browser_network_requests',
    'browser_take_screenshot', 'browser_wait_for',
  ]),
  'chrome-devtools': Object.freeze([
    'list_pages', 'list_network_requests', 'list_console_messages', 'list_extensions', 'list_webmcp_tools',
    'get_network_request', 'get_console_message', 'get_tab_id', 'get_os_app_state',
    'take_snapshot', 'take_screenshot', 'wait_for',
    'performance_start_trace', 'performance_stop_trace', 'performance_analyze_insight',
    'take_heapsnapshot', 'close_heapsnapshot', 'compare_heapsnapshots', 'query_heapsnapshot_objects',
    'get_heapsnapshot_class_nodes', 'get_heapsnapshot_details', 'get_heapsnapshot_dominators',
    'get_heapsnapshot_duplicate_strings', 'get_heapsnapshot_edges', 'get_heapsnapshot_object_details',
    'get_heapsnapshot_retainers', 'get_heapsnapshot_retaining_paths', 'get_heapsnapshot_summary',
  ]),
})

/** Modes each server accepts. */
export const MODES_BY_SERVER = Object.freeze({
  playwright: Object.freeze(['launch', 'url', 'ws', 'extension']),
  'chrome-devtools': Object.freeze(['auto', 'url', 'ws']),
})

export function resolveEntry(server) {
  const entry = ENTRIES[server]
  if (!entry) throw new Error('server must be one of ' + SERVERS.join(' / ') + ' (got: ' + String(server) + ')')
  const root = fileURLToPath(import.meta.resolve(entry.spec))
  return entry.join ? root.slice(0, root.lastIndexOf('/') + 1) + entry.join : root
}

/** Package version of the resolved server, read beside its entry file. */
export function serverVersion(server) {
  const entry = resolveEntry(server)
  let dir = entry.slice(0, entry.lastIndexOf('/') + 1)
  for (let i = 0; i < 8; i++) {
    try { return createRequire(entry)(dir + 'package.json').version } catch { dir = dir.slice(0, dir.lastIndexOf('/', dir.length - 2) + 1) }
  }
  return 'unknown'
}

const CHANNEL_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Assemble one server's MCP child-process arguments.
 * @param {string} server - 'playwright' | 'chrome-devtools'.
 * @param {{mode: string, endpoint?: string, channel?: string, headless?: boolean, browser?: string}} settings
 * @returns {string[]} argv tail (after the entry file).
 */
export function buildServerArgs(server, settings) {
  const { mode, endpoint } = settings ?? {}
  if (server !== 'playwright' && server !== 'chrome-devtools') {
    throw new Error('server must be one of ' + SERVERS.join(' / ') + ' (got: ' + String(server) + ')')
  }
  const modes = MODES_BY_SERVER[server]
  if (!modes.includes(mode)) {
    throw new Error('mode must be one of ' + modes.join(' / ') + ' for server ' + server + ' (got: ' + String(mode) + ')')
  }
  if (mode !== 'launch' && mode !== 'extension' && mode !== 'auto') {
    if (typeof endpoint !== 'string' || endpoint.trim() === '') {
      throw new Error('endpoint is required for mode ' + mode)
    }
    if (/\s/u.test(endpoint)) throw new Error('endpoint must not contain whitespace')
    // chrome-devtools modes map 1:1 onto scheme-specific flags; playwright
    // funnels both onto --cdp-endpoint, whose connectOverCDP accepts either.
    const scheme = server === 'chrome-devtools' ? (mode === 'url' ? /^https?:\/\//u : /^wss?:\/\//u) : /^https?:\/\/|^wss?:\/\//u
    if (!scheme.test(endpoint)) {
      throw new Error('endpoint must be an ' + (server === 'chrome-devtools' ? (mode === 'url' ? 'HTTP' : 'WS') : 'http(s) or ws(s)') + ' URL')
    }
  } else if (endpoint !== undefined) {
    throw new Error('endpoint must not be set in ' + mode + ' mode')
  }
  if (server === 'playwright') {
    const args = []
    if (mode === 'launch') {
      if (settings.headless) args.push('--headless')
      const browser = settings.browser ?? 'chrome'
      if (!CHANNEL_PATTERN.test(browser)) throw new Error('browser must match ' + CHANNEL_PATTERN + ' (got: ' + String(browser) + ')')
      args.push('--browser', browser)
    } else if (mode === 'url' || mode === 'ws') {
      // Playwright's connectOverCDP accepts both http discovery URLs and
      // browser-target ws:// URLs, so both modes map onto --cdp-endpoint.
      if (!/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u.test(endpoint)) {
        throw new Error('endpoint must be an http(s) or ws(s) URL')
      }
      args.push('--cdp-endpoint', endpoint)
    } else {
      args.push('--extension')
    }
    return args
  }
  // chrome-devtools-mcp: --channel is meaningful only with --auto-connect and
  // conflicts with --browser-url/--ws-endpoint (browser-options.js:105).
  const channel = settings.channel ?? 'stable'
  if (!CHANNEL_PATTERN.test(channel)) throw new Error('channel must match ' + CHANNEL_PATTERN + ' (got: ' + String(channel) + ')')
  if (mode === 'auto') return ['--no-usage-statistics', '--channel', channel, '--auto-connect']
  if (mode === 'url') return ['--no-usage-statistics', '--browser-url', endpoint]
  return ['--no-usage-statistics', '--ws-endpoint', endpoint]
}

/**
 * Executable + full argv for one server activation.
 * @returns {{command: string, args: string[]}} node [entry, ...flags].
 */
export function buildSpawn(server, settings) {
  return { command: process.execPath, args: [resolveEntry(server), ...buildServerArgs(server, settings)] }
}
