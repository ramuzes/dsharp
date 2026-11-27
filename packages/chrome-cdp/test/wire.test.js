import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wireChromeCdp } from '../lib/wire.js'
import { TOOL_PREFIX } from '../lib/gate.js'
import { READ_ONLY_BY_SERVER } from '../lib/servers.js'

function makeCtx() {
  const calls = { events: {}, effects: [], commands: null }
  const ctx = {
    on(name, fn, opts) { (calls.events[name] ??= []).push({ fn, opts }); return () => {} },
    effect(fn, label) { calls.effects.push({ fn, label }); return () => {} },
    get(name) { return name === 'commands' ? { register: (def) => { calls.commands = def; return () => {} } } : undefined },
  }
  return { ctx, calls }
}

const baseConfig = {
  server: 'playwright', mode: 'url', endpoint: 'http://127.0.0.1:9223',
  channel: 'stable', headless: false, browser: 'chrome',
  approvalPolicy: 'sensitive', readOnlyTools: [], toolCallTimeoutMs: 45000,
}

test('wire mounts per-Session exclusively with the assembled args', () => {
  const { ctx, calls } = makeCtx()
  const mounts = []
  wireChromeCdp(ctx, baseConfig, { mountPerSession: (c, o) => { mounts.push(o) } })
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].name, 'chrome-cdp')
  assert.equal(mounts[0].command, process.execPath)
  assert.ok(mounts[0].args[0].endsWith('/@playwright/mcp/cli.js'), mounts[0].args[0])
  assert.deepEqual(mounts[0].args.slice(1), ['--cdp-endpoint', 'http://127.0.0.1:9223'])
  assert.equal(mounts[0].toolCallTimeoutMs, 45000)
})

test('wire registers the approval gate listener', () => {
  const { ctx, calls } = makeCtx()
  wireChromeCdp(ctx, baseConfig, { mountPerSession: () => {} })
  assert.equal(calls.events['tools/pre-execute']?.length, 1)
})

test('chrome-devtools server keeps its dialect and channel flag only in auto', () => {
  const { ctx, calls } = makeCtx()
  const mounts = []
  wireChromeCdp(ctx, { ...baseConfig, server: 'chrome-devtools', mode: 'auto', endpoint: undefined }, { mountPerSession: (c, o) => mounts.push(o) })
  assert.ok(mounts[0].args[0].endsWith('/build/src/bin/chrome-devtools-mcp.js'))
  assert.deepEqual(mounts[0].args.slice(1), ['--no-usage-statistics', '--channel', 'stable', '--auto-connect'])
})

test('invalid mode/server combos throw at wiring time', () => {
  const { ctx } = makeCtx()
  assert.throws(() => wireChromeCdp(ctx, { ...baseConfig, mode: 'auto' }, { mountPerSession: () => {} }), /mode must be one of/i)
  assert.throws(() => wireChromeCdp(ctx, { ...baseConfig, server: 'chrome-devtools', mode: 'extension' }, { mountPerSession: () => {} }), /mode must be one of/i)
  assert.throws(() => wireChromeCdp(ctx, { ...baseConfig, endpoint: undefined }, { mountPerSession: () => {} }), /endpoint is required/i)
})

test('an unconfigured mode mounts with the default (extension) instead of failing the load', () => {
  const { ctx } = makeCtx()
  const mounts = []
  // A freshly installed profile has no config row for this plugin: mode and
  // endpoint arrive absent (the schema fills mode with DEFAULT_MODE, index.js).
  // Regression for the desktop first-run failure "mode must be one of launch /
  // url / ws / extension for server playwright (got: undefined)".
  wireChromeCdp(ctx, { ...baseConfig, mode: undefined, endpoint: undefined }, { mountPerSession: (c, o) => { mounts.push(o) } })
  assert.equal(mounts.length, 1)
  assert.deepEqual(mounts[0].args.slice(1), ['--extension'])
  // A defaulted mode still may not carry an endpoint.
  assert.throws(() => wireChromeCdp(ctx, { ...baseConfig, mode: undefined }, { mountPerSession: () => {} }), /endpoint must not be set in extension mode/i)
})

test('gate reads policy and per-server list live from the config', async () => {
  const { ctx, calls } = makeCtx()
  const cfg = { ...baseConfig }
  wireChromeCdp(ctx, cfg, { mountPerSession: () => {} })
  const gate = calls.events['tools/pre-execute'][0].fn
  const next = async () => ({ kind: 'allow' })
  // playwright default list: browser_snapshot allowed, click asks
  assert.deepEqual(await gate({ name: TOOL_PREFIX + 'browser_snapshot' }, next), { kind: 'allow' })
  assert.equal((await gate({ name: TOOL_PREFIX + 'browser_click' }, next)).kind, 'ask')
  cfg.readOnlyTools = ['browser_click'] // wholesale replace, live
  assert.deepEqual(await gate({ name: TOOL_PREFIX + 'browser_click' }, next), { kind: 'allow' })
  cfg.approvalPolicy = 'none'
  assert.deepEqual(await gate({ name: TOOL_PREFIX + 'navigate_page' }, next), { kind: 'allow' })
})

test('env dict values arrive deep-unwrapped at the mount', () => {
  const { ctx, calls } = makeCtx()
  const mounts = []
  const wrapped = { get: () => '/w/pw-cache' }
  wireChromeCdp(ctx, { ...baseConfig, env: { PLAYWRIGHT_BROWSERS_PATH: wrapped } }, { mountPerSession: (c, o) => mounts.push(o) })
  assert.deepEqual(mounts[0].env, { PLAYWRIGHT_BROWSERS_PATH: '/w/pw-cache' })
})

test('status effect is registered through the plugin fiber (I1 regression)', () => {
  const { ctx, calls } = makeCtx()
  wireChromeCdp(ctx, baseConfig, { mountPerSession: () => {} })
  assert.ok(calls.effects.some((e) => String(e.label || '').includes('status')), 'status registered via ctx.effect')
})

test('empty readOnlyTools uses the server defaults; explicit replaces wholesale', () => {
  const { ctx, calls } = makeCtx()
  const cfg = { ...baseConfig, readOnlyTools: ['browser_click'] }
  let captured = null
  // capture via the gate: snapshot the resolved list through a probe call
  wireChromeCdp(ctx, cfg, { mountPerSession: () => {} })
  const gate = calls.events['tools/pre-execute'][0].fn
  const next = async () => ({ kind: 'allow' })
  return gate({ name: TOOL_PREFIX + 'browser_snapshot' }, next).then((r) => {
    assert.equal(r.kind, 'ask', 'snapshot not in the replaced list -> asks')
  })
})
