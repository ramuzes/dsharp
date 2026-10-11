// tests/wiring.spec.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route the boot-path status writes to a scratch file, never ~/.dsh.
const scratch = mkdtempSync(join(tmpdir(), 'fg-status-'))
process.env.FEISHU_GATEWAY_STATUS_FILE = join(scratch, 'status.json')
process.env.FEISHU_GATEWAY_EVENT_LOG = join(scratch, 'events.json')

import { apply } from '../index.js'
import { statusFile } from '../lib/status.js'

const here = fileURLToPath(new URL('.', import.meta.url))

/** A ctx double capturing effect/inject/on usage. */
function makeCtx({ secret = '' } = {}) {
  const registered = { effects: [], events: [], injects: [], logs: [] }
  const logger = { info: m => registered.logs.push(m), warn: m => registered.logs.push(m) }
  const ctx = {
    logger,
    get: name => ctx[name],
    on(name) { registered.events.push(name); return () => {} },
    effect(fn) { registered.effects.push(fn); fn(); return () => {} },
    inject(deps, fn) { registered.injects.push(deps); fn(ctx); return () => {} },
    credentials: { resolve: async ref => (ref === 'FEISHU_APP_SECRET' && secret !== '' ? { value: secret } : undefined) },
    registered,
  }
  return ctx
}

test('apply without credentials stays inert (one log line, no transport effects)', async () => {
  const ctx = makeCtx()
  apply(ctx, { appId: '', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ctx.registered.injects.length, 1, 'one inject (credential resolution), then inert')
  assert.equal(ctx.registered.effects.length, 0, 'no transport/effects mounted')
  assert.ok(ctx.registered.logs.some(m => /inactive/.test(m)), 'inert log line emitted')
})

test('apply reports its boot stage through the status file', async () => {
  const ctx = makeCtx({ secret: '' })
  apply(ctx, { appId: 'cli_x', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  await new Promise(resolve => setImmediate(resolve))
  const status = JSON.parse(readFileSync(statusFile(), 'utf8'))
  assert.equal(status.stage, 'inactive')
  assert.deepEqual(status.detail, { appId: false, credentialResolved: true, ref: 'FEISHU_APP_SECRET' })
})

test('apply with appId but unresolved credential stays inert with guidance', async () => {
  const ctx = makeCtx({ secret: '' })
  apply(ctx, { appId: 'cli_x', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ctx.registered.effects.length, 0)
  assert.ok(ctx.registered.logs.some(m => /FEISHU_APP_SECRET/.test(m)), 'names the unresolved credential ref')
})

test('apply with credentials wires transport, driver, answerer, session events', async () => {
  const ctx = makeCtx({ secret: 'sec' })
  // Fake the SDK so no network is touched: index.js must expose a seam for it.
  const { setSdkForTests } = await import('../index.js')
  setSdkForTests({
    Client: class { constructor() { this.im = { v1: { message: { async create() {}, async reply() {} } } } } },
    WSClient: class { async start() {} },
    EventDispatcher: class { constructor() {} register(map) { return map } },
    LoggerLevel: { info: 'info' },
  })
  apply(ctx, { appId: 'cli_x', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  // The inject callback boots asynchronously (credential resolve, dynamic SDK
  // import seam, router load); settle the microtask queue before asserting.
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(ctx.registered.injects.some(d => Array.isArray(d) && d.includes('agents')))
  assert.ok(ctx.registered.injects.some(d => Array.isArray(d) && d.includes('credentials')))
  assert.ok(ctx.registered.events.includes('session/event'))
  assert.ok(ctx.registered.effects.length > 0)
})

test('apply wires ctx.userQuestions into the answerer (late-answer channel)', async () => {
  const ctx = makeCtx({ secret: 'sec' })
  const userQuestions = { answer: async () => {} }
  ctx.userQuestions = userQuestions
  const { setSdkForTests, getLastAnswererForTests } = await import('../index.js')
  setSdkForTests({
    Client: class { constructor() { this.im = { v1: { message: { async create() {}, async reply() {} } } } } },
    WSClient: class { async start() {} },
    EventDispatcher: class { constructor() {} register(map) { return map } },
    LoggerLevel: { info: 'info' },
  })
  apply(ctx, { appId: 'cli_x', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  await new Promise(resolve => setImmediate(resolve))
  const answerer = getLastAnswererForTests()
  assert.ok(answerer, 'answerer was constructed')
  assert.equal(answerer.userQuestions, userQuestions, 'setUserQuestionsService received scope.userQuestions')
  assert.equal(typeof answerer.resolveChat, 'function', 'answerer routes through the router binding lookup')
  assert.equal(answerer.resolveChat('no-such-session'), undefined, 'unbound session id does not resolve')
})

test('boot survives a strict cordis context (optional services uninjected)', async () => {
  // A real cordis Context throws on property access for services that are
  // not injected ("cannot get property ... without inject"). The boot path
  // treats storageDomain/userQuestions/sessionTitle as optional and must
  // look them up by name instead.
  const base = makeCtx({ secret: 'sec' })
  const allowed = new Set(['logger', 'on', 'effect', 'inject', 'credentials', 'get', 'registered'])
  const strictCtx = new Proxy(base, {
    get(target, name) {
      if (typeof name === 'string' && !allowed.has(name)) {
        throw new Error(`cannot get property ${JSON.stringify(name)} without inject`)
      }
      return target[name]
    },
  })
  const { setSdkForTests } = await import('../index.js')
  setSdkForTests({
    Client: class { constructor() { this.im = { v1: { message: { async create() {}, async reply() {} } } } } },
    WSClient: class { async start() {} },
    EventDispatcher: class { constructor() {} register(map) { return map } },
    LoggerLevel: { info: 'info' },
  })
  apply(strictCtx, { appId: 'cli_x', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const status = JSON.parse(readFileSync(statusFile(), 'utf8'))
  assert.equal(status.stage, 'connected', `boot reaches connected even without optional services; got ${JSON.stringify(status)}`)
  assert.ok(base.registered.effects.length > 0, 'transport effects mounted')
})

test('stored binding records with absent optional fields validate (DomainError regression)', async () => {
  const { BindingRecord } = await import('../index.js')
  // Exact shape of the record that broke the 19:10 boot: /ws use persisted a
  // fresh binding, JSON dropped the undefined active-session keys.
  const stored = {
    chatId: 'oc_44942de1ab4761f9787d9a7ac5654038',
    workspaceId: 'd62c1832-f4b1-4738-970d-6925dd60727e',
    workspaceTitle: 'core',
    workspacePath: '/home/ramuz/quant/core',
    sessionHistory: [],
    updatedAt: 1791629993376,
  }
  // The domain validates through .parse — assert THAT surface, not the callable.
  const resolved = BindingRecord.parse(stored)
  assert.equal(resolved.chatId, stored.chatId)
  assert.equal(resolved.activeSessionId, undefined, 'absent optional stays absent')
  assert.deepEqual(resolved.sessionHistory, [])
  // A record WITH the active session set still validates.
  const full = BindingRecord.parse({ ...stored, activeSessionId: 's1', activeSessionTitle: 't' })
  assert.equal(full.activeSessionId, 's1')
})

test('package.json declares the runtime SDK dependency and bundle patch', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.dependencies['@larksuiteoapi/node-sdk'])
})

test('README covers install, config, and the Feishu console checklist', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const needle of ['im.message.receive_v1', 'card.action.trigger', '长连接', 'FEISHU_APP_SECRET', '/ws use']) {
    assert.ok(readme.includes(needle), `README missing: ${needle}`)
  }
})
