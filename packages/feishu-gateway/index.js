/**
 * dsh-feishu-gateway — Host half.
 *
 * Wires the modules into the host: the SDK client (credentials from the
 * Loader row, env-defaulted), the long-connection transport, the binding
 * router (persisted through ctx.storageDomain — see createDomainPersist),
 * the driver, and the answerer. Inert until appId/appSecret are configured.
 */
import Schema from '@deepseek-ai/schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { Config as RowConfig } from './lib/config.js'
import { LarkClient, readConfigString } from './lib/lark-client.js'
import { startGatewayTransport } from './lib/transport.js'
import { BindingRouter } from './lib/router.js'
import { GatewayDriver } from './lib/driver.js'
import { GatewayAnswerer } from './lib/answerer.js'

/** @type {any} */
let sdkOverride = undefined

/** Test seam: inject a fake SDK (Client/WSClient/EventDispatcher/LoggerLevel). */
export function setSdkForTests(fake) { sdkOverride = fake }

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

/** The chat-binding KV domain (SPEC: bindings persist through storage domain). */
const bindingDomain = defineDomain({
  name: 'feishu_gateway_bindings',
  version: 1,
  tables: {
    bindings: domainTable(Schema.object({
      chatId: Schema.string(),
      workspaceId: Schema.string(),
      workspaceTitle: Schema.string(),
      workspacePath: Schema.string(),
      activeSessionId: Schema.string(),
      activeSessionTitle: Schema.string(),
      sessionHistory: Schema.array(Schema.object({ sessionId: Schema.string(), title: Schema.string() })),
      updatedAt: Schema.number(),
    })),
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
      if (ctx.storageDomain === undefined) return undefined
      const domain = await ctx.storageDomain.open(bindingDomain)
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

  ctx.inject(['credentials', 'agents', 'workspaceRegistry', 'apiSessions', 'workspaceChanges', 'llm'], async (scope) => {
    const credential = await scope.credentials.resolve(appSecretEnv)
    const appSecret = credential?.value ?? ''
    if (appId === '' || appSecret === '') {
      scope.logger.info?.(
        `feishu-gateway: appId not set or credential "${appSecretEnv}" unresolved — gateway inactive. `
        + 'Set appId and the App Secret on the Plugins page form.',
      )
      return
    }
    await boot(scope, { ...resolved, appSecret }).catch(e => ctx.logger?.warn?.(`feishu-gateway: boot failed: ${String(e)}`))
  })
}

/** Async half of apply()'s inject callback (kept separate so boot failures are contained). */
async function boot(scope, resolved) {
  const Lark = await loadSdk()
  const sdkClient = new Lark.Client({ appId: resolved.appId, appSecret: resolved.appSecret, domain: resolved.domain })
  const lark = new LarkClient({ sdkClient, logger: scope.logger })
  let actionSeq = 0
  const makeActionId = () => `fg_${Date.now().toString(36)}_${++actionSeq}`

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
  if (scope.userQuestions !== undefined) answerer.setUserQuestionsService(scope.userQuestions)
  lastAnswererForTests = answerer
  const driver = new GatewayDriver({
    ctx: scope, lark, router, config: resolved, logger: scope.logger, makeActionId,
    answererCallback: action => answerer.handleCardAction(action),
  })

  scope.effect(() => {
    const stopTransport = startGatewayTransport({
      config: resolved,
      handlers: {
        onMessage: n => driver.handleInbound(n),
        onCardAction: n => n.value?.kind === 'diff' || n.value?.kind === 'resume' || n.value?.kind === 'model'
          ? driver.handleCardAction(n)
          : answerer.handleCardAction(n),
      },
      logger: scope.logger,
      // Same seam as the API client: the transport must not load the real
      // SDK behind the test fake's back.
      loadSdk: () => loadSdk(),
    })
    const detachAnswerer = answerer.attach(scope)
    const offSessionEvents = scope.on('session/event', (session, event) => {
      driver.onSessionEvent(session, event).catch(e => scope.logger.warn?.(`feishu-gateway: session event failed: ${String(e)}`))
    }, { global: true })
    return () => { offSessionEvents(); detachAnswerer(); stopTransport?.() }
  }, 'dsh-feishu-gateway: transport + answerer + session events')
}
