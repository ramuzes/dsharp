// tests/driver.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayDriver } from '../lib/driver.js'
import { BindingRouter } from '../lib/router.js'

/** Minimal fake of the host surface the driver consumes. */
function makeCtx() {
  const agents = new Map()
  const workspaces = [
    { id: 'w1', title: 'demo', path: '/tmp/demo' },
    { id: 'w2', title: 'site', path: '/tmp/site' },
  ]
  const sent = []
  let seq = 0
  const ctx = {
    sent,
    agents: {
      get: id => agents.get(id),
      create: async opts => {
        const agent = makeAgent(opts)
        agents.set(agent.session.id, agent)
        return { agent }
      },
      resume: async ({ resumeSessionId }) => {
        const agent = agents.get(resumeSessionId) ?? makeAgent({ sessionId: resumeSessionId, meta: { cwd: '/tmp/demo' } })
        agents.set(agent.session.id, agent)
        return { agent }
      },
    },
    workspaceRegistry: {
      list: () => workspaces,
      create: async (path, title) => {
        const w = { id: `w${workspaces.length + 1}`, title: title ?? path, path }
        workspaces.push(w)
        return w
      },
      resolveByPath: async path => workspaces.find(w => w.path === path),
      attachSession: () => {},
    },
    workspaceChanges: {
      summary: (sessionId) => ({ turn: 1, total: 3, added: 5, deleted: 1, files: [{ path: 'a.js', added: 4, deleted: 1 }] }),
      diff: async () => '@@ -1 +1 @@\n-old\n+new',
    },
    apiSessions: { selectModel: async () => {} },
    llm: { listModels: async () => [{ provider: 'deepseek', models: [{ id: 'deepseek-chat' }] }] },
  }
  function makeAgent(opts) {
    const id = opts.sessionId ?? `s${++seq}`
    return {
      status: 'idle',
      session: { id, header: { cwd: opts.meta?.cwd ?? '/tmp/demo' }, title: () => `session ${id}`, lastAssistantText: () => `done: ${id}` },
      followuped: [],
      followup(text, source) { this.followuped.push({ text, source }); this.status = 'running'; this.lastUserSource = source },
      steer(text) { this.steered = text },
      interrupt() { this.status = 'idle' },
    }
  }
  return ctx
}

function makeDriver(ctx) {
  const sent = []
  const lark = {
    sendText: async (c, t) => sent.push({ type: 'text', text: t }),
    sendJson: async (c, mt, content) => sent.push({ type: mt, content }),
  }
  const router = new BindingRouter()
  const driver = new GatewayDriver({
    ctx, lark, router,
    config: { commandPrefix: '/', messageChunkLimit: 8000 },
    logger: console,
    makeActionId: () => `act_${sent.length}`,
  })
  driver.sent = sent
  return { driver, sent, router }
}

test('plain message with no binding asks the user to bind a workspace', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: 'do something' })
  assert.match(JSON.stringify(sent), /\/ws/)
})

test('message after /ws use flows into a new session then resume+followup', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  const card = sent.find(s => s.type === 'interactive')
  assert.ok(card, 'status card sent')
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix the bug' })
  // the first task message created a session in /tmp/demo
  const binding = await driver.router.get('oc_1')
  assert.equal(binding.activeSessionId.startsWith('s'), true)
  assert.equal(binding.workspacePath, '/tmp/demo')
})

test('turn end sends assistant text then changes card', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  agent.lastUserSource = { kind: 'feishu', chatId: 'oc_1' }
  await driver.onSessionEvent(agent.session, { type: 'turn/end', seq: 1 })
  assert.ok(sent.some(s => s.type === 'text' && /done:/.test(s.text)), 'assistant text sent')
  assert.ok(sent.some(s => s.type === 'interactive' && /改动摘要/.test(JSON.stringify(s.content))), 'changes card sent')
})

test('switch guard blocks /session new while running', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  ctx.agents.get(binding.activeSessionId).status = 'running'
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/session new' })
  assert.match(JSON.stringify(sent), /\/stop/)
})

test('diff card action returns the file diff', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'card-action', actionId: 'a', value: { actionId: 'a', kind: 'diff', path: 'a.js' }, messageId: 'om_c', chatId: 'oc_1', operatorOpenId: 'ou_a' })
  assert.ok(sent.some(s => s.type === 'post' && /diff/.test(JSON.stringify(s.content))))
})
