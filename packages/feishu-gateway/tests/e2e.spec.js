// tests/e2e.spec.js
/**
 * Offline end-to-end suite: a fake Feishu driven by DOCUMENT-FIXTURE payloads.
 *
 * The long-connection wire protocol is SDK-private (ADR 0003), but both of
 * its sides are public contracts:
 *   inbound  — the documented schema-2.0 event JSON, in the exact FLATTENED
 *              shape EventDispatcher.parse() hands handlers (the shape that
 *              once silently filtered every delivered message);
 *   outbound — the documented im.v1.message create/reply REST calls, whose
 *              captured arguments are asserted field-by-field (msg_type,
 *              receive_id_type, uuid idempotency).
 *
 * The whole chain boots through the REAL plugin apply() against a strict
 * cordis-shaped context (unknown service property access throws, like the
 * real Context — the class of bug that killed the host), a fake SDK whose
 * WSClient captures the dispatcher, and a zod-validated binding store over
 * a scratch file. No network, no real Feishu, no host process.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'fg-e2e-'))
process.env.FEISHU_GATEWAY_STATUS_FILE = join(scratch, 'status.json')
process.env.FEISHU_GATEWAY_EVENT_LOG = join(scratch, 'events.json')

/** Load one documented fixture; return {wire, flat} — parse()'s flattened form. */
function fixture(name) {
  const raw = JSON.parse(readFileSync(join(here, 'fixtures/feishu', `${name}.json`), 'utf8'))
  if (raw.schema === '2.0' && raw.event !== undefined) {
    return {
      wire: raw,
      flat: { ...raw.header, ...raw.event, schema: raw.schema, event_type: raw.header.event_type },
    }
  }
  return { wire: raw, flat: raw }
}

/** A strict cordis-shaped context double with every injected service faked. */
function makeWorld() {
  const world = { outbound: [], wsOptions: undefined, dispatcher: undefined, ready: false }
  const agents = new Map()
  let agentSeq = 0

  const services = {
    credentials: { resolve: async ref => (ref === 'FEISHU_APP_SECRET' ? { value: 'sec'.repeat(8) } : undefined) },
    agents: {
      get: id => agents.get(id),
      create: async opts => {
        const agent = makeAgent(opts.sessionId ?? `s${++agentSeq}`, opts)
        agents.set(agent.session.id, agent)
        return { agent }
      },
      resume: async ({ resumeSessionId }) => {
        const agent = agents.get(resumeSessionId) ?? makeAgent(resumeSessionId, { meta: { cwd: '/tmp/demo' } })
        agents.set(agent.session.id, agent)
        return { agent }
      },
    },
    workspaceRegistry: {
      // 12 owned sessions: enough for two 10-per-page list pages.
      list: () => [{ id: 'w1', title: 'demo', path: '/tmp/demo', sessionIds: Array.from({ length: 12 }, (_, i) => `feishu-s${String(11 - i).padStart(2, '0')}`) }],
      resolveByPath: async path => ({ id: 'w1', title: 'demo', path }),
      attachSession: () => {},
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'zai-coding-cn', model: 'glm-5.3' }) },
    agentPresets: { resolve: async id => ({ id: id ?? 'standard' }), mount: async () => {} },
    sessionController: {
      selectModel: async () => ({ selected: {} }),
      list: async () => ({ items: Array.from({ length: 12 }, (_, i) => ({
        sessionId: `feishu-s${String(11 - i).padStart(2, '0')}`,
        updatedAt: 1_000 + i,
        agentAvailable: i < 2,
      })) }),
    },
    sessionQuery: {
      listSessions: async () => Array.from({ length: 12 }, (_, i) => ({
        header: { id: `feishu-s${String(11 - i).padStart(2, '0')}`, cwd: '/tmp/demo', createdAt: 1_000 + i },
        live: i < 2,
      })),
      readSurface: async id => ({ session: { id, agentPreset: 'standard' } }),
      readTitleSnapshots: async ids => ids.map(id => ({ status: 'fulfilled', value: { session: { id }, title: { title: `标题 ${String(id)}` } } })),
    },
    workspaceChanges: {
      summary: () => undefined,
      diff: async () => undefined,
    },
    llm: { listModels: async () => [{ provider: 'zai-coding-cn', models: [{ id: 'glm-5.3' }] }] },
    // The real service throws on a session without a live log — keep that.
    sessionTitle: {
      get: session => {
        if (session === undefined || session === null) throw new TypeError("Cannot read properties of undefined (reading 'snapshotEvents')")
        return { title: '会话标题' }
      },
    },
    logger: { info: () => {}, warn: m => { world.warns ??= []; world.warns.push(m) }, error: () => {} },
  }

  function makeAgent(id, opts) {
    return {
      id,
      createdWith: opts,
      status: 'idle',
      session: {
        id,
        snapshotEvents: () => [],
        requestHeader: () => ({ config: { provider: 'zai-coding-cn', model: 'glm-5.3' } }),
      },
      followuped: [],
      followup(message) { this.followuped.push(message) },
      steer(message) { this.followuped.push(message) },
      cancel: async () => {},
    }
  }

  const allowed = new Set([...Object.keys(services), 'on', 'effect', 'inject', 'get'])
  const base = {
    ...services,
    on: () => () => {},
    effect: fn => fn() ?? undefined,
    inject: (deps, fn) => { fn(base); return () => {} },
    get: name => base[name],
  }
  world.ctx = new Proxy(base, {
    get(target, name) {
      if (typeof name === 'string' && !allowed.has(name)) {
        throw new Error(`cannot get property ${JSON.stringify(name)} without inject`)
      }
      return target[name]
    },
  })

  world.messageApi = {
    create: async payload => {
      world.outbound.push({ api: 'create', ...payload })
      return { code: 0, msg: 'ok', data: { message_id: `om_out${world.outbound.length}` } }
    },
    reply: async payload => {
      world.outbound.push({ api: 'reply', ...payload })
      return { code: 0, msg: 'ok', data: { message_id: `om_out${world.outbound.length}` } }
    },
  }

  return world
}

// --- the suite ---------------------------------------------------------------------
const { apply, setSdkForTests, BindingRecord } = await import('../index.js')

async function boot() {
  const world = makeWorld()
  setSdkForTests({
    Client: class { constructor() { this.im = { v1: { message: world.messageApi } } } },
    WSClient: class {
      constructor(options) { world.wsOptions = options }
      async start({ eventDispatcher }) {
        world.dispatcher = eventDispatcher; world.ready = true
        // The real SDK fires onReady once the long connection is up (>=1.74).
        this.options?.onReady?.(); world.wsOptions?.onReady?.()
      }
      async close() { world.ready = false }
    },
    EventDispatcher: class {
      constructor() { this.handles = new Map() }
      register(map) { for (const [k, v] of Object.entries(map)) this.handles.set(k, v); return this }
    },
    LoggerLevel: { info: 3 },
  })
  apply(world.ctx, {
    appId: 'cli_e2e', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn',
    commandPrefix: '/', messageChunkLimit: 8000,
  })
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  return world
}

/** Deliver one documented event through the captured dispatcher (the SDK's invoke path). */
async function deliver(world, name, { flat = true, override } = {}) {
  const fx = fixture(name)
  const payload = override ?? (flat ? fx.flat : fx.wire)
  const handler = world.dispatcher.handles.get(payload.event_type)
  assert.ok(handler, `dispatcher registered ${payload.event_type}`)
  await handler(payload)
  // LarkClient spaces sends 250ms apart (per-chat QPS guard): let them drain.
  await new Promise(r => setTimeout(r, 400))
}

test('boots through the real apply() against a strict cordis context', async () => {
  globalThis.world0 = await boot()
  const world = globalThis.world0
  assert.ok(world.dispatcher, 'WSClient started and dispatcher captured')
  assert.ok(world.dispatcher.handles.has('im.message.receive_v1'))
  assert.ok(world.dispatcher.handles.has('card.action.trigger'))
  const status = JSON.parse(readFileSync(process.env.FEISHU_GATEWAY_STATUS_FILE, 'utf8'))
  // onReady (not boot) is what writes connected; connectedAt rides the record.
  assert.equal(status.stage, 'connected')
  assert.equal(status.detail, null, 'onReady carries no detail — boot-time writes no longer fake connected')
  assert.equal(status.appId, 'cli_e2e')
  assert.ok(status.connectedAt, 'connectedAt recorded')
  assert.equal(world.wsOptions.appId, 'cli_e2e')
  // WS error lines are captured into the status record (desktop proxy incident).
  world.wsOptions.logger.error('[ws]', 'Protocol "https:" not supported. Expected "http:"')
  const afterError = JSON.parse(readFileSync(process.env.FEISHU_GATEWAY_STATUS_FILE, 'utf8'))
  assert.ok(String(afterError.lastWsError).includes('not supported'), 'lastWsError captured')
})

test('documented p2p /help fixture flows through to a documented REST reply', async () => {
  const world = globalThis.world0
  await deliver(world, 'im.message.receive_v1.p2p.text')
  const create = world.outbound.find(e => e.api === 'create')
  assert.ok(create, 'outbound create captured')
  assert.equal(create.params.receive_id_type, 'chat_id', 'documented receive_id_type')
  assert.equal(create.data.receive_id, 'oc_44942de1ab4761f9787d9a7ac5654038')
  assert.equal(create.data.msg_type, 'text')
  assert.match(create.data.uuid, /^fg-/, 'idempotency uuid present')
  assert.match(JSON.parse(create.data.content).text, /\/ws use/)
  const events = JSON.parse(readFileSync(process.env.FEISHU_GATEWAY_EVENT_LOG, 'utf8'))
  assert.equal(events.at(-1).outcome, 'handled')
})

test('documented group-chat fixture is filtered (v1 is p2p only)', async () => {
  const world = globalThis.world0
  const before = world.outbound.length
  await deliver(world, 'im.message.receive_v1.group.text')
  assert.equal(world.outbound.length, before, 'no outbound for group chats')
  const events = JSON.parse(readFileSync(process.env.FEISHU_GATEWAY_EVENT_LOG, 'utf8'))
  assert.equal(events.at(-1).outcome, 'filtered:not-p2p-or-unparsable')
})

test('documented card.action.trigger fixture resumes the addressed session', async () => {
  const world = globalThis.world0
  // Bind a workspace first: the resume card needs a binding (/help alone
  // does not bind). Same documented shape, varied text.
  const bind = fixture('im.message.receive_v1.p2p.text')
  bind.flat.message.content = JSON.stringify({ text: '/ws use demo' })
  bind.flat.message.message_id = 'om_bind1'
  await deliver(world, 'im.message.receive_v1.p2p.text', { override: bind.flat })
  await deliver(world, 'card.action.trigger.button')
  // The resume card path goes through resumeSession → agents.resume + status.
  const card = world.outbound.filter(e => e.data.msg_type === 'interactive').at(-1)
  assert.ok(card, 'status card sent after resume')
  const events = JSON.parse(readFileSync(process.env.FEISHU_GATEWAY_EVENT_LOG, 'utf8'))
  assert.equal(events.at(-1).type, 'card.action.trigger')
  assert.equal(events.at(-1).outcome, 'handled')
})

test('pager button (session-page) re-renders the list via the dispatcher path', async () => {
  const world = globalThis.world0
  const bind = fixture('im.message.receive_v1.p2p.text')
  bind.flat.message.content = JSON.stringify({ text: '/ws use demo' })
  bind.flat.message.message_id = 'om_bind2'
  await deliver(world, 'im.message.receive_v1.p2p.text', { override: bind.flat })
  const list = fixture('im.message.receive_v1.p2p.text')
  list.flat.message.content = JSON.stringify({ text: '/session list' })
  list.flat.message.message_id = 'om_list2'
  await deliver(world, 'im.message.receive_v1.p2p.text', { override: list.flat })
  const page = fixture('card.action.trigger.button')
  page.flat.action.value = { actionId: 'pg', kind: 'session-page', page: 2 }
  await deliver(world, 'card.action.trigger.button', { override: page.flat })
  const card = JSON.parse(world.outbound.filter(e => e.data.msg_type === 'interactive').at(-1).data.content)
  assert.ok(card.header.title.content.includes('2/2'), 'pager button rendered page 2 of the list')
})

test('duplicate delivery of the same documented event is deduplicated', async () => {
  const world = globalThis.world0
  const before = world.outbound.length
  await deliver(world, 'im.message.receive_v1.p2p.text')
  await deliver(world, 'im.message.receive_v1.p2p.text')
  const events = JSON.parse(readFileSync(process.env.FEISHU_GATEWAY_EVENT_LOG, 'utf8'))
  assert.equal(events.at(-1).outcome, 'filtered:duplicate')
  assert.equal(world.outbound.length, before)
})

test('plugin bugs never escape as unhandled rejections (containment)', async () => {
  const world = globalThis.world0
  // Break the outbound API and a driver dependency: every entry point must
  // swallow into logs; an unhandled rejection here would fail the suite.
  const realCreate = world.messageApi.create
  world.messageApi.create = async () => { throw new Error('feishu down') }
  const realList = world.ctx.sessionController.list
  world.ctx.sessionController.list = async () => { throw new Error('list broken') }
  const bind = fixture('im.message.receive_v1.p2p.text')
  bind.flat.message.content = JSON.stringify({ text: '/ws use demo' })
  bind.flat.message.message_id = 'om_hard1'
  await deliver(world, 'im.message.receive_v1.p2p.text', { override: bind.flat })
  const listMsg = fixture('im.message.receive_v1.p2p.text')
  listMsg.flat.message.content = JSON.stringify({ text: '/session list' })
  listMsg.flat.message.message_id = 'om_hard2'
  await deliver(world, 'im.message.receive_v1.p2p.text', { override: listMsg.flat })
  world.messageApi.create = realCreate
  world.ctx.sessionController.list = realList
})

test('BindingRecord (zod) still validates the incident-era stored shape', () => {
  const parsed = BindingRecord.parse({
    chatId: 'oc_1', workspaceId: 'w1', workspaceTitle: 'demo', workspacePath: '/tmp/demo',
    sessionHistory: [], updatedAt: 1,
  })
  assert.equal(parsed.activeSessionId, undefined)
})
