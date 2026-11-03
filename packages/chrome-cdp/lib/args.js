/**
 * Connection-mode -> chrome-devtools-mcp CLI argument assembly. Pure.
 *
 * Flag surface verified against the pinned dependency chrome-devtools-mcp@1.9.0
 * (build/src/config/browser-options.js: --auto-connect "automatically connects
 * to a browser (Chrome 144+) ... Requires the remote debugging server to be
 * started ... via chrome://inspect/#remote-debugging"; --browser-url /
 * --ws-endpoint per the in-tree provider precedent
 * packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts:30-31).
 * browser-options.js:105 declares `channel: { conflicts: ['browserUrl',
 * 'wsEndpoint', 'executablePath'] }` — the live dsh-btest2 host caught the
 * original always-passed --channel aborting url/ws spawns with "Arguments
 * channel and browserUrl are mutually exclusive" (2026-10-19), so --channel
 * is emitted in auto mode ONLY, where it selects the connect profile.
 * The MCP server entry is build/src/bin/chrome-devtools-mcp.js — NOT the CLI
 * twin chrome-devtools.js (dual-bin pitfall, research note §7).
 */
import { fileURLToPath } from 'node:url'

export const CONNECTION_MODES = ['auto', 'url', 'ws']
export const DEFAULT_CHANNEL = 'stable'

const CHANNEL_PATTERN = /^[a-z][a-z0-9-]*$/

export function resolveServerEntry() {
  return fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
}

export function buildServerArgs(settings) {
  const { mode, endpoint } = settings ?? {}
  const channel = settings?.channel ?? DEFAULT_CHANNEL
  if (!CHANNEL_PATTERN.test(channel)) throw new Error(`channel must match ${CHANNEL_PATTERN} (got: ${channel})`)
  const args = ['--no-usage-statistics']
  if (mode === 'auto') {
    if (endpoint !== undefined) throw new Error('endpoint must not be set in auto mode (auto-connect reads the channel profile)')
    // channel is legal ONLY next to --auto-connect (it conflicts with
    // browserUrl/wsEndpoint per browser-options.js:105).
    args.push('--channel', channel, '--auto-connect')
    return args
  }
  if (mode !== 'url' && mode !== 'ws') {
    throw new Error(`connection mode must be one of ${CONNECTION_MODES.join(' / ')} (got: ${String(mode)})`)
  }
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new Error(`endpoint is required for mode ${mode}`)
  }
  if (/\s/u.test(endpoint)) throw new Error('endpoint must not contain whitespace')
  if (mode === 'url') {
    if (!/^https?:\/\/[^\s/]+/u.test(endpoint)) throw new Error('mode url requires an http(s) endpoint')
    args.push('--browser-url', endpoint)
  } else {
    if (!/^wss?:\/\/[^\s/]+/u.test(endpoint)) throw new Error('mode ws requires a ws(s) endpoint')
    args.push('--ws-endpoint', endpoint)
  }
  return args
}

export function buildSpawn(settings) {
  return { command: process.execPath, args: [resolveServerEntry(), ...buildServerArgs(settings)] }
}
