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
