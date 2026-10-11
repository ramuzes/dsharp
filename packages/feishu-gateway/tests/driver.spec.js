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
  const mountedPresets = []
  const resumedWith = []
  const workspaces = [
    { id: 'w1', title: 'demo', path: '/tmp/demo', sessionIds: ['session-old', 'session-mid', 'session-new'] },
    { id: 'w2', title: 'site', path: '/tmp/site', sessionIds: [] },
  ]
  let seq = 0
  const diffCalls = []
  // createdAt deliberately INVERTED vs the summaries' updatedAt: the list
  // must sort by activity (updatedAt), not creation.
  const queryRecords = [
    { header: { id: 'session-old', cwd: '/tmp/demo', createdAt: Date.UTC(2026, 9, 11, 8, 0, 0) }, live: false },
    { header: { id: 'session-mid', cwd: '/tmp/demo', createdAt: Date.UTC(2026, 9, 10, 8, 0, 0) }, live: true },
    { header: { id: 'session-new', cwd: '/tmp/demo', createdAt: Date.UTC(2026, 9, 9, 8, 0, 0) }, live: true },
    { header: { id: 'session-other', cwd: '/elsewhere', createdAt: Date.UTC(2026, 9, 9, 9, 0, 0) }, live: true },
  ]
  const ctx = {
    diffCalls,
    get: name => ctx[name],
    agents: {
      get: id => agents.get(id),
      create: async opts => {
        const agent = makeAgent(opts)
        agents.set(agent.session.id, agent)
        return { agent }
      },
      resume: async (opts) => {
        resumedWith.push(opts)
        const resumeSessionId = opts.resumeSessionId
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
    agentDefaultModel: { currentSelection: () => ({ provider: 'zai-coding-cn', model: 'glm-5.3' }) },
    agentPresets: {
      resolve: async id => ({ id: id ?? 'standard' }),
      mount: async (agentCtx, id) => { mountedPresets.push(id) },
    },
    sessionController: {
      selectModel: async () => {},
      // Real surface: SessionSummary[] ordered by activity (updatedAt =
      // max(log update, lastPromptAt) — the GUI sidebar's "recent").
      list: async () => ({ items: [
        { sessionId: 'session-other', updatedAt: 9, agentAvailable: true },
        { sessionId: 'session-new', updatedAt: 8, agentAvailable: true },
        { sessionId: 'session-mid', updatedAt: 7, agentAvailable: false },
        { sessionId: 'session-old', updatedAt: 6, agentAvailable: false },
      ] }),
    },
    sessionQuery: {
      listSessions: async () => queryRecords.map(r => ({ ...r })),
      readSurface: async id => ({ session: { id, agentPreset: id.startsWith('session-') ? 'standard' : undefined } }),
      readTitleSnapshots: async ids => ids.map(id => ({
        status: 'fulfilled',
        value: { session: { id }, title: queryRecords.some(r => r.header.id === id) ? { title: `标题·${String(id)}` } : undefined },
      })),
    },
    llm: {
      listProviders: () => [{ id: 'deepseek' }, { id: 'zai-coding-cn' }],
      listModels: async provider => (provider === 'deepseek'
        ? [{ id: 'deepseek-chat' }]
        : provider === 'zai-coding-cn'
          ? [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }]
          : []),
    },
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
  ctx.forgetLiveAgent = id => agents.delete(id)
  ctx.resumedWith = resumedWith
  ctx.mountedPresets = mountedPresets
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
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: 'do something' })
  assert.match(JSON.stringify(sent), /\/ws/)
})

test('task message without an active session asks for one (no auto-create)', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix the bug' })
  assert.ok(sent.some(m => /还没有活动会话/.test(m.text ?? '')), 'guidance instead of a silent new conversation')
  assert.equal((await driver.router.get('oc_1')).activeSessionId, undefined, 'no session was created')
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/session new' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_4', senderOpenId: 'ou_a', text: 'fix the bug' })
  const binding = await driver.router.get('oc_1')
  assert.equal(binding.activeSessionId.startsWith('feishu-'), true)
  assert.equal(binding.workspacePath, '/tmp/demo')
})

test('task message resumes a non-live bound session instead of creating one', async () => {
  const ctx = makeCtx()
  const { driver } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  const binding = await driver.router.get('oc_1')
  const first = binding.activeSessionId
  ctx.forgetLiveAgent(first) // simulate a host restart: bound, not live
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: 'continue here' })
  assert.equal((await driver.router.get('oc_1')).activeSessionId, first, 'resumed in place, pointer unchanged')
})

test('followup receives one UserMessage object shaped like the webhook template', async () => {
  const ctx = makeCtx()
  const { driver } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

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
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

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
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

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
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

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
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  ctx.agents.get(binding.activeSessionId).status = 'running'
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/session new' })
  assert.match(JSON.stringify(sent), /\/stop/)
})

test('openSession carries the default model in agentOptions ({{model}} variable)', async () => {
  const ctx = makeCtx()
  const { driver } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  assert.deepEqual(agent.createdWith.agentOptions, { provider: 'zai-coding-cn', model: 'glm-5.3' })
})

test('openSession passes a generated sessionId and schema-valid meta only', async () => {
  const ctx = makeCtx()
  const { driver } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix the bug' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  // Real API: caller-generated sessionId (webhook pattern); meta only carries
  // schema-valid fields — the feishu origin rides the UserMessage source.
  assert.match(agent.createdWith.sessionId, /^feishu-[0-9a-f-]{36}$/)
  assert.equal(agent.createdWith.meta.cwd, '/tmp/demo')
  assert.equal(agent.createdWith.meta.source, undefined)
  assert.equal('feishuSource' in agent.session, false, 'no dead mirror on the host session object')
})

test('status card reads title from ctx.sessionTitle and model from requestHeader', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  ctx.sessionTitle = { get: () => ({ title: 'renamed by user' }) }
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

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
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  ctx.agents.get(binding.activeSessionId).session.requestHeader = undefined
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/status' })
  const card = JSON.stringify(sent.filter(s => s.type === 'interactive').at(-1))
  assert.match(card, /（无会话）|fix/)
  assert.match(card, /默认/)
})

test('/session list renders newest-first page of workspace sessions with resume buttons', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session list' })
  const card = sent.filter(m => m.type === 'interactive').at(-1).content
  assert.match(card.header.title.content, /共 3）/, 'registry-owned sessions only (other workspace excluded)')
  const rows = card.elements.filter(e => e.tag === 'div').map(e => e.text.content)
  assert.match(rows[0], /\*\*1\.\*\*/, 'rows are numbered newest-first')
  assert.match(rows[0], /标题·session-new/, 'non-live titles come from the batch readTitleSnapshots')
  // Activity ordering: the fixture's createdAt is deliberately inverted vs
  // the summaries' updatedAt (see makeCtx), so this order proves the sort
  // keys on updatedAt, not creation time.
  const picks = card.elements.filter(e => e.tag === 'action').flatMap(e => e.actions).filter(a => a.value?.kind === 'resume')
  assert.deepEqual(picks.map(a => a.value.sessionId), ['session-new', 'session-mid', 'session-old'], 'number buttons carry the ids, newest first')
  assert.deepEqual(picks.map(a => a.text.content), ['1', '2', '3'], 'short numeric labels, no ids visible')
  assert.equal(card.elements.some(e => e.tag === 'action' && e.actions.some(a => a.text.content === '下一页')), false, 'single page has no pager')
})

test('/session resume <序号|前缀> resumes that session and switches the pointer', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session resume 2' })
  const binding = await driver.router.get('oc_1')
  assert.equal(binding.activeSessionId, 'session-mid', '1-based index into the newest-first list')
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/session resume session-new' })
  assert.equal((await driver.router.get('oc_1')).activeSessionId, 'session-new', 'exact id also resolves')
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_4', senderOpenId: 'ou_a', text: '/session resume session-o' })
  assert.equal((await driver.router.get('oc_1')).activeSessionId, 'session-old', 'unique id prefix resolves')
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_5', senderOpenId: 'ou_a', text: '/session resume session' })
  assert.ok(sent.some(m => JSON.stringify(m).includes('没有匹配的会话')), 'ambiguous prefix is refused with guidance')
  // The resume echo: the last turn's assistant output follows the switch
  // (queued behind the per-chat send gap, so order-insensitive match).
  assert.ok(sent.some(m => JSON.stringify(m).includes('📎 上一轮输出')), 'recall of the last assistant output after switching')
})

test('a session owned by another window replies with guidance instead of crashing', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  driver.probeLock = async () => true // kernel write lease held elsewhere
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  const before = sent.length
  // Direct resume form:
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/session resume 1' })
  assert.ok(sent.slice(before).some(m => /正被另一个窗口\/进程占用/.test(m.text ?? '')), 'collision translated for the user')
  // Task delivery to the same owned session:
  ctx.forgetLiveAgent((await driver.router.get('oc_1')).activeSessionId)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_4', senderOpenId: 'ou_a', text: 'continue' })
  assert.ok(sent.some(m => /正被另一个窗口\/进程占用/.test(m.text ?? '')), 'task delivery also degrades to guidance')
})

test('resumed agents carry the default model too ({{model}} on resume path)', async () => {
  const ctx = makeCtx()
  const { driver } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session resume 1' })
  assert.deepEqual(ctx.resumedWith[0].agentOptions, { provider: 'zai-coding-cn', model: 'glm-5.3' })
  // Task delivery to a non-live bound session resumes the same way.
  ctx.forgetLiveAgent((await driver.router.get('oc_1')).activeSessionId)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: 'continue' })
  assert.ok(ctx.resumedWith.length >= 2 && ctx.resumedWith.at(-1).agentOptions?.model === 'glm-5.3')
})

test('agents are composed with their preset — create records it, resume reuses the session own', async () => {
  const ctx = makeCtx()
  const { driver } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  // Create: default preset resolved, mounted in setup, recorded in durable meta.
  assert.equal(agent.createdWith.meta.agentPreset, 'standard')
  assert.equal(typeof agent.createdWith.setup, 'function')
  await agent.createdWith.setup({ tag: 'agentCtx' })
  assert.deepEqual(ctx.mountedPresets, ['standard'])
  // Resume (the session- prefix fixture carries agentPreset 'standard'): the
  // session's OWN preset is used — never a blind default that would strip
  // its tool history (the 36-tool-removal regression).
  ctx.forgetLiveAgent(binding.activeSessionId)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: 'continue' })
  assert.equal(ctx.resumedWith.at(-1).setup !== undefined, true, 'resume carries a setup')
  await ctx.resumedWith.at(-1).setup({ tag: 'agentCtx2' })
  assert.deepEqual(ctx.mountedPresets, ['standard', 'standard'], 'session preset re-mounted on resume')
})

test('task delivery replies 工作中 and turn errors reach the chat', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: 'do it' })
  assert.ok(sent.some(m => /工作中/.test(m.text ?? '')), 'receipt after triggering the agent loop')
  // turn/end with an error reason pushes the failure into the chat.
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  await driver.onSessionEvent(agent.session, { type: 'turn/end', seq: 5, data: { reason: { kind: 'error', error: { message: 'prompt variable {{model}} missing' } } } })
  assert.ok(sent.some(m => /本轮失败.*\{\{model\}\}/.test(m.text ?? '')), 'turn error surfaced')
})

test('the watchdog reminds once about a long-running turn and clears on turn/end', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  driver.config.watchdogMs = 40
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  const binding = await driver.router.get('oc_1')
  const agent = ctx.agents.get(binding.activeSessionId)
  await driver.onSessionEvent(agent.session, { type: 'turn/start', seq: 4 })
  await driver.onSessionEvent(agent.session, { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } })
  await new Promise(r => setTimeout(r, 80))
  assert.equal(sent.some(m => /已运行.*分钟/.test(m.text ?? '')), false, 'cleared watchdog stays silent')
  await driver.onSessionEvent(agent.session, { type: 'turn/start', seq: 6 })
  await new Promise(r => setTimeout(r, 90))
  assert.ok(sent.some(m => /已运行约 \d+ 分钟仍未结束/.test(m.text ?? '')), 'long-run reminder fires once')
})

test('/doctor reports gateway state in chat', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  driver.probeLock = async () => false
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/doctor' })
  const report = sent.find(m => /网关/.test(m.text ?? ''))
  assert.ok(report, 'doctor report sent')
  assert.match(report.text, /默认模型\*\*：zai-coding-cn.glm-5.3/)
  assert.match(report.text, /会话写锁\*\*：可用/)
})

test('status card shows the policy line from the session log', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  ctx.sessionQuery.listEvents = async () => [
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
  ]
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/status' })
  const card = sent.filter(m => m.type === 'interactive').at(-1).content
  assert.match(JSON.stringify(card), /沙箱 workspace-write · 审批 ask/)
})

test('sendStatus with a missing session never throws (host crash regression)', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  // /ws use on a fresh binding has no active session: the old code called
  // sessionTitle.get(undefined) and crashed the host ("fatal load failure").
  const card = sent.filter(m => m.type === 'interactive').at(-1).content
  assert.ok(card, 'status card rendered')
  assert.equal(typeof card.header.title.content, 'string')
})

test('bare /model lists providers through listProviders + listModels(provider)', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  const calls = []
  ctx.llm.listModels = async provider => { calls.push(provider); return provider === 'deepseek' ? [{ id: 'deepseek-chat' }] : [] }
  ctx.llm.listProviders = () => [{ id: 'deepseek' }, { id: 'zai-coding-cn' }]
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/model' })
  assert.deepEqual(calls, ['deepseek', 'zai-coding-cn'], 'one listModels call per provider route, never undefined')
  const card = sent.filter(m => m.type === 'interactive').map(m => m.content).find(c => JSON.stringify(c).includes('选择模型'))
  assert.ok(card, 'model picker card rendered')
})

test('model switch on a session owned by another window replies with guidance', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  driver.probeLock = async () => true
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/session new' })
  ctx.forgetLiveAgent((await driver.router.get('oc_1')).activeSessionId)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_3', senderOpenId: 'ou_a', text: '/model zai-coding-cn/glm-5.3' })
  assert.ok(sent.some(m => /模型暂不能切换/.test(m.text ?? '')), 'ownership collision answered with guidance, not a raw stack string')
})

test('model card action while running is rejected with the /stop hint', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: 'fix it' })
  const binding = await driver.router.get('oc_1')
  ctx.agents.get(binding.activeSessionId).status = 'running'
  let selectModelCalls = 0
  ctx.sessionController.selectModel = async () => { selectModelCalls++ }
  await driver.handleCardAction({
    kind: 'card-action', actionId: 'a',
    value: { actionId: 'a', kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    messageId: 'om_c', chatId: 'oc_1', operatorOpenId: 'ou_a',
  })
  assert.match(JSON.stringify(sent), /\/stop/)
  assert.equal(selectModelCalls, 0)
})

test('/model selects through sessionController with a flat ModelSelection request', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  const binding = await driver.router.get('oc_1')
  const requests = []
  ctx.sessionController.selectModel = async (request) => { requests.push(request) }
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_2', senderOpenId: 'ou_a', text: '/model zai-coding-cn/glm-5.3' })
  assert.equal(requests.length, 1)
  // Flat ModelSelection fields on the request — no nested `selection` object.
  assert.deepEqual(requests[0], { sessionId: binding.activeSessionId, provider: 'zai-coding-cn', model: 'glm-5.3' })
})

test('diff card action threads seq and file index into workspaceChanges.diff', async () => {
  const ctx = makeCtx()
  const { driver, sent } = makeDriver(ctx)
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_1', senderOpenId: 'ou_a', text: '/ws use demo' })
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

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
  await driver.handleInbound({ kind: 'message', chatId: 'oc_1', messageId: 'om_ses', senderOpenId: 'ou_a', text: '/session new' })

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
