/**
 * Diagnostics contract tests: the staged status writer's slow-fact merge, the
 * `feishuGateway` Remote's method markers (hand-attached because decorators
 * are unavailable in plain Node), and the boot status semantics that the
 * desktop incident fixed — only onReady writes `connected`, and a silent SDK
 * surfaces as `never-connected`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'fg-diag-'))
process.env.FEISHU_GATEWAY_STATUS_FILE = join(scratch, 'status.json')
process.env.FEISHU_GATEWAY_EVENT_LOG = join(scratch, 'events.json')
process.env.FEISHU_GATEWAY_READY_TIMEOUT_MS = '20'

const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')
const { createStatusWriter } = await import('../lib/status.js')
const { FeishuGatewayDiagnostics } = await import('../lib/diagnostics.js')
const { apply, setSdkForTests, setDiagnosticsFactoryForTests } = await import('../index.js')

test('status writer merges slow facts into every record and serves snapshots', () => {
  const file = join(scratch, 'writer.json')
  const status = createStatusWriter(file)
  status.write('boot-transport', { appId: 'cli_x' })
  status.setExtra({ appId: 'cli_x', inboundCount: 0 })
  status.write('transport-started', { appId: 'cli_x' })
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.stage, 'transport-started')
  assert.equal(persisted.appId, 'cli_x', 'extras survive a later stage write')
  assert.deepEqual(status.snapshot(), persisted, 'snapshot mirrors the persisted record')
})

test('the diagnostics class carries Remote markers exactly as Remote() would write them', () => {
  // remoteMethods reads markers off getPrototypeOf(service): pass an instance.
  const markers = remoteMethods(Object.create(FeishuGatewayDiagnostics.prototype))
  assert.deepEqual(markers.map(m => m.method).sort(), ['probe', 'status'])
  for (const marker of markers) {
    assert.deepEqual(marker.invocation, { kind: 'direct' }, `${marker.method} is a direct invocation`)
    assert.equal(marker.mode, undefined, 'unary method')
  }
})

test('diagnostics methods project the live snapshot and the probe', async () => {
  const seenSignals = []
  const instance = Object.create(FeishuGatewayDiagnostics.prototype)
  instance.getState = () => ({ stage: 'connected', appId: 'cli_x' })
  instance.probeFn = async signal => { seenSignals.push(signal); return { ok: true, latencyMs: 1 } }
  assert.deepEqual(instance.status(), { stage: 'connected', appId: 'cli_x' })
  const controller = new AbortController()
  assert.deepEqual(await instance.probe(controller.signal), { ok: true, latencyMs: 1 })
  assert.equal(seenSignals[0], controller.signal, 'probe forwards its cancellation signal')
})

test('a silent SDK (no onReady, no onError) surfaces as never-connected', async () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: name => ctx[name],
    on: () => () => {},
    effect(fn) { fn(); return () => {} },
    inject(_deps, fn) { fn(ctx); return () => {} },
    credentials: { resolve: async () => ({ value: 'sec'.repeat(4) }) },
  }
  setDiagnosticsFactoryForTests(() => ({ status: () => ({}) }))
  setSdkForTests({
    Client: class { constructor() { this.im = { v1: { message: { async create() {}, async reply() {} } } } } },
    WSClient: class {
      constructor(options) { this.options = options }
      async start() { /* silent: neither onReady nor onError ever fires */ }
    },
    EventDispatcher: class { constructor() {} register(map) { return map } },
    LoggerLevel: { info: 'info' },
  })
  apply(ctx, { appId: 'cli_silent', appSecretEnv: 'FEISHU_APP_SECRET', domain: 'https://open.feishu.cn', commandPrefix: '/', messageChunkLimit: 8000 })
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  assert.equal(JSON.parse(readFileSync(process.env.FEISHU_GATEWAY_STATUS_FILE, 'utf8')).stage, 'transport-started')
  // FEISHU_GATEWAY_READY_TIMEOUT_MS=20: the watchdog must fire without onReady.
  await new Promise(r => setTimeout(r, 60))
  const status = JSON.parse(readFileSync(process.env.FEISHU_GATEWAY_STATUS_FILE, 'utf8'))
  assert.equal(status.stage, 'never-connected', `watchdog fired; got ${JSON.stringify(status)}`)
  assert.match(String(status.detail), /onReady/)
  setDiagnosticsFactoryForTests(undefined)
})
