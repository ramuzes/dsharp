# chrome-cdp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `packages/chrome-cdp` dsharp bundle: agent operates the user's real Chrome over CDP via chrome-devtools-mcp (per-Session exclusive mount), with a per-action approval gate in the Web GUI, Plugins-page config card, and `/cdc` status command.

**Architecture:** Host half registers as a browser-use provider by calling the runtime's `mountSessionMcp` (which owns `browserUse.register`, per-Session scoping, exclusivity, and busy masking); a global `tools/pre-execute` listener gates `mcp__chrome-cdp__*` calls by policy; a Typert remote service + slash command expose status. Client half is a Plugins-page config card modeled on feishu-gateway's.

**Tech Stack:** Plain-JS ESM (zero build), cordis plugin format, schemastery Config, node --test, chrome-devtools-mcp 1.9.0 (pinned).

**Spec:** `docs/specs/2026-10-19-chrome-cdp-design.md` (binding authority; this plan argues from it). ADR: `docs/adr/0004-chrome-cdp-via-browser-use-mcp.md`.

## Global Constraints

- Zero-build plain JavaScript ESM; no TypeScript, no bundler step (dsharp bundle convention, repo README).
- `chrome-devtools-mcp` pinned EXACTLY `1.9.0` (spec: tool-name surface stability).
- `@deepseek-ai/dsh-experimental-browser-use-runtime` pinned EXACTLY `0.2.1-alpha.5` (must be verified in Task 1 against the published tarball).
- All other `@deepseek-ai/*` packages are `peerDependencies: "*"` — never runtime deps (dsharp convention).
- MCP serverName is the constant `chrome-cdp`; gated tool prefix is `mcp__chrome-cdp__`.
- Every dsh interface consumed carries a comment citing the dsh source path it was designed against (repo AGENTS.md convention).
- Every event callback is containment-wrapped (never throws, never leaves a dangling rejection — a plugin bug must not kill the host).
- No new agent-callable tools are registered (provider mount + gate + command + remote only).
- Tests: `node --test` with strict fakes that replicate real shapes exactly; no fake may be more forgiving than the real interface (AGENTS.md).
- Work happens on branch `chrome-cdp`; every task commits there.

## Review Focus

1. **Volatile policy edit does not reach the live gate** (loader may swap config objects rather than mutate fields). Expected: editing `approvalPolicy` on the Plugins page changes gating without restart. Pinned by Task 4 Step 1 (read loader source, wire `snapshot()` accordingly) + Task 4 test `gate reads fresh policy per call`.
2. **Off-prefix tools get gated** (breaks every non-browser tool). Expected: pass-through via `next()`. Pinned by Task 3 matrix cases (bash, mcp__other__x).
3. **Mode/endpoint combination errors surface late or unclearly**. Expected: load-time error naming the field. Pinned by Task 2 validation tests + Task 4 apply test.
4. **chrome-devtools-mcp dual-bin mix-up** (CLI `chrome-devtools.js` exits immediately). Expected: server entry `build/src/bin/chrome-devtools-mcp.js`. Pinned by Task 2 entry test + Task 6 E2E.
5. **Exclusivity not actually enabled** (two sessions drive one browser). Expected: `mountSessionMcp` called with `exclusive: true`. Pinned by Task 4 wiring test.
6. **Throwing callbacks destabilize the host**. Expected: gate listener swallows its own errors and falls back to `{kind:'deny'}`-equivalent ask-fail behavior. Pinned by Task 3 robustness tests.

---

### Task 1: Bundle scaffold + upstream tarball verification

**Files:**
- Create: `packages/chrome-cdp/package.json`
- Create: `packages/chrome-cdp/cordis.patch.yml`
- Create: `packages/chrome-cdp/icon.svg`
- Create: `packages/chrome-cdp/README.md` (stub; finalized in Task 6)
- Scratch: `.scratch/sdd/2026-10-19-chrome-cdp/task-1-verification.txt`

**Interfaces:**
- Consumes: npm registry tarballs of `@deepseek-ai/dsh-experimental-browser-use-runtime@0.2.1-alpha.5` and `chrome-devtools-mcp@1.9.0`.
- Produces: installable bundle skeleton later tasks build inside; verification note proving the `./mcp` export exists in the PUBLISHED runtime (ADR-0004 precondition; if it does not, STOP and report — the ADR fallback (vendor) requires a controller ruling before continuing).

- [ ] **Step 1: Verify published tarballs**

```bash
cd /home/ramuz/skills-workspace/dsharp/.scratch/sdd/2026-10-19-chrome-cdp
mkdir -p tars && cd tars
npm pack @deepseek-ai/dsh-experimental-browser-use-runtime@0.2.1-alpha.5 --pack-destination . 2>/dev/null
npm pack chrome-devtools-mcp@1.9.0 --pack-destination . 2>/dev/null
tar tzf deepseek-ai-dsh-experimental-browser-use-runtime-0.2.1-alpha.5.tgz | grep -E 'mcp\.(js|d\.ts)$|package/mcp' > ../task-1-verification.txt
tar tzf chrome-devtools-mcp-1.9.0.tgz | grep -E 'bin/chrome-devtools(-mcp)?\.js$' >> ../task-1-verification.txt
cat ../task-1-verification.txt
```
Expected: the runtime tarball lists `package/lib/types/mcp.js` (or an equivalent `mcp` entry point) AND chrome-devtools-mcp lists BOTH `package/build/src/bin/chrome-devtools.js` and `package/build/src/bin/chrome-devtools-mcp.js`. If the runtime lacks the mcp export: status BLOCKED, report verbatim listing.

- [ ] **Step 2: Write scaffold files**

`packages/chrome-cdp/package.json`:
```json
{
  "name": "dsh-chrome-cdp",
  "version": "0.1.0",
  "description": "Operate the user's real Chrome over CDP via chrome-devtools-mcp: per-Session exclusive attach, per-action approval gate, Plugins-page config card",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "lib", "cordis.patch.yml", "icon.svg", "README.md"],
  "license": "MIT",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-plugin-manager", "@deepseek-ai/dsh-client-ui-settings"]
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-experimental-browser-use-runtime": "0.2.1-alpha.5",
    "chrome-devtools-mcp": "1.9.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-typert-protocol": "*",
    "@deepseek-ai/schemastery": "*"
  }
}
```

`packages/chrome-cdp/cordis.patch.yml`:
```yaml
# dsh-chrome-cdp loader row. The bundle's host half (index.js) mounts
# chrome-devtools-mcp per live Session through the browser-use runtime;
# config lives on this row (see README).
- insert:
    - id: chrome-cdp
      name: './index.js'
```

`packages/chrome-cdp/icon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#4a90d9" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="9.5" cy="10" r="1" fill="#4a90d9"/><circle cx="14.5" cy="10" r="1" fill="#4a90d9"/><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8"/></svg>
```

`packages/chrome-cdp/README.md`:
```md
# dsh-chrome-cdp

Operate the user's real Chrome over CDP via chrome-devtools-mcp.

Status: scaffold — full documentation lands with the final task.

Connection modes: `auto` (Chrome >=144 approval mode via --auto-connect),
`url` (--browser-url, e.g. port-mapped endpoints), `ws` (--ws-endpoint).

Security baseline: CDP debug endpoints are unauthenticated; any local
process that can reach the endpoint has full browser control. This plugin's
mitigation is the per-action approval gate — it is NOT a sandbox.
```

- [ ] **Step 3: Smoke-check scaffold**

Run: `cd packages/chrome-cdp && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"`
Expected: `package.json OK`.

- [ ] **Step 4: Commit**

```bash
git add packages/chrome-cdp .scratch/sdd/2026-10-19-chrome-cdp/task-1-verification.txt 2>/dev/null || git add packages/chrome-cdp
git commit -m "chrome-cdp: bundle scaffold + upstream tarball verification"
```

---

### Task 2: `lib/args.js` — connection-mode argument assembly

**Files:**
- Create: `packages/chrome-cdp/lib/args.js`
- Test: `packages/chrome-cdp/test/args.test.js`

**Interfaces:**
- Produces: `CONNECTION_MODES`, `DEFAULT_CHANNEL = 'stable'`, `buildServerArgs(settings) -> string[] ` (throws `Error` with field-naming message on invalid combos), `resolveServerEntry() -> absolute path`, `buildSpawn(settings) -> { command, args }` where `settings = { mode, endpoint?, channel? }`.

- [ ] **Step 1: Write failing tests**

`packages/chrome-cdp/test/args.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServerArgs, resolveServerEntry, buildSpawn, CONNECTION_MODES, DEFAULT_CHANNEL } from '../lib/args.js'

test('auto mode: --auto-connect + --channel', () => {
  assert.deepEqual(buildServerArgs({ mode: 'auto', channel: 'stable' }),
    ['--no-usage-statistics', '--channel', 'stable', '--auto-connect'])
})

test('auto mode rejects endpoint', () => {
  assert.throws(() => buildServerArgs({ mode: 'auto', channel: 'stable', endpoint: 'http://x:1' }),
    /endpoint.*auto/i)
})

test('url mode: --browser-url with validated http endpoint', () => {
  assert.deepEqual(buildServerArgs({ mode: 'url', endpoint: 'http://127.0.0.1:9223' }),
    ['--no-usage-statistics', '--channel', 'stable', '--browser-url', 'http://127.0.0.1:9223'])
})

test('url mode requires an http(s) endpoint', () => {
  assert.throws(() => buildServerArgs({ mode: 'url' }), /endpoint.*required/i)
  assert.throws(() => buildServerArgs({ mode: 'url', endpoint: 'ws://x:1' }), /http/i)
  assert.throws(() => buildServerArgs({ mode: 'url', endpoint: 'http://a b' }), /whitespace|http/i)
})

test('ws mode: --ws-endpoint with validated ws(s) endpoint', () => {
  assert.deepEqual(buildServerArgs({ mode: 'ws', endpoint: 'ws://127.0.0.1:9223/devtools/browser/abc' }),
    ['--no-usage-statistics', '--channel', 'stable', '--ws-endpoint', 'ws://127.0.0.1:9223/devtools/browser/abc'])
  assert.throws(() => buildServerArgs({ mode: 'ws', endpoint: 'http://x:1' }), /ws/i)
})

test('unknown mode is rejected with the legal values', () => {
  assert.throws(() => buildServerArgs({ mode: 'launch' }), new RegExp(CONNECTION_MODES.join('|')))
})

test('channel is validated', () => {
  assert.throws(() => buildServerArgs({ mode: 'auto', channel: 'Bad Channel' }), /channel/i)
})

test('server entry is the MCP server bin, never the CLI bin', () => {
  const entry = resolveServerEntry()
  assert.ok(entry.endsWith('/build/src/bin/chrome-devtools-mcp.js'), entry)
  assert.ok(!entry.endsWith('/build/src/bin/chrome-devtools.js'), entry)
})

test('buildSpawn prepends node + entry', () => {
  const spawn = buildSpawn({ mode: 'auto', channel: 'stable' })
  assert.equal(spawn.command, process.execPath)
  assert.equal(spawn.args[0], resolveServerEntry())
  assert.deepEqual(spawn.args.slice(1), buildServerArgs({ mode: 'auto', channel: 'stable' }))
  assert.equal(DEFAULT_CHANNEL, 'stable')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/chrome-cdp && node --test test/args.test.js`
Expected: FAIL — cannot find module `../lib/args.js`.

- [ ] **Step 3: Implement**

`packages/chrome-cdp/lib/args.js`:
```js
/**
 * Connection-mode -> chrome-devtools-mcp CLI argument assembly. Pure.
 *
 * Flag surface verified against the pinned dependency chrome-devtools-mcp@1.9.0
 * (build/src/config/browser-options.js: --auto-connect "automatically connects
 * to a browser (Chrome 144+) ... Requires the remote debugging server to be
 * started ... via chrome://inspect/#remote-debugging"; --browser-url /
 * --ws-endpoint per the in-tree provider precedent
 * packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts:30-31).
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
  const args = ['--no-usage-statistics', '--channel', channel]
  if (mode === 'auto') {
    if (endpoint !== undefined) throw new Error('endpoint must not be set in auto mode (auto-connect reads the channel profile)')
    args.push('--auto-connect')
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
```

- [ ] **Step 4: Run tests**

Run: `cd packages/chrome-cdp && node --test test/args.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/chrome-cdp/lib/args.js packages/chrome-cdp/test/args.test.js
git commit -m "chrome-cdp: connection-mode argument assembly (TDD)"
```

---

### Task 3: `lib/gate.js` — the approval gate

**Files:**
- Create: `packages/chrome-cdp/lib/gate.js`
- Test: `packages/chrome-cdp/test/gate.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TOOL_PREFIX = 'mcp__chrome-cdp__'`, `APPROVAL_POLICIES = ['sensitive','all','none']`, `DEFAULT_READ_ONLY_TOOLS` (frozen array, exact 1.9.0 names below), `decideApproval({ policy, readOnlyTools }, toolName) -> { kind: 'allow' } | { kind: 'ask', reason, displayReason }`, `registerApprovalGate(ctx, getSettings) -> disposer` where `getSettings() -> { policy, readOnlyTools }` is re-read per call (volatile liveness).

- [ ] **Step 1: Write failing tests**

`packages/chrome-cdp/test/gate.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideApproval, registerApprovalGate, DEFAULT_READ_ONLY_TOOLS, TOOL_PREFIX, APPROVAL_POLICIES } from '../lib/gate.js'

test('sensitive policy: read-only tools pass, others ask', () => {
  const s = { policy: 'sensitive', readOnlyTools: DEFAULT_READ_ONLY_TOOLS }
  assert.deepEqual(decideApproval(s, TOOL_PREFIX + 'take_snapshot'), { kind: 'allow' })
  assert.deepEqual(decideApproval(s, TOOL_PREFIX + 'list_pages'), { kind: 'allow' })
  const d = decideApproval(s, TOOL_PREFIX + 'navigate_page')
  assert.equal(d.kind, 'ask')
  assert.ok(d.reason.includes('navigate_page'))
  assert.equal(typeof d.displayReason.zh, 'string')
  assert.equal(typeof d.displayReason.en, 'string')
})

test('all policy: even read-only tools ask', () => {
  const d = decideApproval({ policy: 'all', readOnlyTools: DEFAULT_READ_ONLY_TOOLS }, TOOL_PREFIX + 'take_screenshot')
  assert.equal(d.kind, 'ask')
})

test('none policy: everything allows', () => {
  assert.deepEqual(decideApproval({ policy: 'none', readOnlyTools: [] }, TOOL_PREFIX + 'click'), { kind: 'allow' })
})

test('off-prefix names allow (listener filters, decision is total)', () => {
  assert.deepEqual(decideApproval({ policy: 'sensitive', readOnlyTools: [] }, 'bash'), { kind: 'allow' })
  assert.deepEqual(decideApproval({ policy: 'sensitive', readOnlyTools: [] }, 'mcp__other__x'), { kind: 'allow' })
})

test('custom read-only list replaces the default wholesale', () => {
  const s = { policy: 'sensitive', readOnlyTools: ['take_snapshot'] }
  assert.deepEqual(decideApproval(s, TOOL_PREFIX + 'list_pages'), { kind: 'ask' })
  assert.deepEqual(decideApproval(s, TOOL_PREFIX + 'take_snapshot'), { kind: 'allow' })
})

test('listener: off-prefix delegates via next(), in-prefix asks, allow delegates', () => {
  const registered = []
  const ctx = { on: (name, fn) => { registered.push({ name, fn }); return () => {} } }
  let settings = { policy: 'sensitive', readOnlyTools: DEFAULT_READ_ONLY_TOOLS }
  registerApprovalGate(ctx, () => settings)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'tools/pre-execute')
  const gate = registered[0].fn
  let delegated = 0
  const next = async () => { delegated++; return { kind: 'allow' } }
  // off-prefix -> next()
  const r1 = await gate({ name: 'bash', arguments: {} }, next)
  assert.equal(delegated, 1)
  // read-only -> next()
  await gate({ name: TOOL_PREFIX + 'take_snapshot' }, next)
  assert.equal(delegated, 2)
  // sensitive -> ask, no delegation
  const r3 = await gate({ name: TOOL_PREFIX + 'click' }, next)
  assert.equal(delegated, 2)
  assert.equal(r3.kind, 'ask')
})

test('listener reads settings fresh per call (volatile liveness)', async () => {
  const registered = []
  const ctx = { on: (n, fn) => { registered.push({ name: n, fn }); return () => {} } }
  let policy = 'sensitive'
  registerApprovalGate(ctx, () => ({ policy, readOnlyTools: [] }))
  const gate = registered[0].fn
  const next = async () => ({ kind: 'allow' })
  assert.equal((await gate({ name: TOOL_PREFIX + 'click' }, next)).kind, 'ask')
  policy = 'none'
  assert.deepEqual(await gate({ name: TOOL_PREFIX + 'click' }, next), { kind: 'allow' })
})

test('listener never throws on malformed payloads', async () => {
  const registered = []
  const ctx = { on: (n, fn) => { registered.push({ name: n, fn }); return () => {} } }
  registerApprovalGate(ctx, () => ({ policy: 'sensitive', readOnlyTools: [] }))
  const gate = registered[0].fn
  const next = async () => ({ kind: 'allow' })
  for (const bad of [undefined, null, {}, { name: 42 }, { name: null }]) {
    const r = await gate(bad, next)
    assert.deepEqual(r, { kind: 'allow' })
  }
})

test('default read-only list matches the documented surface', () => {
  assert.ok(DEFAULT_READ_ONLY_TOOLS.includes('take_snapshot'))
  assert.ok(!DEFAULT_READ_ONLY_TOOLS.includes('navigate_page'))
  assert.equal(new Set(DEFAULT_READ_ONLY_TOOLS).size, DEFAULT_READ_ONLY_TOOLS.length)
  assert.deepEqual([...APPROVAL_POLICIES], ['sensitive', 'all', 'none'])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/chrome-cdp && node --test test/gate.test.js`
Expected: FAIL — cannot find module `../lib/gate.js`.

- [ ] **Step 3: Implement**

`packages/chrome-cdp/lib/gate.js`:
```js
/**
 * The per-action approval gate. A global tools/pre-execute listener matches
 * the mcp__chrome-cdp__ prefix and returns {kind:'ask'} for sensitive calls;
 * the host's serviceAsk turns ask into ctx.approval.request, which the Web
 * GUI renders as Allow/Deny on the streamed tool-call card, fail-closed when
 * no approval channel is composed
 * (packages/core/tools/src/index.ts:599-612, 1517-1519, 1735-1776).
 */
export const TOOL_PREFIX = 'mcp__chrome-cdp__'
export const APPROVAL_POLICIES = ['sensitive', 'all', 'none']

/** chrome-devtools-mcp@1.9.0 tool names that never mutate browser state. */
export const DEFAULT_READ_ONLY_TOOLS = Object.freeze([
  'list_pages', 'list_network_requests', 'list_console_messages', 'list_extensions', 'list_webmcp_tools',
  'get_network_request', 'get_console_message', 'get_tab_id', 'get_os_app_state',
  'take_snapshot', 'take_screenshot', 'wait_for',
  'performance_start_trace', 'performance_stop_trace', 'performance_analyze_insight',
  'take_heapsnapshot', 'close_heapsnapshot', 'compare_heapsnapshots', 'query_heapsnapshot_objects',
  'get_heapsnapshot_class_nodes', 'get_heapsnapshot_details', 'get_heapsnapshot_dominators',
  'get_heapsnapshot_duplicate_strings', 'get_heapsnapshot_edges', 'get_heapsnapshot_object_details',
  'get_heapsnapshot_retainers', 'get_heapsnapshot_retaining_paths', 'get_heapsnapshot_summary',
])

export function decideApproval(settings, toolName) {
  const { policy, readOnlyTools } = settings ?? {}
  if (typeof toolName !== 'string' || !toolName.startsWith(TOOL_PREFIX)) return { kind: 'allow' }
  if (policy === 'none') return { kind: 'allow' }
  const bare = toolName.slice(TOOL_PREFIX.length)
  if (policy === 'sensitive' && readOnlyTools.includes(bare)) return { kind: 'allow' }
  return {
    kind: 'ask',
    reason: `chrome-cdp: ${bare} on the attached Chrome`,
    displayReason: {
      en: \`Allow the Chrome action "${bare}"?\`,
      zh: \`允许执行 Chrome 操作「${bare}」吗？\`,
    },
  }
}

/**
 * Register the global pre-execute listener. Containment: the callback never
 * throws (a plugin bug must not kill the host); on internal error it falls
 * back to asking, which is fail-closed, and delegates everything else.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {() => { policy: string, readOnlyTools: string[] }} getSettings - re-read per call.
 */
export function registerApprovalGate(ctx, getSettings) {
  return ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const name = exec?.name
      if (typeof name !== 'string' || !name.startsWith(TOOL_PREFIX)) return next()
      const decision = decideApproval(getSettings(), name)
      if (decision.kind === 'allow') return next()
      return decision
    } catch {
      // Fail closed: ask (denied when no approval channel) rather than throw.
      return { kind: 'ask', reason: 'chrome-cdp: gate error, asking as fallback' }
    }
  })
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/chrome-cdp && node --test test/gate.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/chrome-cdp/lib/gate.js packages/chrome-cdp/test/gate.test.js
git commit -m "chrome-cdp: per-action approval gate (TDD)"
```

---

### Task 4: host half — wiring, status, slash command

**Files:**
- Create: `packages/chrome-cdp/index.js`
- Create: `packages/chrome-cdp/lib/wire.js`
- Create: `packages/chrome-cdp/lib/status.js`
- Test: `packages/chrome-cdp/test/wire.test.js`

**Interfaces:**
- Consumes: `buildSpawn` (Task 2), `registerApprovalGate`, `APPROVAL_POLICIES`, `DEFAULT_READ_ONLY_TOOLS`, `TOOL_PREFIX` (Task 3).
- Produces: `index.js` exports cordis plugin `{ name, inject, Config, apply }`; `lib/wire.js` exports `wireChromeCdp(ctx, config, deps?)` (deps default \`{ mountSessionMcp }\` from the runtime — injectable for tests); `lib/status.js` exports `ChromeCdpStatus` (TypertRemoteService) and `registerStatus(ctx, getState, deps?)\`.

**Volatile-wiring rule (binding):** before implementing, READ the loader's volatile-update semantics in the dsh checkout (`packages/boot/hmr`, `docs/cordis-tutorial/05-config.md` "Volatile fields", event `loader/volatile-update`) and wire `getSettings()` so policy/readOnlyTools changes apply WITHOUT remount. If (and only if) the loader swaps the whole config object, subscribe to `loader/volatile-update` and re-capture the reference. Cite the source path in a comment. Mode/endpoint/channel are structural: mount args are bound at plugin activation (mountSessionMcp takes static args — packages/experimental/browser-use-runtime/src/mcp.ts:102-107), so document "connection changes apply after plugin reload" in README (Task 6) — spec deviation recorded as controller ruling.

- [ ] **Step 1: Write failing tests**

`packages/chrome-cdp/test/wire.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wireChromeCdp } from '../lib/wire.js'
import { TOOL_PREFIX } from '../lib/gate.js'

function makeCtx() {
  const calls = { mount: null, events: {}, commands: null, services: [] }
  const ctx = {
    on(name, fn) { (calls.events[name] ??= []).push(fn); return () => {} },
    effect(fn) { return () => {} },
    get(name) { return name === 'commands' ? { register: (def) => { calls.commands = def; return () => {} } } : undefined },
    browserUse: { register: (n) => () => {} },
    commands: undefined,
  }
  return { ctx, calls }
}

const baseConfig = { mode: 'url', endpoint: 'http://127.0.0.1:9223', channel: 'stable', approvalPolicy: 'sensitive', readOnlyTools: undefined, toolCallTimeoutMs: 45000 }

test('wire mounts the MCP server exclusively with assembled args', () => {
  const { ctx, calls } = makeCtx()
  const mount = (receivedCtx, options) => { calls.mount = options }
  wireChromeCdp(ctx, baseConfig, { mountSessionMcp: mount })
  assert.ok(calls.mount, 'mountSessionMcp called')
  assert.equal(calls.mount.name, 'chrome-cdp')
  assert.equal(calls.mount.exclusive, true)
  assert.equal(calls.mount.command, process.execPath)
  assert.ok(calls.mount.args[0].endsWith('/build/src/bin/chrome-devtools-mcp.js'))
  assert.deepEqual(calls.mount.args.slice(-2), ['--browser-url', 'http://127.0.0.1:9223'])
  assert.equal(calls.mount.toolCallTimeoutMs, 45000)
})

test('wire registers the approval gate listener', () => {
  const { ctx, calls } = makeCtx()
  wireChromeCdp(ctx, baseConfig, { mountSessionMcp: () => {} })
  assert.ok(calls.events['tools/pre-execute']?.length === 1)
})

test('wire registers the status remote and /cdc command (contained when services are absent)', () => {
  const { ctx, calls } = makeCtx()
  ctx.get = () => undefined // no commands service
  wireChromeCdp(ctx, baseConfig, { mountSessionMcp: () => {} })
  assert.equal(calls.commands, null)
})

test('invalid mode/endpoint combos throw at wiring time', () => {
  const { ctx } = makeCtx()
  assert.throws(() => wireChromeCdp(ctx, { ...baseConfig, mode: 'url', endpoint: undefined }, { mountSessionMcp: () => {} }), /endpoint/i)
  assert.throws(() => wireChromeCdp(ctx, { ...baseConfig, mode: 'auto', endpoint: 'http://x' }, { mountSessionMcp: () => {} }), /auto/i)
})

test('gate reads policy live from the config object', async () => {
  const { ctx, calls } = makeCtx()
  const cfg = { ...baseConfig }
  wireChromeCdp(ctx, cfg, { mountSessionMcp: () => {} })
  const gate = calls.events['tools/pre-execute'][0]
  const next = async () => ({ kind: 'allow' })
  assert.equal((await gate({ name: TOOL_PREFIX + 'click' }, next)).kind, 'ask')
  cfg.approvalPolicy = 'none'
  assert.deepEqual(await gate({ name: TOOL_PREFIX + 'click' }, next), { kind: 'allow' })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/chrome-cdp && node --test test/wire.test.js`
Expected: FAIL — cannot find module `../lib/wire.js`.

- [ ] **Step 3: Implement the three files**

`packages/chrome-cdp/lib/status.js`:
```js
/**
 * Status surface: a Typert remote service the Plugins card reads, plus the
 * /cdc slash command. Modeled on feishu-gateway's diagnostics remote
 * (packages/feishu-gateway/lib/diagnostics.js; marker shape from
 * packages/typert/protocol — decorator syntax is unavailable in plain ESM).
 * Contained: every method try/catches; diagnostics must never destabilize
 * the host.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export class ChromeCdpStatus extends TypertRemoteService {
  constructor(ctx, getState) {
    super(ctx, 'chromeCdp', { namespace: 'chromeCdp' })
    this.getStateFn = getState
  }

  /** Config snapshot + upstream entry for the Plugins card. @Remote */
  status() {
    try { return this.getStateFn() } catch { return { available: false } }
  }
}

{
  const direct = Object.freeze({ kind: 'direct' })
  Object.defineProperty(ChromeCdpStatus.prototype, REMOTE_METHODS, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([Object.freeze({ method: 'status', invocation: direct })]),
    }),
  })
}

/** Register the remote service and the /cdc slash command (both contained). */
export function registerStatus(ctx, getState) {
  const disposers = []
  // A cordis Service self-registers with ctx and its lifecycle follows the
  // fiber — plain construction in try/catch is the feishu-gateway pattern
  // (packages/feishu-gateway/index.js:168-173). The slash command is optional
  // (packages/interaction/commands/src/index.ts: ctx.commands.register).
  try { new ChromeCdpStatus(ctx, getState) } catch (error) { ctx.logger?.warn?.(`chrome-cdp: status service failed to register: ${String(error)}`) }
  const commands = (() => { try { return ctx.get('commands') } catch { return undefined } })()
  if (commands !== undefined) {
    try {
      disposers.push(commands.register({
        name: 'cdc',
        description: 'Chrome CDP connection status (chrome-cdp plugin)',
        handler: async () => {
          try {
            const s = getState()
            return { kind: 'success', text: JSON.stringify(s, null, 2) }
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) }
          }
        },
      }))
    } catch {}
  }
  return () => { for (const d of disposers) { try { d?.() } catch {} } }
}
```

`packages/chrome-cdp/lib/wire.js`:
```js
/**
 * Host-half wiring: exclusive per-Session MCP mount + approval gate + status.
 * mountSessionMcp owns browserUse.register, per-Agent scopes, exclusivity,
 * busy-session masking, and creation-time discovery
 * (packages/experimental/browser-use-runtime/src/mcp.ts:102-194).
 * deps is injectable so tests never spawn real processes.
 */
import { buildSpawn } from './args.js'
import { registerApprovalGate, DEFAULT_READ_ONLY_TOOLS } from './gate.js'
import { registerStatus } from './status.js'
import * as Runtime from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'

export function wireChromeCdp(ctx, config, deps = {}) {
  const mountSessionMcp = deps.mountSessionMcp ?? Runtime.mountSessionMcp
  // Structural settings are validated here so bad config fails the load
  // ("Bad config fails the load with a precise error", docs/cordis-tutorial/05-config.md).
  const spawn = buildSpawn({ mode: config.mode, endpoint: config.endpoint, channel: config.channel })
  mountSessionMcp(ctx, {
    name: 'chrome-cdp',
    exclusive: true,
    command: spawn.command,
    args: spawn.args,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
  const getSettings = () => ({
    policy: config.approvalPolicy ?? 'sensitive',
    readOnlyTools: config.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS,
  })
  registerApprovalGate(ctx, getSettings)
  const getState = () => ({
    mode: config.mode,
    ...config.endpoint === undefined ? {} : { endpoint: config.endpoint },
    channel: config.channel ?? 'stable',
    approvalPolicy: getSettings().policy,
    readOnlyToolCount: getSettings().readOnlyTools.length,
    serverEntry: spawn.args[0],
    exclusive: true,
  })
  registerStatus(ctx, getState)
}
```

`packages/chrome-cdp/index.js`:
```js
/**
 * dsh-chrome-cdp host half. Connection modes and the approval gate are
 * documented in README.md; the spec is docs/specs/2026-10-19-chrome-cdp-design.md.
 * Every field is volatile so the Plugins-page form can edit it; structural
 * fields (mode/endpoint/channel) take effect after plugin reload — behavioral
 * fields (approvalPolicy/readOnlyTools) apply live.
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
```
If `Schema.array(String)` or `Schema.union([...const])` rejects these shapes at runtime, verify against the installed schemastery (`@deepseek-ai/schemastery` types) and use the equivalent constructor — record the deviation in the report.

- [ ] **Step 4: Run tests**

Run: `cd packages/chrome-cdp && node --test`
Expected: PASS — args, gate, wire suites all green.

- [ ] **Step 5: Commit**

```bash
git add packages/chrome-cdp/index.js packages/chrome-cdp/lib/wire.js packages/chrome-cdp/lib/status.js packages/chrome-cdp/test/wire.test.js
git commit -m "chrome-cdp: host-half wiring, status remote, /cdc command (TDD)"
```

---

### Task 5: client half — Plugins-page config card

**Files:**
- Create: `packages/chrome-cdp/client.js`
- Test: `packages/chrome-cdp/test/client.test.js`

**Interfaces:**
- Consumes: `packages.bundle.config` slot (key `dsh-chrome-cdp`), `ctx.configForms.get('chrome-cdp')`, remote namespace `chromeCdp.status()`.
- Produces: mounted card component (module id `dsh-chrome-cdp`).

- [ ] **Step 1: Write failing test (structural smoke)**

`packages/chrome-cdp/test/client.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom' // NOT available — see note; use a minimal fake instead
```
Replace that draft with this minimal-fake version (no jsdom dependency allowed):
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('client.js loads through __ModuleLoader__ and registers the config card slot', async () => {
  const registered = []
  const loaded = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(def) { loaded.id = def.id; loaded.inject = undefined; def.factory(require); },
    },
  }
  const modules = {
    react: { createElement: () => ({}) },
    '@deepseek-ai/dsh-client-ui-primitives': {
      SettingsForm: () => ({}), SettingsValueField: () => ({}), SettingsFormModel: class {},
      settingsTextField: () => () => ({}), SettingsSelectField: () => ({}),
    },
  }
  const require = (id) => modules[id]
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const fn = new Function('window', 'require', src) // executes the module body
  fn(globalThis.window, require)
  assert.equal(loaded.id, 'dsh-chrome-cdp')
})
```
The test asserts the module loads under a fake loader and registers nothing that throws. Extend `modules` as needed to satisfy real imports found while implementing; if `client.js` needs a DOM API at load time, guard it (pattern: feishu client.js only touches DOM inside components).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/chrome-cdp && node --test test/client.test.js`
Expected: FAIL — client.js does not exist.

- [ ] **Step 3: Implement**

`packages/chrome-cdp/client.js` — model on `packages/feishu-gateway/client.js` (READ IT FIRST: locale dictionaries, formLabels, textField factory, buildConfigCard model, slots.inject('plugins.bundle.config', ...) registration at client.js:355-358, remote namespace lookup at :147-157). Shape to implement:
```js
window.__ModuleLoader__.load({ id: 'dsh-chrome-cdp', factory(require) {
  const React = require('react')
  const h = React.createElement
  const { SettingsForm, SettingsValueField, SettingsSelectField, SettingsFormModel } = require('@deepseek-ai/dsh-client-ui-primitives')
  const ROW = 'chrome-cdp'
  const NS = 'chromeCdp'
  const zh = { /* config.summary/mode/modeHint/endpoint/... + status.* keys, feishu style */ }
  const en = { /* English twins */ }
  // Card: summary line, mode select (auto/url/ws), endpoint text field,
  // channel text field, approvalPolicy select (sensitive/all/none),
  // readOnlyTools textarea (one name per line, blank = default),
  // toolCallTimeoutMs number field; status section reads
  // ctx.get('remote.chromeCdp')?.status() with graceful "unavailable".
  // Registration: ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () =>
  //   ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-chrome-cdp', locale: NS, inject: card.face }, Card)),
  //   'dsh-chrome-cdp: bundle config card')
  return { inject: ['slots', 'locale', 'configForms', 'remote'], apply(ctx) { /* as above */ } }
} })
```
The comment block above defines REQUIRED structure and exact registration calls; fill the card body by adapting feishu's `buildConfigCard`/`textField`/`formLabels` helpers (client.js:110-165) — keep field ids prefixed `chrome-cdp-config-`. Implementer note: the plan's reviewers will check the slot registration line and the remote lookup containment verbatim; visual polish is not graded.

- [ ] **Step 4: Run test**

Run: `cd packages/chrome-cdp && node --test test/client.test.js && node --check client.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chrome-cdp/client.js packages/chrome-cdp/test/client.test.js
git commit -m "chrome-cdp: Plugins-page config card (client half)"
```

---

### Task 6: live-host verification + README

**Files:**
- Modify: `packages/chrome-cdp/README.md` (full docs)
- Scratch: `.scratch/sdd/2026-10-19-chrome-cdp/task-6-live.txt`

**Interfaces:**
- Consumes: the finished bundle; the B-spike rig pattern (research note §7): workspace `.scratch/dsh-btest` home, headless profile with chrome-cdp bundle added, local chromium on a debug port.

- [ ] **Step 1: Rebuild the rig under `.scratch/dsh-btest2/`**

```bash
W=/home/ramuz/skills-workspace/dsharp/.scratch/dsh-btest2
mkdir -p $W/profiles/headless $W/ws
cp ~/.dsh/.env $W/.env && chmod 600 $W/.env
ln -s ~/.dsh/profiles/node_modules $W/profiles/node_modules
cat > $W/profiles/headless/package.json <<'EOF'
{ "name": "dsh-profile-btest2", "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-chrome-cdp"] } },
  "dependencies": { "dsh-chrome-cdp": "link:/home/ramuz/skills-workspace/dsharp/packages/chrome-cdp" } }
EOF
printf '[]\n' > $W/profiles/headless/cordis.yml
cat > $W/profiles/headless/cordis.patch.yml <<'EOF'
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      zai-coding-cn: { apiKeyEnv: ZAI_CODING_CN_API_KEY, models: [{ id: glm-5.3, name: GLM-5.3, contextWindow: 1000000, maxTokens: 131072 }] }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: zai-coding-cn, model: glm-5.3 }
EOF
cd /home/ramuz/deepseek-harness && DSH_HOME=$W pnpm dsh --profile headless --dump-config 2>&1 | tail -5
```
Then install bundle deps: `cd $W/profiles/headless && pnpm install --no-frozen-lockfile` (falls back to the link: dependency; if pnpm cannot run there, instead symlink: `mkdir -p $W/profiles/headless/node_modules && ln -s /home/ramuz/skills-workspace/dsharp/packages/chrome-cdp $W/profiles/headless/node_modules/dsh-chrome-cdp` and also link its two runtime deps from the dsh checkout node_modules — record which path worked).
Expected: dump-config exit 0 and the composed tree contains a `chrome-cdp` row with the bundle's patch layer.

- [ ] **Step 2: Chromium on a debug port**

```bash
~/.cache/ms-playwright/chromium-1134/chrome-linux/chrome --headless=new --remote-debugging-port=9224 --user-data-dir=/home/ramuz/skills-workspace/dsharp/.scratch/dsh-btest2/chrome-profile --no-first-run --no-default-browser-check --disable-gpu about:blank &
sleep 3; curl -s http://127.0.0.1:9224/json/version | head -c 120
```
Expected: version JSON.

- [ ] **Step 3: Policy-none E2E (approval disabled)**

Add `approvalPolicy: none` + `mode: url` + `endpoint: http://127.0.0.1:9224` to the `chrome-cdp` row config in the patch yml, then run the one-shot:
```bash
cd /home/ramuz/deepseek-harness && DSH_HOME=$W node --import tsx/esm apps/cli/src/bin.ts --profile headless "Use the chrome-cdp browser tools to open https://example.com and report the page title and the number of open tabs." 2>&1 | tail -20
```
Expected: answer grounded in the real browser (title "Example Domain", 2 tabs). Record output in task-6-live.txt.

- [ ] **Step 4: Sensitive policy gates (fail-closed without a GUI approval channel)**

Switch the row to `approvalPolicy: sensitive`, rerun the same task. Expected: the agent reports the browser action was NOT allowed (headless host has no approval answerer -> serviceAsk denies). Record output.

- [ ] **Step 5: Host stability**

Assert the one-shot exits 0 both runs and no `dsh: fatal` lines appear; kill the chromium by exact pid recorded at start.

- [ ] **Step 6: README**

Full README: install (`dsh plugin add`), the three connection modes with concrete copy-paste configs (auto for same-OS Chrome >=144 with chrome://inspect#remote-debugging; url for port-mapped endpoints incl. WSL->Windows; ws), approval policies + default read-only list, `/cdc`, security baseline paragraph (unauthenticated endpoint; gate is consent, not a sandbox), reload semantics for structural fields, and the AGENTS.md live-host test summary.

- [ ] **Step 7: Commit**

```bash
git add packages/chrome-cdp/README.md
git commit -m "chrome-cdp: live-host verification + full README"
```
