/**
 * dsh-feishu-gateway — Host half.
 *
 * Wires the modules into the host: the SDK client (credentials from the
 * Loader row, env-defaulted), the long-connection transport, the binding
 * router (persisted through ctx.storageDomain — see createDomainPersist),
 * the driver, and the answerer. Inert until appId/appSecret are configured.
 */
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { Config as RowConfig } from './lib/config.js'
import { LarkClient, readConfigString } from './lib/lark-client.js'
import { startGatewayTransport } from './lib/transport.js'
import { BindingRouter } from './lib/router.js'
import { GatewayDriver } from './lib/driver.js'
import { GatewayAnswerer } from './lib/answerer.js'
import { createStatusWriter, createEventLog } from './lib/status.js'
import { FeishuGatewayDiagnostics } from './lib/diagnostics.js'
import { proxyUrlFor, createProxiedLarkHttpInstance, wsAgentFor } from './lib/proxy.js'

/** @type {any} */
let sdkOverride = undefined

/** Test seam: inject a fake SDK (Client/WSClient/EventDispatcher/LoggerLevel). */
export function setSdkForTests(fake) { sdkOverride = fake }

/** @type {any} */
let diagnosticsFactory = undefined

/**
 * Test seam: substitute the diagnostics Remote service (the real one needs a
 * genuine cordis Context for Service registration, which unit fakes are not).
 * The factory receives (ctx, getState, probe) and must return a service-like.
 */
export function setDiagnosticsFactoryForTests(factory) { diagnosticsFactory = factory }

/** @type {any} */
let lastAnswererForTests = undefined

/** Test seam: the answerer constructed by the most recent successful boot. */
export function getLastAnswererForTests() { return lastAnswererForTests }

/**
 * SDK loader used for BOTH the API client and the WebSocket transport, so a
 * test seam replaces the SDK everywhere and the real package is never loaded.
 */
function loadSdk() {
  return sdkOverride !== undefined ? Promise.resolve(sdkOverride) : import('@larksuiteoapi/node-sdk')
}

/**
 * One stored binding record — a ZOD schema: domainTable validates through
 * valueSchema.parse, which schemastery schemas do not implement, so a
 * schemastery declaration made EVERY stored record fail the domain's read
 * validation (DomainError: "does not match its schema") once the first
 * record hit disk. activeSessionId/activeSessionTitle are optional: a
 * freshly bound chat has none, and the JSON store drops undefined keys.
 */
export const BindingRecord = z.object({
  chatId: z.string(),
  workspaceId: z.string(),
  workspaceTitle: z.string(),
  workspacePath: z.string(),
  activeSessionId: z.string().optional(),
  activeSessionTitle: z.string().optional(),
  sessionHistory: z.array(z.object({ sessionId: z.string(), title: z.string() })).default([]),
  updatedAt: z.number(),
})

/** The chat-binding KV domain (SPEC: bindings persist through storage domain). */
const bindingDomain = defineDomain({
  name: 'feishu_gateway_bindings',
  version: 1,
  tables: {
    bindings: domainTable(BindingRecord),
  },
})

/**
 * BindingRouter persistence over the storage domain table (chatId key);
 * falls back to memory when the host exposes no storageDomain service.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function createDomainPersist(ctx) {
  let table = undefined
  return {
    async load() {
      // Optional service: property access without inject throws in cordis
      // ("cannot get property ... without inject"), so look it up by name.
      const storageDomain = ctx.get?.('storageDomain')
      if (storageDomain === undefined) return undefined
      const domain = await storageDomain.open(bindingDomain)
      table = domain.table('bindings')
      return [...table.keys?.() ?? []].flatMap(k => {
        const rec = table.get(k)
        return rec === undefined ? [] : [rec]
      })
    },
    async save(state) {
      if (table === undefined) return
      const live = new Map(state.map(b => [b.chatId, b]))
      for (const key of table.keys?.() ?? []) {
        if (!live.has(key)) await table.delete?.(key)
      }
      for (const b of live.values()) await table.put(b.chatId, b)
    },
  }
}

export const Config = RowConfig

/**
 * Mount the gateway. Requires the host services the driver consumes; stays
 * inert with one log line when credentials are not configured. The secret is
 * the credential reference named by `appSecretEnv` (default
 * FEISHU_APP_SECRET), resolved through `ctx.credentials` — written by the
 * Plugins-page secret control into the credential store, or supplied by the
 * launch environment. It never lands in a patch layer.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ appId?: unknown, appSecretEnv?: unknown, domain?: unknown, commandPrefix?: unknown, messageChunkLimit?: unknown }} config
 */
export function apply(ctx, config) {
  const appId = readConfigString(config.appId)
  const appSecretEnv = readConfigString(config.appSecretEnv) || 'FEISHU_APP_SECRET'
  const resolved = {
    appId,
    domain: readConfigString(config.domain) || 'https://open.feishu.cn',
    commandPrefix: readConfigString(config.commandPrefix) || '/',
    messageChunkLimit: Number(config.messageChunkLimit) > 0 ? Number(config.messageChunkLimit) : 8000,
  }

  // Staged status reporting: every boot stage lands in ~/.dsh/feishu-gateway-status.json
  // for scripts/doctor.mjs — info-level logs are easy to miss in the terminal.
  const status = createStatusWriter()
  status.write('waiting-services', { appId, appSecretEnv })
  status.setExtra({ appId: appId === '' ? null : appId, domain: resolved.domain })

  // Diagnostics Remote (`feishuGateway` namespace): the Plugins-page card reads
  // status() and runs probe(). Registered at apply time — BEFORE credentials
  // resolve — so the card can explain an `inactive` gateway too. Contained:
  // a diagnostics failure must never block the gateway itself.
  const probe = async (signal) => {
    const startedAt = Date.now()
    if (appId === '') return { ok: false, step: 'config', reason: 'appId not set' }
    try {
      const credentials = ctx.get?.('credentials')
      const credential = await credentials?.resolve(appSecretEnv)
      const appSecret = credential?.value ?? ''
      if (appSecret === '') return { ok: false, step: 'config', reason: `credential "${appSecretEnv}" unresolved` }
      // The doctor.mjs token test over the Remote wire: proves the appId+secret
      // pair AND egress to the open platform REST endpoint from the host process.
      const response = await fetch(`${resolved.domain.replace(/\/$/, '')}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: signal ?? AbortSignal.timeout(10_000),
      })
      const body = await response.json()
      const latencyMs = Date.now() - startedAt
      return body.code === 0
        ? { ok: true, step: 'credentials', code: body.code, latencyMs }
        : { ok: false, step: 'credentials', code: body.code, msg: String(body.msg ?? '').slice(0, 200), latencyMs }
    } catch (error) {
      return { ok: false, step: 'egress', reason: String(error).slice(0, 300), latencyMs: Date.now() - startedAt }
    }
  }
  try {
    const factory = diagnosticsFactory ?? ((ctx2, getState, probeFn) => new FeishuGatewayDiagnostics(ctx2, getState, probeFn))
    factory(ctx, () => status.snapshot(), probe)
  } catch (error) {
    ctx.logger?.warn?.(`feishu-gateway: diagnostics service failed to register: ${String(error)}`)
  }
  // Inject ONLY what the driver consumes. `llm` was removed in the audit
  // pass: model listing goes through sessionController.modelCatalog, and a
  // stale llm entry kept the plugin inactive in profiles without an llm
  // service. `agents` stays: read-only registry lookups (isRunning, status,
  // list liveness markers).
  ctx.inject(['credentials', 'agents', 'workspaceRegistry', 'sessionController', 'sessionQuery', 'workspaceChanges'], async (scope) => {
    status.write('resolving-credential', appSecretEnv)
    const credential = await scope.credentials.resolve(appSecretEnv)
    const appSecret = credential?.value ?? ''
    if (appId === '' || appSecret === '') {
      status.write('inactive', { appId: appId === '', credentialResolved: appSecret === '', ref: appSecretEnv })
      scope.logger.info?.(
        `feishu-gateway: appId not set or credential "${appSecretEnv}" unresolved — gateway inactive. `
        + 'Set appId and the App Secret on the Plugins page form.',
      )
      return
    }
    await boot(scope, { ...resolved, appSecret }, status).catch(e => {
      status.write('boot-failed', String(e))
      ctx.logger?.warn?.(`feishu-gateway: boot failed: ${String(e)}`)
    })
  })
}

/** Async half of apply()'s inject callback (kept separate so boot failures are contained). */
async function boot(scope, resolved, status) {
  status.write('boot-sdk')
  const Lark = await loadSdk()
  // Proxy ownership (see lib/proxy.js): when the standard env names a proxy
  // for the configured domain, both SDK halves ride OUR axios instance and
  // the ws socket rides an HttpsProxyAgent — never axios's env path, whose
  // behavior depends on the SDK's resolved axios version.
  const proxyUrl = proxyUrlFor(resolved.domain)
  const httpInstance = proxyUrl === undefined ? undefined : await createProxiedLarkHttpInstance(proxyUrl)
  const wsAgent = await wsAgentFor(proxyUrl)
  if (proxyUrl !== undefined) {
    status.setExtra({ proxy: proxyUrl })
    scope.logger?.info?.(`feishu-gateway: using proxy ${proxyUrl} for ${resolved.domain}`)
  }
  const sdkClient = new Lark.Client({
    appId: resolved.appId, appSecret: resolved.appSecret, domain: resolved.domain,
    ...(httpInstance === undefined ? {} : { httpInstance }),
  })
  const lark = new LarkClient({ sdkClient, logger: scope.logger })
  let actionSeq = 0
  const makeActionId = () => `fg_${Date.now().toString(36)}_${++actionSeq}`

  status.write('boot-storage')
  const router = new BindingRouter({ persist: createDomainPersist(scope) })
  await router.load()

  const answerer = new GatewayAnswerer({
    lark, config: resolved, logger: scope.logger, makeActionId,
    // Feishu routing is decided by OUR durable state: the router's bindings
    // map activeSessionId → chatId (the host has no session source field).
    resolveChat: sessionId => router.chatForSession(sessionId),
  })
  // The late-answer channel: without the service, late card clicks after the
  // timed window closes cannot reach userQuestions.answer.
  // Optional service, same rule: resolve by name, never by property access.
  const userQuestions = scope.get?.('userQuestions')
  if (userQuestions !== undefined) answerer.setUserQuestionsService(userQuestions)
  lastAnswererForTests = answerer
  const driver = new GatewayDriver({
    ctx: scope, lark, router, config: resolved, logger: scope.logger, makeActionId,
    answererCallback: action => answerer.handleCardAction(action),
  })

  scope.effect(() => {
    status.write('boot-transport', { appId: resolved.appId, domain: resolved.domain })
    // HARDENING: startGatewayTransport returns a promise; leaving it
    // un-settled inside this (synchronous) cordis effect turned any startup
    // failure into an unhandled rejection, which kills the whole host
    // process. Settle it here; the disposer is captured on success, and
    // calling it is itself guarded.
    let stopTransport
    // STAGE HONESTY (desktop incident): boot used to write `connected`
    // before the SDK ever connected; now boot writes `transport-started`
    // and only onReady writes `connected`. The watchdog surfaces the SDK's
    // silent-failure mode (e.g. axios-proxy scheme errors loop forever
    // without onError) as `never-connected` in the status record.
    let watchdogCleared = false
    const clearWatchdog = () => { watchdogCleared = true; clearTimeout(watchdog) }
    const watchdog = setTimeout(() => {
      if (watchdogCleared || status.snapshot().stage === 'connected') return
      status.write('never-connected',
        'SDK did not report onReady within 30s. Common causes: proxy env with an https:// scheme '
        + '(breaks the SDK ws/axios layer — use http://), blocked WSS egress, or wrong credentials.')
      watchdogCleared = true
    }, Number(process.env.FEISHU_GATEWAY_READY_TIMEOUT_MS) > 0 ? Number(process.env.FEISHU_GATEWAY_READY_TIMEOUT_MS) : 30_000)
    watchdog.unref?.()
    let inboundCount = 0
    const eventLog = createEventLog()
    const countedEventLog = {
      log: (entry) => {
        eventLog.log(entry)
        inboundCount += 1
        status.setExtra({ inboundCount, lastEventAt: new Date().toISOString() })
      },
    }
    Promise.resolve().then(() => startGatewayTransport({
      config: { ...resolved, agent: wsAgent, httpInstance },
      handlers: {
        // safely(): plugin code must never take the host down — worst case
        // it logs to the console/status file and degrades.
        onMessage: safely(scope, 'message', n => driver.handleInbound(n)),
        onCardAction: safely(scope, 'card action', n => ['diff', 'resume', 'model', 'session-page'].includes(n.value?.kind)
          ? driver.handleCardAction(n)
          : answerer.handleCardAction(n)),
      },
      logger: scope.logger,
      // Same seam as the API client: the transport must not load the real
      // SDK behind the test fake's back.
      loadSdk: () => loadSdk(),
      // Inbound telemetry: ~/.dsh/feishu-gateway-events.json (doctor reads it).
      eventLog: countedEventLog,
      // Real connection lifecycle from the SDK (onReady/onError, SDK >= 1.74).
      onState: (state, detail) => {
        if (state === 'connected') { clearWatchdog(); status.setExtra({ connectedAt: new Date().toISOString() }) }
        if (state === 'transport-error') status.setExtra({ lastWsError: detail ?? null, lastWsErrorAt: new Date().toISOString() })
        status.write(state, detail ?? null)
      },
      // SDK error-level log lines (the only signal in the silent-failure mode).
      onWsError: (text) => status.setExtra({ lastWsError: text, lastWsErrorAt: new Date().toISOString() }),
    })).then(
      stop => { stopTransport = stop },
      error => {
        status.write('boot-failed', `transport: ${String(error)}`)
        scope.logger?.error?.(`feishu-gateway: transport failed to start: ${String(error)}`)
      },
    )
    const detachAnswerer = answerer.attach(scope)
    const offSessionEvents = scope.on('session/event', (session, event) => {
      // Contains both sync throws and async rejections of the listener.
      safely(scope, 'session event', () => driver.onSessionEvent(session, event))()
    }, { global: true })
    status.write('transport-started', { appId: resolved.appId })
    return () => {
      clearWatchdog()
      status.write('stopped')
      offSessionEvents(); detachAnswerer()
      try { stopTransport?.() } catch (error) { scope.logger?.warn?.(`feishu-gateway: transport stop failed: ${String(error)}`) }
    }
  }, 'dsh-feishu-gateway: transport + answerer + session events')
}

/**
 * Containment wrapper for every plugin entry point: the returned function
 * never throws synchronously and never returns a rejected promise — failures
 * land in the host log. The gateway is a guest in the host process; no
 * plugin bug may take dsh down.
 * @param {any} scope - owning cordis scope, for its logger.
 * @param {string} what - human label for the log line.
 * @param {(arg: any) => any} run - the guarded operation.
 */
function safely(scope, what, run) {
  return (arg) => {
    try {
      return Promise.resolve(run(arg)).catch(error => {
        scope.logger?.error?.(`feishu-gateway: ${what} failed: ${String(error)}`)
      })
    } catch (error) {
      scope.logger?.error?.(`feishu-gateway: ${what} failed: ${String(error)}`)
      return undefined
    }
  }
}
