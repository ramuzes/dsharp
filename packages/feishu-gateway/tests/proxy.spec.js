/**
 * Proxy resolution tests: standard env precedence, no_proxy bypass, and the
 * wiring of httpInstance/agent into both SDK halves (the desktop incident's
 * fix — the SDK's own env-proxy path must never be the one we ride).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'fg-proxy-'))
process.env.FEISHU_GATEWAY_STATUS_FILE = join(scratch, 'status.json')
process.env.FEISHU_GATEWAY_EVENT_LOG = join(scratch, 'events.json')
// Keep the harness's own proxy env (if any) out of the wiring assertions.
delete process.env.http_proxy; delete process.env.https_proxy
delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY
delete process.env.all_proxy; delete process.env.ALL_PROXY
delete process.env.no_proxy; delete process.env.NO_PROXY

const { proxyUrlFor, createProxiedLarkHttpInstance, wsAgentFor } = await import('../lib/proxy.js')

test('https targets take https_proxy, then all_proxy, then http_proxy', () => {
  const target = 'https://open.feishu.cn'
  assert.equal(proxyUrlFor(target, { https_proxy: 'http://a:1' }), 'http://a:1')
  assert.equal(proxyUrlFor(target, { HTTPS_PROXY: 'http://A:1' }), 'http://A:1')
  assert.equal(proxyUrlFor(target, { all_proxy: 'http://b:2', http_proxy: 'http://c:3' }), 'http://b:2')
  assert.equal(proxyUrlFor(target, { http_proxy: 'http://c:3' }), 'http://c:3')
  assert.equal(proxyUrlFor(target, {}), undefined)
})

test('no_proxy bypasses the proxy for matching hosts', () => {
  const env = { https_proxy: 'http://a:1', no_proxy: 'feishu.cn, .internal' }
  assert.equal(proxyUrlFor('https://open.feishu.cn', env), undefined)
  assert.equal(proxyUrlFor('https://msg-frontier.feishu.cn', env), undefined)
  assert.equal(proxyUrlFor('https://example.com', env), 'http://a:1')
  assert.equal(proxyUrlFor('https://x.internal', { https_proxy: 'http://a:1', no_proxy: '.internal' }), undefined)
  assert.equal(proxyUrlFor('https://a.feishu.cn.evil.com', env), 'http://a:1', 'suffix match stays domain-bound')
})

test('proxied http instance: proxy:false with both agents and the SDK unwrap', async () => {
  const created = []
  const fakeAxios = {
    create(options) {
      created.push(options)
      return {
        interceptors: { response: { use(fn) { created.useResponse = fn } } },
      }
    },
  }
  const marks = []
  class Agent { constructor(url) { marks.push(`${this.constructor.name}:${url}`) } }
  const HttpsProxyAgent = class extends Agent { static get name() { return 'HttpsProxyAgent' } }
  const HttpProxyAgent = class extends Agent { static get name() { return 'HttpProxyAgent' } }
  const instance = await createProxiedLarkHttpInstance('http://p:1', { axios: fakeAxios, HttpsProxyAgent, HttpProxyAgent })
  assert.equal(created[0].proxy, false, "axios's own env-proxy path is disabled")
  assert.ok(created[0].httpAgent instanceof HttpProxyAgent)
  assert.ok(created[0].httpsAgent instanceof HttpsProxyAgent)
  // The SDK defaultHttpInstance contract: resp.data unless $return_headers.
  assert.deepEqual(created.useResponse({ data: { code: 0 }, config: {} }), { code: 0 })
  assert.deepEqual(created.useResponse({ data: { code: 0 }, headers: { a: 1 }, config: { $return_headers: true } }),
    { data: { code: 0 }, headers: { a: 1 } })
  assert.equal(typeof created.useResponse, 'function', 'response interceptor installed on the instance')
})

test('ws agent: undefined without proxy, HttpsProxyAgent with one', async () => {
  assert.equal(await wsAgentFor(undefined), undefined)
  class HttpsProxyAgent { constructor(url) { this.url = url } }
  const agent = await wsAgentFor('http://p:1', { HttpsProxyAgent })
  assert.ok(agent instanceof HttpsProxyAgent)
  assert.equal(agent.url, 'http://p:1')
})

test('boot wires httpInstance and agent into BOTH SDK halves when env proxies', async () => {
  process.env.https_proxy = 'http://127.0.0.1:13083'
  const captured = {}
  const { apply, setSdkForTests } = await import('../index.js')
  setSdkForTests({
    Client: class { constructor(options) { captured.client = options; this.im = { v1: { message: { async create() {}, async reply() {} } } } } },
    WSClient: class {
      constructor(options) { captured.ws = options }
      async start({ eventDispatcher }) { captured.dispatcher = eventDispatcher; options.onReady?.() }
      async close() {}
    },
    EventDispatcher: class { constructor() {} register(map) { return map } },
    LoggerLevel: { info: 'info' },
  })
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: name => ctx[name],
    on: () => () => {},
    effect(fn) { fn(); return () => {} },
    inject(_deps, fn) { fn(ctx); return () => {} },
    credentials: { resolve: async () => ({ value: 'sec'.repeat(4) }) },
  }
  apply(ctx, { appId: 'cli_p', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  assert.ok(captured.client?.httpInstance, 'REST client rides our proxied axios instance')
  assert.ok(captured.ws?.httpInstance, 'WS config pull rides our proxied axios instance')
  assert.ok(captured.ws?.agent, 'ws socket rides a proxy agent')
  const { readFileSync } = await import('node:fs')
  const status = JSON.parse(readFileSync(process.env.FEISHU_GATEWAY_STATUS_FILE, 'utf8'))
  assert.equal(status.proxy, 'http://127.0.0.1:13083', 'proxy decision recorded in status')
  delete process.env.https_proxy
})
