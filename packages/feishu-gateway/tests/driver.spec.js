// tests/driver.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayDriver, lastAssistantText } from '../lib/driver.js'
import { BindingRouter } from '../lib/router.js'

/**
 * Minimal fake of the REAL host surface the driver consumes. Shapes follow
 * the checkout sources: Agent.followup/steer(input: UserMessage) (agent-loop
 * src/agent.ts), Agent.cancel(cause, options?), Session.deriveMessages(),
 * Session.requestHeader(), ctx.sessionTitle.get(session) (session-title
 * src/index.ts), ctx.workspaceChanges.diff(sessionId, seq, index) and
 * .summary(sessionId, seq) (workspace-changes src/types.ts).
 */
function makeCtx() {
  const agents = new Map()
  const workspaces = [
    { id: 'w1', title: 'demo', path: '/tmp/demo' },
    { id: 'w2', title: 'site', path: '/tmp/site' },
  ]
  let seq = 0
  const diffCalls = []
  const ctx = {
    diffCalls,
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
      summary: sessionId => ({ turn: 1, cwd: '/tmp/demo', total: 3, added: 5, deleted: 1, files: [{ path: 'a.js', added: 4, deleted: 1 }, { path: 'b.md', added: 1, deleted: 0 }] }),
      diff: async (sessionId, seq, index) => {
        diffCalls.push({ sessionId, seq, index })
        return {
          kind: 'text', path: 'a.js', display: 'a.js', before: true, after: true, coarse: false,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
        }
      },
    },
    apiSessions: { selectModel: async () => {} },
    llm: { listModels: async () => [{ provider: 'deepseek', models: [{ id: 'deepseek-chat' }] }] },
  }
  function makeAgent(opts) {
    const id = opts.sessionId ?? `s${++seq}`
    return {
      createdWith: opts,
      status: 'idle',
      session: {
        id,
        header: { cwd: opts.meta?.cwd ?? '/tmp/demo' },
        // Real Session surface (core/session src/index.ts): deriveMessages()
        // returns the model-visible Message[]; last assistant text is the
        // text blocks of the trailing assistant message.
        deriveMessages: () => [
          { id: 'u1', role: 'user', content: [{ type: 'text', text: 'fix it' }] },
          { id: 'a1', role: 'assistant', content: [{ type: 'text', text: `done: ${id}` }, { type: 'tool-call', id: 't1', name: 'bash' }] },
        ],
        // Real Session method (used by agent-loop src/agent.ts prepareRequest).
        requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
      },
      followuped: [],
      followup(input) { this.followuped.push(input); this.status = 'running' },
      steer(input) { this.steered = input },
      cancel(cause) { this.cancelledWith = cause; this.status = 'idle' },
      interrupt() { this.interrupted = true; this.status = 'idle' },
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

test('followup receives one UserMessage object shaped like the webhook template', async () => {
  const ctx = makeCtx()
  const { driver } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix the bug' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  assert.equal(agent.followuped.length, 1)
  const msg = agent.followuped[0]
  // Shape mirrors webhook src/session.ts: createUserMessage({content:[{type:'text',text}], source:{kind:'webhook',...}})
  assert.equal(msg.role, 'user')
  assert.deepEqual(msg.content, [{ type: 'text', text: 'fix the bug' }])
  assert.deepEqual(msg.source, { kind: 'feishu', chatId: 'oc_1', senderOpenId: 'ou_a', messageId: 'om_2' })
  assert.ok(typeof msg.id === 'string' && msg.id.length > 0, 'message carries a stable identity')
})

test('steer receives the same UserMessage shape while running', async () => {
  const ctx = makeCtx()
  const { driver } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  agent.status = 'running'
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_b', text: 'actually use the other file' })
  assert.equal(agent.steered.role, 'user')
  assert.deepEqual(agent.steered.content, [{ type: 'text', text: 'actually use the other file' }])
  assert.deepEqual(agent.steered.source, { kind: 'feishu', chatId: 'oc_1', senderOpenId: 'ou_b', messageId: 'om_3' })
})

test('/stop cancels the active agent with a user cause (falls back to interrupt)', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  agent.status = 'running'
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/stop' })
  assert.deepEqual(agent.cancelledWith, { kind: 'user' })
  assert.equal(agent.interrupted, undefined, 'cancel() was available, so interrupt() is not used')
  assert.match(JSON.stringify(sent), /当前状态/)
  // fallback: an agent without cancel() still gets interrupt()
  const legacyAgent = { status: 'running', session: { id: binding.activeSessionId }, interrupt() { this.interrupted = true } }
  ctx.agents.get = () => legacyAgent
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_4', senderOpenId: 'ou_a', text: '/stop' })
  assert.equal(legacyAgent.interrupted, true)
})

test('turn end sends the trailing assistant text from deriveMessages, then the changes card', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  await driver.onSessionEvent(agent.session, { type: 'turn/end', seq: 7 })
  assert.ok(sent.some(s => s.type === 'text' && /done:/.test(s.text)), 'assistant text sent')
  const card = sent.find(s => s.type === 'interactive' && /改动摘要/.test(JSON.stringify(s.content)))
  assert.ok(card, 'changes card sent')
  // the diff buttons carry the turn's event seq and per-file index
  const actions = card.content.elements.find(e => e.tag === 'action').actions
  assert.deepEqual(actions.map(a => a.value.index), [0, 1])
  for (const a of actions) assert.equal(a.value.seq, 7)
})

test('lastAssistantText reads the real Session surface and falls back gracefully', () => {
  const session = {
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'tool-call' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
    ],
  }
  assert.equal(lastAssistantText(session, { type: 'turn/end', seq: 1 }), 'hello world')
  const emptySession = { deriveMessages: () => [] }
  assert.equal(lastAssistantText(emptySession, { type: 'turn/end', seq: 2 }), '')
  assert.equal(lastAssistantText({}, undefined), '', 'no deriveMessages → empty string')
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

test('openSession carries the feishu source in create meta only', async () => {
  const ctx = makeCtx()
  const { driver } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix the bug' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  assert.deepEqual(agent.createdWith.meta.source, { kind: 'feishu', chatId: 'oc_1' })
  assert.equal('feishuSource' in agent.session, false, 'no dead mirror on the host session object')
})

test('status card reads title from ctx.sessionTitle and model from requestHeader', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  ctx.sessionTitle = { get: () => ({ title: 'renamed by user' }) }
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/status' })
  const card = JSON.stringify(sent.filter(s => s.type === 'interactive').at(-1))
  assert.match(card, /renamed by user/)
  assert.match(card, /deepseek\/deepseek-chat/)
})

test('status card falls back to the binding title and a neutral model label', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  // strip the header: requestHeader absent → neutral label
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  ctx.agents.get(binding.activeSessionId).session.requestHeader = undefined
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/status' })
  const card = JSON.stringify(sent.filter(s => s.type === 'interactive').at(-1))
  assert.match(card, /（无会话）|fix/)
  assert.match(card, /默认/)
})

test('model card action while running is rejected with the /stop hint', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  ctx.agents.get(binding.activeSessionId).status = 'running'
  let selectModelCalls = 0
  ctx.apiSessions.selectModel = async () => { selectModelCalls++ }
  await driver.handleCardAction({
    kind: 'card-action', actionId: 'a',
    value: { actionId: 'a', kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    messageId: 'om_c', chatId: 'oc_1', operatorOpenId: 'ou_a',
  })
  assert.match(JSON.stringify(sent), /\/stop/)
  assert.equal(selectModelCalls, 0)
})

test('diff card action threads seq and file index into workspaceChanges.diff', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  await driver.handleCardAction({
    kind: 'card-action', actionId: 'a',
    value: { actionId: 'a', kind: 'diff', path: 'b.md', seq: 7, index: 1 },
    messageId: 'om_c', chatId: 'oc_1', operatorOpenId: 'ou_a',
  })
  assert.deepEqual(ctx.diffCalls, [{ sessionId: binding.activeSessionId, seq: 7, index: 1 }])
  const post = sent.find(s => s.type === 'post')
  assert.ok(post, 'diff sent as post')
  const body = JSON.stringify(post.content)
  assert.match(body, /@@ -1,1 \+1,1 @@/)
  assert.match(body, /-old/)
})

test('diff of a binary or oversized file sends a friendly text instead of a fenced post', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  ctx.workspaceChanges.diff = async () => ({ kind: 'binary', path: 'a.png', display: 'a.png' })
  await driver.handleCardAction({
    kind: 'card-action', actionId: 'a',
    value: { actionId: 'a', kind: 'diff', path: 'a.png', seq: 3, index: 0 },
    messageId: 'om_c', chatId: 'oc_1', operatorOpenId: 'ou_a',
  })
  assert.ok(sent.some(s => s.type === 'text' && /二进制/.test(s.text)))
  assert.equal(sent.some(s => s.type === 'post'), false)
})
