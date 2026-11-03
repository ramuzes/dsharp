import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wireChromeCdp } from '../lib/wire.js'
import { TOOL_PREFIX } from '../lib/gate.js'

// Fake of the SHARED commands runtime. Mirrors the real ownership premise
// (packages/interaction/commands/src/index.ts:285-292): register() owns its
// effect on the RUNTIME'S OWN ctx, so the disposer it returns is the ONLY
// unregister path, and a duplicate name in the layer throws (index.ts:96-104,
// NamedEntries insert). It deliberately does NOT tie registrations to a
// plugin ctx — a fake that auto-disposed with the plugin ctx would erase the
// stale-/cdc premise the I1 regression tests rely on.
function makeCommandsRuntime(onRegister = () => {}) {
  const runtime = {
    registered: new Map(),
    register(def) {
      if (runtime.registered.has(def.name)) throw new Error(`command "${def.name}" is already registered (for a per-agent variant, mount a command-injected plugin under that agent's \`agent.ctx\`)`)
      const entry = { def, disposed: false }
      runtime.registered.set(def.name, entry)
      onRegister(def)
      return () => { entry.disposed = true; runtime.registered.delete(def.name) }
    },
  }
  return runtime
}

function makeCtx(sharedRuntime) {
  const calls = { mount: null, events: {}, commands: null, services: [], effects: [] }
  const commandsRuntime = sharedRuntime ?? makeCommandsRuntime((def) => { calls.commands = def })
  const ctx = {
    on(name, fn) { (calls.events[name] ??= []).push(fn); return () => {} },
    // Mirrors cordis fiber.effect (node_modules/@deepseek-ai/cordis/lib/types/
    // fiber.d.ts:145-157): the body runs now, its returned disposer is kept
    // by the fiber, and plugin unload invokes it.
    effect(fn, label) {
      const dispose = fn()
      calls.effects.push({ label, dispose })
      return () => {
        const index = calls.effects.findIndex((e) => e.dispose === dispose)
        if (index >= 0) { calls.effects.splice(index, 1); dispose?.() }
      }
    },
    get(name) { return name === 'commands' ? commandsRuntime : undefined },
    browserUse: { register: (n) => () => {} },
    commands: undefined,
  }
  return { ctx, calls, commandsRuntime }
}

/** Simulate plugin unload (the Plugins-page toggle): the fiber runs every effect disposer. */
function unloadPlugin(calls) {
  for (const { dispose } of calls.effects.splice(0)) dispose?.()
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

test('status /cdc registration is owned by the plugin ctx effect (disposer runs at unload)', () => {
  const { ctx, calls, commandsRuntime } = makeCtx()
  wireChromeCdp(ctx, baseConfig, { mountSessionMcp: () => {} })
  assert.ok(commandsRuntime.registered.has('cdc'), '/cdc registered')
  assert.ok(calls.effects.some((e) => e.label === 'chrome-cdp: status'), "registration wrapped in ctx.effect labeled 'chrome-cdp: status'")
  unloadPlugin(calls)
  assert.equal(commandsRuntime.registered.has('cdc'), false, '/cdc disposed when the plugin ctx is destroyed')
})

test('after unload + re-load (the README toggle flow) /cdc serves the fresh state, not a stale one', async () => {
  const runtime = makeCommandsRuntime()
  const first = makeCtx(runtime)
  wireChromeCdp(first.ctx, { ...baseConfig, endpoint: 'http://127.0.0.1:9222' }, { mountSessionMcp: () => {} })
  unloadPlugin(first.calls) // toggle OFF
  const second = makeCtx(runtime) // toggle ON: new plugin ctx, same global command layer
  wireChromeCdp(second.ctx, { ...baseConfig, endpoint: 'http://127.0.0.1:9333' }, { mountSessionMcp: () => {} })
  const { def } = runtime.registered.get('cdc')
  const result = await def.handler()
  assert.equal(result.kind, 'success')
  assert.equal(JSON.parse(result.text).endpoint, 'http://127.0.0.1:9333', 're-loaded /cdc reports the new endpoint')
})

test('/cdc reports the pinned upstream version (spec Status bullet)', async () => {
  const { ctx, calls } = makeCtx()
  wireChromeCdp(ctx, baseConfig, { mountSessionMcp: () => {} })
  const result = await calls.commands.handler()
  assert.equal(result.kind, 'success')
  assert.equal(JSON.parse(result.text).upstreamVersion, '1.9.0')
})

test('schemastery volatile refs (frozen { get() }) are unwrapped and read live by the gate', async () => {
  const { ctx, calls } = makeCtx()
  // Hand-shaped exactly as Task 4 documented the Loader handing volatile
  // fields to apply() (docs/cordis-tutorial/05-config.md "Volatile fields";
  // wire.js header): a frozen reference object read via .get(), never swapped.
  let policy = 'sensitive'
  const approvalPolicy = Object.freeze({ get: () => policy })
  wireChromeCdp(ctx, { ...baseConfig, approvalPolicy }, { mountSessionMcp: () => {} })
  const gate = calls.events['tools/pre-execute'][0]
  const next = async () => ({ kind: 'allow' })
  const tool = { name: TOOL_PREFIX + 'click' }
  assert.equal((await gate(tool, next)).kind, 'ask', 'ref unwrapped: sensitive policy applies')
  policy = 'none' // volatile edit commits INTO the same reference
  assert.deepEqual(await gate(tool, next), { kind: 'allow' }, 'ref re-read per call: policy edit applies live')
})
