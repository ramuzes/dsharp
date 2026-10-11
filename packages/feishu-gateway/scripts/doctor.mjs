#!/usr/bin/env node
/**
 * feishu-gateway doctor — local availability check, no host logs required.
 *
 * Answers the two questions that matter when the Feishu side says
 * "app not online":
 *   1. CONFIG   — are appId + App Secret present and VALID? (asks Feishu for
 *                 a tenant_access_token; code 0 means the pair is good)
 *   2. GATEWAY  — is the dsh host process actually holding the long
 *                 connection? (checks the host's established TCP peers
 *                 against open.feishu.cn / open.larksuite.com addresses)
 *
 * Usage:
 *   node scripts/doctor.mjs                       # profile ~/.dsh/profiles/web
 *   node scripts/doctor.mjs --profile <dir>       # another live profile
 *
 * Exit code 0 only when every check passes.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import tls from 'node:tls'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const profileArg = args.findIndex(a => a === '--profile')
const profileDir = profileArg !== -1 && args[profileArg + 1]
  ? args[profileArg + 1]
  : join(homedir(), '.dsh', 'profiles', 'web')

/** Find the first `- id: feishu-gateway` block's `config:` mapping, text-wise. */
function readPatchConfig(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^- id: feishu-gateway\s*$/.test(l.trimEnd()))
  if (start === -1) return {}
  const config = {}
  let inBlock = false
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^- /.test(line)) break // next entry
    const configMatch = line.match(/^(\s+)config:\s*$/)
    if (configMatch !== null) { inBlock = true; continue }
    if (!inBlock) continue
    const field = line.match(/^\s+([\w.]+):\s*(.*)$/)
    if (field === null) continue
    config[field[1]] = field[2].replace(/^['"]|['"]$/g, '')
  }
  return config
}

/** Read one `NAME: value` line from the credential store (plain YAML map). */
function readCredential(name) {
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))
    return match === null ? undefined : match[1].trim().replace(/^['"]|['"]$/g, '')
  } catch {
    return undefined
  }
}

/** Established 443 peers of the dsh host process(es) running the web profile. */
function hostPeers() {
  try {
    // Pin to the dsh host process (the CLI entrypoint), not any node process:
    // other node processes (harnesses, MCP servers) also hold 443 connections
    // and would produce false positives.
    return execSync(
      "for p in $(pgrep -f 'apps/cli/src/bin.ts'); do ss -tnp 2>/dev/null | grep \"pid=$p,\" ; done | awk '{print $5}' | grep ':443$'",
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean).map(peer => peer.replace(/:443$/, ''))
  } catch {
    return []
  }
}

/** The inbound-event log written by the transport (last N events). */
function readEvents() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.dsh', 'feishu-gateway-events.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** The gateway's own staged boot status, written by the Host half. */
function readStatus() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.dsh', 'feishu-gateway-status.json'), 'utf8'))
  } catch {
    return undefined
  }
}

const results = []
const report = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`) }

// --- 1. config presence ---------------------------------------------------
let patch = {}
try { patch = readPatchConfig(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')) } catch { /* none */ }
const appId = patch.appId || process.env.FEISHU_APP_ID || ''
const domain = (patch.domain || 'https://open.feishu.cn').replace(/\/$/, '')
const secretRef = patch.appSecretEnv || 'FEISHU_APP_SECRET'
const appSecret = process.env[secretRef] || readCredential(secretRef) || ''

report('appId configured', appId !== '', appId === '' ? `not set (profile: ${profileDir})` : appId)
report('App Secret present', appSecret !== '', appSecret === '' ? `credential "${secretRef}" + env both empty` : `"${secretRef}" (${appSecret.length} chars)`)

// --- 2. credential validity (asks Feishu) ---------------------------------
if (appId !== '' && appSecret !== '') {
  try {
    const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const body = await response.json()
    if (body.code === 0) report('appId+App Secret valid (Feishu accepted)', true, 'tenant_access_token issued')
    else report('appId+App Secret valid (Feishu accepted)', false, `code ${body.code}: ${body.msg}`)
  } catch (error) {
    report('appId+App Secret valid (Feishu accepted)', false, `request failed: ${error.message}`)
  }
}

// --- 3. host long connection ----------------------------------------------
// CDN pools rotate, so IP matching gives false positives. Instead, TLS-probe
// each established 443 peer and read its certificate: a Feishu/Lark cert
// subject (CN/SAN containing feishu.cn / larksuite.com) identifies the
// long-connection endpoint no matter which CDN edge it is.
/** @returns {Promise<boolean>} whether the peer presents a Feishu/Lark certificate. */
function peerIsFeishu(peer) {
  return new Promise(resolve => {
    const socket = tls.connect({ host: peer, port: 443, servername: 'open.feishu.cn', rejectUnauthorized: false, timeout: 3000 }, () => {
      const cert = socket.getPeerCertificate()
      const names = `${cert?.subject?.CN ?? ''} ${JSON.stringify(cert?.subjectaltname ?? '')}`
      socket.destroy()
      resolve(/feishu|lark|bytedance/i.test(names))
    })
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
  })
}

const hostPids = execSync("pgrep -f 'apps/cli/src/bin.ts' || true", { encoding: 'utf8' }).trim()
const peers = [...new Set(hostPeers())]
if (hostPids === '') {
  report('dsh host process found', false, "no process matches 'apps/cli/src/bin.ts' — is the web host running?")
} else if (peers.length === 0) {
  report('dsh host process found', true, `running (pid ${hostPids.split('\n').join(', ')}) but holds no outbound 443 connection — a fully booted gateway holds one to Feishu`)
} else {
  const verdicts = await Promise.all(peers.map(async peer => ({ peer, feishu: await peerIsFeishu(peer) })))
  const feishu = verdicts.filter(v => v.feishu)
  report('gateway long connection (host → Feishu)', feishu.length > 0,
    feishu.length > 0
      ? `established (${feishu.map(v => v.peer).join(', ')})`
      : `not established — host 443 peers: ${peers.join(', ')} all present non-Feishu certificates. `
        + 'If config is valid, the host booted the gateway inert or failed: check its logs for "feishu-gateway:".')
}

// --- 4. the gateway's own boot stage --------------------------------------
const status = readStatus()
if (status === undefined) {
  report('gateway boot stage (host-reported)', false, 'no status file — the host half never ran (plugin disabled, or host predates the status reporter)')
} else {
  const ageSeconds = Math.round((Date.now() - Date.parse(status.at)) / 1000)
  const okStage = status.stage === 'connected'
  report(`gateway boot stage (host-reported)`, okStage,
    `${status.stage}${status.detail === null ? '' : ` (${JSON.stringify(status.detail)})`} — ${ageSeconds}s ago`
    + (okStage || ageSeconds > 3600 ? '' : '; if the stage is stuck below connected, the boot stopped there'))
}

// --- 5. inbound events -----------------------------------------------------
const events = readEvents()
if (events === undefined) {
  console.log('• inbound events — none recorded yet (send the bot /help and re-run; nothing arriving means the Feishu console subscription for im.message.receive_v1 is off)')
} else {
  const last = events[events.length - 1]
  const ageSeconds = Math.round((Date.now() - Date.parse(last.at)) / 1000)
  console.log(`• inbound events — last of ${String(events.length)}: ${String(last.type)} → ${String(last.outcome)} (${String(last.messageId ?? last.actionId ?? '')}) ${String(ageSeconds)}s ago`)
  for (const e of events.slice(-5).reverse()) {
    console.log(`    ${e.at} ${e.type} [${String(e.chatType ?? '')}] ${String(e.outcome)}`)
  }
}

process.exit(results.every(r => r.ok) ? 0 : 1)
