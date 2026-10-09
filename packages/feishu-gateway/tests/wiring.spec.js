// tests/wiring.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const here = fileURLToPath(new URL('.', import.meta.url))

/** A ctx double capturing effect/inject/on usage. */
function makeCtx() {
  const registered = { effects: [], events: [], injects: [] }
  const ctx = {
    logger: console,
    on(name) { registered.events.push(name); return () => {} },
    effect(fn) { registered.effects.push(fn); fn(); return () => {} },
    inject(deps, fn) { registered.injects.push(deps); fn(ctx); return () => {} },
    registered,
  }
  return ctx
}

test('apply without credentials stays inert (no transport, one log line)', async () => {
  const ctx = makeCtx()
  apply(ctx, { appId: '', appSecret: '', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  assert.equal(ctx.registered.injects.length, 0)
})

test('apply with credentials wires transport, driver, answerer, session events', async () => {
  const ctx = makeCtx()
  // Fake the SDK so no network is touched: index.js must expose a seam for it.
  const { setSdkForTests } = await import('../index.js')
  setSdkForTests({
    Client: class { constructor() { this.im = { v1: { message: { async create() {}, async reply() {} } } } } },
    WSClient: class { async start() {} },
    EventDispatcher: class { constructor() {} register(map) { return map } },
    LoggerLevel: { info: 'info' },
  })
  apply(ctx, { appId: 'cli_x', appSecret: 'sec', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  // The inject callback boots asynchronously (dynamic SDK import seam, router
  // load); settle the microtask queue before asserting registrations.
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(ctx.registered.injects.some(d => Array.isArray(d) && d.includes('agents')))
  assert.ok(ctx.registered.events.includes('session/event'))
  assert.ok(ctx.registered.effects.length > 0)
})

test('apply wires ctx.userQuestions into the answerer (late-answer channel)', async () => {
  const ctx = makeCtx()
  const userQuestions = { answer: async () => {} }
  ctx.userQuestions = userQuestions
  const { setSdkForTests, getLastAnswererForTests } = await import('../index.js')
  setSdkForTests({
    Client: class { constructor() { this.im = { v1: { message: { async create() {}, async reply() {} } } } } },
    WSClient: class { async start() {} },
    EventDispatcher: class { constructor() {} register(map) { return map } },
    LoggerLevel: { info: 'info' },
  })
  apply(ctx, { appId: 'cli_x', appSecret: 'sec', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  await new Promise(resolve => setImmediate(resolve))
  const answerer = getLastAnswererForTests()
  assert.ok(answerer, 'answerer was constructed')
  assert.equal(answerer.userQuestions, userQuestions, 'setUserQuestionsService received scope.userQuestions')
})

test('package.json declares the runtime SDK dependency and bundle patch', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.dependencies['@larksuiteoapi/node-sdk'])
})

test('README covers install, config, and the Feishu console checklist', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const needle of ['im.message.receive_v1', 'card.action.trigger', '长连接', 'FEISHU_APP_ID', '/ws use']) {
    assert.ok(readme.includes(needle), `README missing: ${needle}`)
  }
})
