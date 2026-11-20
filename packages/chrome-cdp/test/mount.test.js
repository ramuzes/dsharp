import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountPerSession } from '../lib/mount.js'

/**
 * A plugin namespace shaped like @deepseek-ai/dsh-mcp-client (Config + apply),
 * where apply records each accepted mount. A failFirst client models a
 * startup failure that later recovers.
 */
const fakeMcpClient = (failFirst = false) => {
  const applied = []
  let calls = 0
  const ns = {
    Config: (cfg) => cfg,
    apply: async (ctx, cfg) => {
      calls++
      if (failFirst && calls === 1) throw new Error('stdio handshake failed')
      applied.push(cfg)
    },
  }
  return { ns, applied }
}

/** One agent with its own cordis-like ctx. Mounting RUNS the plugin apply;
 *  the registration counts as landed only after apply succeeds. */
function makeAgent() {
  const agent = {
    ctx: {
      plugins: [],
      effects: [],
      plugin: async (ns, cfg) => {
        await ns.apply(agent.ctx, cfg)
        agent.ctx.plugins.push({ ns, cfg })
      },
      effect: (fn, label) => { agent.ctx.effects.push({ fn, label }) },
    },
  }
  return agent
}

function makeCtx() {
  const listeners = {}
  const ctx = { on: (name, fn, opts) => { (listeners[name] ??= []).push({ fn, opts }); return () => {} } }
  return { ctx, listeners }
}

const OPTIONS = { name: 'chrome-cdp', command: 'node', args: ['/entry.js', '--flag'] }

test('first agent mounts the MCP plugin with the assembled config', async () => {
  const { ctx, listeners } = makeCtx()
  const { ns } = fakeMcpClient()
  mountPerSession(ctx, OPTIONS, { McpClient: ns })
  const created = listeners['agent/created'][0]
  assert.equal(created.opts.prepend, true, 'mount waits for discovery before queued input')
  const agent = makeAgent()
  await created.fn({ agent })
  assert.equal(agent.ctx.plugins.length, 1)
  const cfg = agent.ctx.plugins[0].cfg
  assert.equal(cfg.serverName, 'chrome-cdp')
  assert.deepEqual(cfg.args, OPTIONS.args)
  assert.equal(cfg.failOnStartupError, true)
  assert.deepEqual(cfg.reconnect, { enabled: false })
})

test('second agent while held mounts nothing; release lets a new agent claim', async () => {
  const { ctx, listeners } = makeCtx()
  const { ns } = fakeMcpClient()
  mountPerSession(ctx, OPTIONS, { McpClient: ns })
  const created = listeners['agent/created'][0].fn
  const a1 = makeAgent()
  await created({ agent: a1 })
  const a2 = makeAgent()
  await created({ agent: a2 })
  assert.equal(a2.ctx.plugins.length, 0, 'busy endpoint mounts nothing for the second agent')
  a1.ctx.effects[0].fn() // holder fiber ends, releasing the claim
  const a3 = makeAgent()
  await created({ agent: a3 })
  assert.equal(a3.ctx.plugins.length, 1, 'a new Session claims the released mount')
})

test('a stale release never clears a newer claim', async () => {
  const { ctx, listeners } = makeCtx()
  const { ns } = fakeMcpClient()
  mountPerSession(ctx, OPTIONS, { McpClient: ns })
  const created = listeners['agent/created'][0].fn
  const a1 = makeAgent()
  await created({ agent: a1 })
  const staleRelease = a1.ctx.effects[0].fn
  staleRelease() // a1 releases; endpoint free
  const a2 = makeAgent()
  await created({ agent: a2 })
  assert.equal(a2.ctx.plugins.length, 1, 'a2 claims the free endpoint')
  staleRelease() // a1's stale release again - must not clear a2's claim
  const a3 = makeAgent()
  await created({ agent: a3 })
  assert.equal(a3.ctx.plugins.length, 0, 'current holder still holds')
})

test('mount failure is contained; the next agent retries', async () => {
  const { ctx, listeners } = makeCtx()
  const { ns } = fakeMcpClient(true) // first apply fails, second succeeds
  mountPerSession(ctx, OPTIONS, { McpClient: ns })
  const created = listeners['agent/created'][0].fn
  const a1 = makeAgent()
  await created({ agent: a1 })
  assert.equal(a1.ctx.plugins.length, 0, 'failed mount is contained')
  const a2 = makeAgent()
  await created({ agent: a2 })
  assert.equal(a2.ctx.plugins.length, 1, 'next agent mounts after a contained failure')
})

test('abort before mount skips the agent', async () => {
  const { ctx, listeners } = makeCtx()
  const { ns, applied } = fakeMcpClient()
  mountPerSession(ctx, OPTIONS, { McpClient: ns })
  const created = listeners['agent/created'][0].fn
  const signal = { throwIfAborted: () => { throw new Error('aborted') } }
  const agent = makeAgent()
  await created({ agent, signal })
  assert.equal(applied.length, 0, 'aborted agent never mounts')
})
