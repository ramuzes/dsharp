/**
 * dsh-engram — Host half.
 *
 * One contribution: durable agent memory via a local engram daemon. On mount
 * this file wires the Task 1-7 lib modules together in apply(): staged boot
 * observability, credential-ref resolution with live refresh, volatile
 * config providers, memoized daemon stewardship with unreachable recovery,
 * session bridging, proactive context injection, and the seven engram_* tools.
 *
 * Structure mirrors packages/gitlab/index.js:86-151 (noteStage pattern,
 * resolveToken + credentials/reference-updated listener, volatile providers
 * re-read per call). Inject-list exactness: only the five services named
 * below are touched on the inject scope — all five verified against the live
 * host catalog (cordis_inspect Service.listService): tools, systemPrompt,
 * credentials, subprocess, workingDirectory.
 *
 * Configuration lives on the Loader row (`engram`), edited on the Plugins
 * page or defaulted through the bundle's patch layer; see README.md.
 */
import Schema from '@deepseek-ai/schemastery'
import { makeStatusWriter } from './lib/status.js'
import { createEngramClient, EngramError } from './lib/engram-api.js'
import { ensureDaemon } from './lib/daemon.js'
import { createProjectResolver } from './lib/project-resolution.js'
import { registerAgentTools } from './lib/agent-tools.js'
import { registerSessionBridge } from './lib/session-bridge.js'
import { registerContextInjection } from './lib/context-injection.js'

/** Fixed client timeout — the Task 1 schema deliberately has no timeout
 *  field, so the protocol-generic 5 s default applies (no schema growth in
 *  this task). */
const REQUEST_TIMEOUT_MS = 5000

/**
 * Read a config field that the Loader may hand over as a volatile wrapper or
 * as a plain value (tests, plain mounts). The Loader hands plugin config
 * fields as schemastery reactive wrappers — objects with `.get()` — never as
 * plain strings; raw use dies with `TypeError: x.replace is not a function`
 * (see AGENTS.md, "Config values arrive wrapped"). EVERY config read in this
 * package goes through readString/readNumber.
 */
export function readString(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'string' ? raw : ''
}

/** Read a volatile number field (same reactive-wrapper rule). */
export function readNumber(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : NaN
}

/**
 * Row configuration. Per ADR-0005: defaults are empty or protocol-generic —
 * no deployment addresses or credentials baked in. Secrets appear only as
 * credential-ref NAMES (httpTokenRef / cloudServerRef / cloudTokenRef),
 * resolved through ctx.credentials at mount time (Task 8) — never as values.
 *
 * Volatile fields are the ones Plugins-page edits apply live (settings.mutate
 * persists accepted edits into the profile patch — it is not a persistence
 * switch; an entry with no volatile field is dropped from the settings
 * document). daemonMode stays non-volatile: it changes mount-time stewardship
 * structure, so edits there take effect on reload.
 */
export const Config = Schema.object({
  daemonMode: Schema.union(['auto-spawn', 'connect-only']).default('auto-spawn'),
  // '' = engram's documented protocol default (7437); the client treats
  // empty as 7437 — the port number is never baked into the schema.
  port: Schema.string().default('').volatile(),
  httpTokenRef: Schema.string().role('credential-ref').default('').volatile(),
  cloudServerRef: Schema.string().role('credential-ref').default('').volatile(),
  cloudTokenRef: Schema.string().role('credential-ref').default('').volatile(),
  autosync: Schema.boolean().default(false).volatile(),
  contextInjection: Schema.union(['off', 'on']).default('off').volatile(),
  contextMaxBytes: Schema.number().min(0).default(2048).volatile(),
  projectMode: Schema.union(['auto', 'fixed', 'map']).default('auto').volatile(),
  fixedProject: Schema.string().default('').volatile(),
  projectMap: Schema.dict(String).default({}).volatile(),
  toolProfile: Schema.union(['core', 'extended']).default('core').volatile(),
})

/** Read a volatile boolean field (same reactive-wrapper rule). */
export function readBoolean(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return raw === true
}

/**
 * Read a volatile object field (Schema.dict) — same unwrap rule as
 * readString/readNumber but preserving the object; anything non-object
 * collapses to {} so downstream prefix matching never dies.
 */
export function readObject(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/**
 * Mount the plugin (Task 8 wiring). Stage sequence (status file, airboard
 * pattern): apply → tools-inject → tools-registered, or tools-failed with
 * the error text on a mount-time failure — which is then rethrown so a dead
 * mount stays loud (packages/gitlab/index.js pattern).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated row config (fields may be reactive wrappers).
 */
export function apply(ctx, config) {
  const { note } = makeStatusWriter()
  note('apply')

  // 'tools' + 'systemPrompt' (agent tools + prompt section), 'credentials'
  // (ref resolution), 'subprocess' (daemon spawn seam), 'workingDirectory'
  // (session cwd for project resolution) — each name verified against the
  // live host service catalog; accessing a non-injected name throws in cordis.
  ctx.inject(['tools', 'systemPrompt', 'credentials', 'subprocess', 'workingDirectory'], async (scope) => {
    note('tools-inject')
    try {
      // ---- credentials: cached values, refreshed on reference updates -----
      // Refs are NAMES, resolved through the credentials service; empty or
      // unresolvable refs contribute '' (buildEnv then omits them).
      const refNames = {
        httpToken: () => readString(config.httpTokenRef),
        cloudServer: () => readString(config.cloudServerRef),
        cloudToken: () => readString(config.cloudTokenRef),
      }
      const values = { httpToken: '', cloudServer: '', cloudToken: '' }
      const refreshValues = async () => {
        const [httpToken, cloudServer, cloudToken] = await Promise.all([
          refNames.httpToken() ? scope.credentials.resolve(refNames.httpToken()) : undefined,
          refNames.cloudServer() ? scope.credentials.resolve(refNames.cloudServer()) : undefined,
          refNames.cloudToken() ? scope.credentials.resolve(refNames.cloudToken()) : undefined,
        ])
        values.httpToken = httpToken?.value ?? ''
        values.cloudServer = cloudServer?.value ?? ''
        values.cloudToken = cloudToken?.value ?? ''
      }
      await refreshValues()
      // Live refresh on credential updates (gitlab index.js:116 pattern);
      // the listener re-reads only when one of OUR refs changed.
      const offCredUpdates = scope.on('credentials/reference-updated', async (ref) => {
        if (ref === refNames.httpToken() || ref === refNames.cloudServer()
          || ref === refNames.cloudToken()) {
          try { await refreshValues() } catch { /* keep last good values */ }
        }
      })

      // ---- volatile providers: re-read config on every call ---------------
      const getPort = () => {
        const raw = readString(config.port).trim()
        const n = Number(raw)
        return raw !== '' && Number.isInteger(n) && n > 0 ? n : 0
      }
      const client = createEngramClient({
        baseUrlProvider: () => `http://127.0.0.1:${getPort() || 7437}`,
        tokenProvider: () => values.httpToken,
        timeoutMsProvider: () => REQUEST_TIMEOUT_MS,
      })

      // Daemon spawn environment: ONLY non-empty extras (blank cloud refs
      // contribute nothing).
      const buildDaemonEnv = () => {
        const env = {}
        const port = getPort()
        if (port) env.ENGRAM_PORT = String(port)
        if (values.httpToken !== '') env.ENGRAM_HTTP_TOKEN = values.httpToken
        if (readBoolean(config.autosync)) {
          env.ENGRAM_CLOUD_AUTOSYNC = '1'
          if (values.cloudServer !== '') env.ENGRAM_CLOUD_SERVER = values.cloudServer
          if (values.cloudToken !== '') env.ENGRAM_CLOUD_TOKEN = values.cloudToken
        }
        return env
      }

      // ---- memoized daemon stewardship with unreachable recovery ---------
      // Success is memoized; a failing ensure clears the memo so the NEXT
      // call re-ensures, and the client wrapper below additionally invalidates
      // the memo when a tool call surfaces engram/unreachable mid-session
      // (daemon died after a successful ensure) — one re-ensure per failure.
      let readyPromise
      const ensureReady = () => {
        if (!readyPromise) {
          readyPromise = ensureDaemon({
            client,
            subprocess: scope.subprocess,
            spawnEnabled: readString(config.daemonMode) === 'auto-spawn',
            buildEnv: buildDaemonEnv,
            note: (stage) => note(stage),
          }).catch((err) => {
            readyPromise = undefined
            throw err
          })
        }
        return readyPromise
      }
      const guarded = (method) => async (...args) => {
        try {
          return await client[method](...args)
        } catch (err) {
          if (err instanceof EngramError && err.code === 'engram/unreachable') {
            readyPromise = undefined
          }
          throw err
        }
      }
      const toolClient = { get: guarded('get'), post: guarded('post'), del: guarded('del') }

      // ---- session-keyed project resolution -------------------------------
      const sessionIdOf = (agent) => agent?.session?.id ?? ''
      const resolver = createProjectResolver({
        client,
        getMode: () => readString(config.projectMode),
        getFixedProject: () => readString(config.fixedProject),
        getProjectMap: () => readObject(config.projectMap),
        // Live working directory per session, from the injected service.
        getWorkingDir: (session) => scope.workingDirectory.get(session),
      })
      // The resolver is session-keyed; the bridge/injection listeners hold
      // the AGENT — adapt (ledger carry-overs 1 & 3).
      const resolveProjectByAgent = (agent) => resolver.resolve(agent?.session)

      // Runtime containment sink for bridge/injection notes: stage 'runtime'
      // so a late failure is visible without claiming the mount itself died.
      const runtimeNote = (message) => note('runtime', message)

      // ---- bridge + injection (listeners on the plugin fiber root) --------
      const bridge = registerSessionBridge(ctx, {
        client,
        resolveProject: resolveProjectByAgent,
        note: runtimeNote,
        sessionIdOf,
      })
      const offInjection = registerContextInjection(ctx, {
        client,
        resolveProject: resolveProjectByAgent,
        note: runtimeNote,
        getEnabled: () => readString(config.contextInjection) === 'on',
        getMaxBytes: () => readNumber(config.contextMaxBytes) || 2048,
      })

      // ---- tools (ledger carry-over 2: ensureSession takes the EXEC) ------
      const offTools = registerAgentTools(scope, {
        client: toolClient,
        resolveProject: (session, explicit) => resolver.resolve(session, explicit),
        ensureReady,
        ensureSession: (exec) => bridge.ensureSession(exec?.agent),
        sessionIdOf,
      })

      note('tools-registered', {
        port: getPort() || 7437,
        tokenConfigured: values.httpToken !== '',
        autosync: readBoolean(config.autosync),
        contextInjection: readString(config.contextInjection),
      })
      return () => {
        offTools()
        offInjection()
        offCredUpdates()
        // Async by design and internally contained; never blocks unload.
        void bridge.dispose()
      }
    } catch (error) {
      note('tools-failed', String(error))
      throw error
    }
  })
}
