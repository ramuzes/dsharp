/**
 * Host-half tests: Task 1 scaffold (Config schema defaults per ADR-0005 and
 * the staged status writer) + Task 8 apply() wiring (stage sequence, memoized
 * ensureReady with mid-session daemon death recovery, buildEnv blank-ref
 * omission, volatile config hot-reload, and the status-writer env-at-note-time
 * parked minor).
 *
 * Task 8 fakes mirror real strictness (AGENTS.md): the inject scope exposes
 * ONLY the injected service names (any other property access throws, like
 * cordis "cannot get property ... without inject"), config fields are
 * schemastery-style reactive wrappers `{ get: () => value }`, and the daemon
 * endpoint is a REAL local HTTP server — the client under test is the real
 * lib/engram-api.js client over real fetch, not a fake client.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Config, readString, readNumber, apply } from '../index.js'
import { makeStatusWriter } from '../lib/status.js'

/**
 * Volatile fields parse as schemastery reactive wrappers — the exact shape
 * the Loader hands the plugin (AGENTS.md). Assert defaults through the same
 * unwrap rule the host code uses.
 */
const unwrap = (v) => typeof v?.get === 'function' ? v.get() : v

test('Config defaults are empty/generic (ADR-0005)', () => {
  const parsed = Config({})
  assert.equal(unwrap(parsed.daemonMode), 'auto-spawn')          // protocol-generic default ok
  assert.equal(unwrap(parsed.port), '')                          // '' = engram's documented protocol default 7437; not baked
  assert.equal(unwrap(parsed.httpTokenRef), 'ENGRAM_HTTP_TOKEN') // protocol-generic env-var NAME default (feishu FEISHU_APP_SECRET pattern); unresolvable = no auth
  assert.equal(unwrap(parsed.autosync), false)
  assert.equal('cloudServer' in parsed || 'cloudServerRef' in parsed, false) // cloud config deliberately absent: engram's own cloud.json is the source of truth
  assert.equal('cloudTokenRef' in parsed, false)
  assert.equal(unwrap(parsed.autosync), false)
  assert.equal(unwrap(parsed.contextInjection), 'off')
  assert.equal(unwrap(parsed.contextMaxBytes), 2048)
  assert.equal(unwrap(parsed.projectMode), 'auto')
  assert.equal(unwrap(parsed.fixedProject), '')
  assert.deepEqual(unwrap(parsed.projectMap), {})
  assert.equal(unwrap(parsed.toolProfile), 'core')
})

test('volatile fields are marked hot-editable in the schema', () => {
  const parsed = Config({})
  // Every hot-editable field parses as a reactive wrapper (hot-editable).
  for (const key of ['port', 'httpTokenRef', 'autosync',
    'contextInjection', 'contextMaxBytes', 'projectMode', 'fixedProject', 'projectMap', 'toolProfile']) {
    assert.equal(typeof parsed[key]?.get, 'function', `${key} should parse as a reactive (hot-editable) wrapper`)
  }
  // daemonMode is deliberately NOT volatile: it changes mount-time structure.
  assert.equal(typeof parsed.daemonMode?.get, 'undefined')
})

test('readString/readNumber unwrap schemastery reactive wrappers', () => {
  assert.equal(readString('plain'), 'plain')
  assert.equal(readString({ get: () => 'wrapped' }), 'wrapped')
  assert.equal(readString(42), '')                        // wrong type → ''
  assert.equal(readNumber({ get: () => 7 }), 7)
  assert.equal(readNumber('7'), Number.NaN)               // wrong type → NaN
  assert.equal(readNumber(undefined), Number.NaN)
})

test('makeStatusWriter writes staged records to the given file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-status-'))
  const file = join(dir, 'status.json')
  try {
    const writer = makeStatusWriter(file)
    writer.note('apply')
    writer.note('inject', 'tools registered')
    const first = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(first.stage, 'inject')
    assert.equal(first.detail, 'tools registered')
    assert.equal(typeof first.at, 'string')
    assert.ok(!Number.isNaN(Date.parse(first.at)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('makeStatusWriter never throws on an unwritable path', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'engram-status-')), 'no-such-dir', 'status.json')
  const writer = makeStatusWriter(file)
  assert.doesNotThrow(() => writer.note('apply'))
})

// ---- Task 8: apply() wiring ----------------------------------------------

/** Mutable reactive config: every field is a schemastery-style wrapper. */
function reactiveConfig(over = {}) {
  const store = {
    daemonMode: 'auto-spawn',
    port: '',
    httpTokenRef: '',
    autosync: false,
    contextInjection: 'off',
    contextMaxBytes: 2048,
    projectMode: 'auto',
    fixedProject: '',
    projectMap: {},
    toolProfile: 'core',
    ...over,
  }
  const config = {}
  for (const key of Object.keys(store)) config[key] = { get: () => store[key] }
  return { store, config }
}

/**
 * Real local HTTP daemon standing in for engram 3.7.x: the client under test
 * is the real lib/engram-api.js client over real fetch.
 */
async function startDaemon() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url)
    const path = (req.url ?? '').split('?')[0]
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    // Real >=3.7 daemons advertise capability flags (spec decision 3 gates
    // on a non-empty capabilities object); the fake must not be looser.
    if (path === '/health') return send({ version: '3.7.2', capabilities: { observations: true } })
    if (path === '/search') return send({ items: [{ id: 'o1' }] })
    if (path === '/project/current') return send({ project: 'proj-live', project_source: 'server' })
    if (path === '/context') return send({ context: 'sum' })
    if (path === '/sessions') return send({ id: 'x', status: 'created' }, 201)
    send({ error: 'not found' }, 404)
  })
  const listen = (port) => new Promise((resolve) => server.listen(port ?? 0, '127.0.0.1', resolve))
  await listen()
  const port = server.address().port
  return {
    hits,
    get port() { return port },
    stop: () => new Promise((resolve) => server.close(resolve)),
    revive: async () => { await listen(port) }, // same port again
  }
}

/**
 * Fake host: ctx fakes for inject/on/effect, plus a strict scope builder —
 * a scope exposes ONLY the injected names; anything else throws exactly like
 * cordis does for a non-injected service access.
 */
function makeFakeHost({ credentials = {}, onSpawn } = {}) {
  const injects = []
  const listeners = new Map()
  const spawnCalls = []
  const registeredTools = []
  const sections = []
  const services = {
    tools: { register: (tool) => { registeredTools.push(tool); return () => {} } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    credentials: { resolve: async (ref) => credentials[ref] },
    subprocess: {
      spawn: (spec) => {
        spawnCalls.push(spec)
        if (onSpawn) onSpawn()
        return { done: Promise.resolve({ exitCode: 0, signal: null }) }
      },
    },
    workingDirectory: { get: (session) => session?.cwd ?? '/w/default' },
  }
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(fn)
    return () => listeners.get(event).delete(fn)
  }
  const ctx = { inject: (names, fn) => { injects.push({ names, fn }) }, on }
  const makeScope = (names) => {
    const target = { on }
    for (const name of names) target[name] = services[name]
    return new Proxy(target, {
      get(t, p) {
        if (p in t) return t[p]
        if (typeof p === 'symbol') return undefined
        throw new Error(`cannot get property ${String(p)} without inject`)
      },
    })
  }
  return { ctx, injects, listeners, spawnCalls, registeredTools, sections, makeScope, services }
}

/** Mount apply() against the fake host and run its (single) inject callback. */
async function mount(host, config) {
  apply(host.ctx, config)
  assert.equal(host.injects.length, 1, 'exactly one inject callback')
  const { names, fn } = host.injects[0]
  const dispose = await fn(host.makeScope(names))
  return { names, dispose }
}

const EXEC = { agent: { session: { id: 'sess-8', cwd: '/w/engram' } }, signal: undefined }
const stageOf = (file) => JSON.parse(readFileSync(file, 'utf8')).stage
const toolNamed = (host, name) => host.registeredTools.find((t) => t.name === name)

test('apply injects exactly the five catalog services and stages apply → tools-inject → tools-registered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-t8-'))
  const file = join(dir, 'status.json')
  const prev = process.env.ENGRAM_STATUS_FILE
  process.env.ENGRAM_STATUS_FILE = file
  const daemon = await startDaemon()
  try {
    const host = makeFakeHost()
    const { config } = reactiveConfig({ port: String(daemon.port) })
    apply(host.ctx, config)
    // Stage 1 lands synchronously, before any service is available.
    assert.equal(stageOf(file), 'apply')
    const { names, fn } = host.injects[0]
    assert.deepEqual([...names].sort(), ['credentials', 'subprocess', 'systemPrompt', 'tools', 'workingDirectory'])
    const running = fn(host.makeScope(names))
    // tools-inject is written before the callback's first await.
    assert.equal(stageOf(file), 'tools-inject')
    await running
    assert.equal(stageOf(file), 'tools-registered')
    assert.ok(host.registeredTools.some((t) => t.name === 'engram_search'))
  } finally {
    // Assigning undefined to process.env stores the STRING "undefined",
    // which would send later notes to ./undefined — delete instead.
    if (prev === undefined) delete process.env.ENGRAM_STATUS_FILE
    else process.env.ENGRAM_STATUS_FILE = prev
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mid-session daemon death: next execute re-ensures, spawns once, succeeds', async () => {
  const daemon = await startDaemon()
  const host = makeFakeHost()
  try {
    const { config } = reactiveConfig({ port: String(daemon.port) })
    const { dispose } = await mount(host, config)
    const search = toolNamed(host, 'engram_search')
    const first = await search.execute({ q: 'hi' }, EXEC)
    assert.ok(!String(first).includes('engram/'), `first execute should succeed: ${first}`)
    assert.equal(host.spawnCalls.length, 0, 'no spawn while healthy')

    await daemon.stop()
    const failed = await search.execute({ q: 'hi' }, EXEC)
    assert.match(String(failed), /engram\/unreachable/)
    assert.equal(host.spawnCalls.length, 0, 'failing call itself must not spawn synchronously')

    // Arm the spawn fake to revive the daemon, then execute again.
    host.services.subprocess.spawn = (spec) => {
      host.spawnCalls.push(spec)
      void daemon.revive()
      return { done: Promise.resolve({ exitCode: 0, signal: null }) }
    }
    const again = await search.execute({ q: 'hi' }, EXEC)
    assert.ok(!String(again).includes('engram/'), `recovered execute should succeed: ${again}`)
    assert.equal(host.spawnCalls.length, 1, 'exactly one spawn across the recovery')
    assert.ok(daemon.hits.some((u) => u.startsWith('/search')), 'recovered call hit the daemon')
    dispose()
  } finally {
    await daemon.stop()
  }
})

test('buildDaemonEnv injects only the autosync flag — cloud server/token stay with engram\'s own config', async () => {
  const host = makeFakeHost({
    credentials: { ENGRAM_HTTP_TOKEN: { value: 'tok-8' } },
  })
  const { config } = reactiveConfig({
    port: '8901',
    httpTokenRef: 'ENGRAM_HTTP_TOKEN',
    autosync: true,
  })
  const { dispose } = await mount(host, config) // no daemon on 8901
  const search = toolNamed(host, 'engram_search')
  const failed = await search.execute({ q: 'x' }, EXEC)
  assert.match(String(failed), /engram\/daemon-unreachable/)
  assert.equal(host.spawnCalls.length, 1, 'auto-spawn attempted once')
  const env = host.spawnCalls[0].env
  assert.equal(env.ENGRAM_PORT, '8901')
  assert.equal(env.ENGRAM_HTTP_TOKEN, 'tok-8')
  assert.equal(env.ENGRAM_CLOUD_AUTOSYNC, '1')
  // Upstream resolves cloud server/token from ~/.engram/cloud.json (env would
  // OVERRIDE the user's setup) — this plugin never injects them.
  assert.ok(!('ENGRAM_CLOUD_SERVER' in env), 'cloud server must come from engram\'s own config')
  assert.ok(!('ENGRAM_CLOUD_TOKEN' in env), 'cloud token must come from engram\'s own config')
  dispose()
})

test('volatile port edit applies on the next call without remount', async () => {
  const daemonA = await startDaemon()
  const host = makeFakeHost()
  try {
    const { store, config } = reactiveConfig({ port: String(daemonA.port) })
    const { dispose } = await mount(host, config)
    const search = toolNamed(host, 'engram_search')
    await search.execute({ q: 'one' }, EXEC)
    assert.ok(daemonA.hits.some((u) => u.startsWith('/search')))

    // Daemon moves; only the volatile config value changes, no remount.
    await daemonA.stop()
    const daemonB = await startDaemon()
    store.port = String(daemonB.port)
    const second = await search.execute({ q: 'two' }, EXEC)
    assert.ok(!String(second).includes('engram/'), `post-edit execute should succeed: ${second}`)
    assert.ok(daemonB.hits.some((u) => u.startsWith('/search')), 'request hit the NEW port')
    assert.equal(host.injects.length, 1, 'no remount happened')
    await daemonB.stop()
    dispose()
  } finally {
    await daemonA.stop()
  }
})

test('status writer resolves ENGRAM_STATUS_FILE at note time, not construction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-t8-'))
  const file = join(dir, 'late.json')
  const prev = process.env.ENGRAM_STATUS_FILE
  delete process.env.ENGRAM_STATUS_FILE
  const writer = makeStatusWriter() // constructed with NO override in effect
  process.env.ENGRAM_STATUS_FILE = file // override arrives AFTER construction
  try {
    writer.note('late-stage')
    assert.equal(stageOf(file), 'late-stage')
  } finally {
    if (prev === undefined) delete process.env.ENGRAM_STATUS_FILE
    else process.env.ENGRAM_STATUS_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  }
})
