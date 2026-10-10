/**
 * dsh-airboard — Host half.
 *
 * One contribution: a same-origin read-only proxy for an AirBoard service,
 * mounted on the Web server as `/airboard/**`. The browser half (client.js)
 * fetches this prefix, so the access token never leaves the Host process and
 * the AirBoard server needs no CORS headers.
 *
 * The whitelist below is deliberately narrow: GET only, and only the AirBoard
 * read endpoints the viewer uses. Everything else — writes, admin routes,
 * foreign paths — answers 404 from this process without an upstream call.
 *
 * Configuration lives on the Loader row (`airboard`), edited on the Plugins
 * page or defaulted from AIRBOARD_BASE_URL / AIRBOARD_TOKEN through the
 * bundle's patch layer; see README.md.
 */
import Schema from '@deepseek-ai/schemastery'

/** The Web-server prefix this plugin owns. Absolute, no trailing slash. */
export const PROXY_PREFIX = '/airboard'

/**
 * The read-only surface: each entry matches the path *under* the prefix.
 * Segments stay percent-encoded as the browser sent them; `[^/]+` therefore
 * accepts any single segment and no more.
 */
const ALLOWED_SUBPATHS = [
  /^\/api\/health$/,
  /^\/api\/agents\/instructions$/,
  /^\/api\/projects$/,
  /^\/api\/projects\/[^/]+$/,
  /^\/api\/projects\/[^/]+\/resources$/,
  /^\/api\/projects\/[^/]+\/resources\/[^/]+$/,
  /^\/api\/projects\/[^/]+\/resources\/[^/]+\/revisions$/,
  /^\/api\/projects\/[^/]+\/resources\/[^/]+\/revisions\/[^/]+$/,
  /^\/api\/search$/,
]

/** Upstream request timeout; AirBoard answers in well under a second locally. */
const UPSTREAM_TIMEOUT_MS = 15_000
/** Response size cap: docs are small; anything huge is a misrouted origin. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * Decide whether a request may be proxied, and to which upstream path.
 *
 * `url` is the raw `IncomingMessage.url` (a path plus optional query). Dot
 * segments normalize inside the URL parser before matching, so `/airboard/..`
 * no longer carries the prefix and is refused.
 *
 * @param {string | undefined} method - HTTP method as Node reports it.
 * @param {string | undefined} url - raw request URL.
 * @returns {{ subpath: string, query: string } | null} the proxied target, or null.
 */
export function resolveProxyRequest(method, url) {
  if (method !== 'GET') return null
  let parsed
  try {
    parsed = new URL(url ?? '/', 'http://airboard.invalid')
  } catch {
    return null
  }
  const { pathname, search } = parsed
  if (pathname !== PROXY_PREFIX && !pathname.startsWith(`${PROXY_PREFIX}/`)) return null
  const subpath = pathname.slice(PROXY_PREFIX.length)
  if (!ALLOWED_SUBPATHS.some((pattern) => pattern.test(subpath))) return null
  return { subpath, query: search }
}

/**
 * Compose the upstream URL: base without trailing slashes, then the whitelisted
 * subpath and query as received.
 *
 * @param {string} baseUrl - configured AirBoard service origin.
 * @param {string} subpath - whitelisted path under the prefix.
 * @param {string} query - query string including its leading `?`, or empty.
 * @returns {string} the absolute upstream URL.
 */
export function buildUpstreamUrl(baseUrl, subpath, query) {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return new URL(`${trimmed}${subpath}${query}`).toString()
}

/**
 * Read a config field that the Loader may hand over as a volatile wrapper or
 * as a plain value (tests, plain mounts).
 * @param {unknown} value - the field as `config` carries it.
 * @returns {string} the current string value.
 */
function readString(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'string' ? raw : ''
}

/** Write a JSON error envelope the browser half can render. */
function sendJson(res, status, code, message) {
  if (res.writableEnded) return
  const body = JSON.stringify({ error: { code, message } })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Build the prefix-route handler.
 *
 * @param {{ baseUrl?: unknown, token?: unknown }} config - the row's config.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options] - seams for tests.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
export function makeProxyHandler(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS
  return async (req, res) => {
    const resolved = resolveProxyRequest(req.method, req.url)
    if (resolved === null) {
      sendJson(res, 404, 'NOT_ALLOWED', 'dsh-airboard proxies read-only AirBoard GET endpoints only')
      return
    }
    const baseUrl = readString(config.baseUrl)
    if (baseUrl === '') {
      sendJson(res, 503, 'AIRBOARD_BASE_URL_MISSING', 'Set baseUrl in the AirBoard plugin configuration')
      return
    }
    let upstreamUrl
    try {
      upstreamUrl = buildUpstreamUrl(baseUrl, resolved.subpath, resolved.query)
    } catch {
      sendJson(res, 503, 'AIRBOARD_BASE_URL_INVALID', `Cannot build a URL from the configured baseUrl: ${baseUrl}`)
      return
    }
    const headers = { accept: 'application/json' }
    const token = readString(config.token)
    if (token !== '') headers.authorization = `Bearer ${token}`
    let upstream
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const cause = /** @type {Error} */ (error)?.cause ?? error
      sendJson(res, 502, 'AIRBOARD_UNREACHABLE', `AirBoard at ${baseUrl} did not answer: ${cause?.message ?? String(cause)}`)
      return
    }
    const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'
    if (upstream.status >= 300 && upstream.status < 400) {
      // redirect: 'manual' means a redirecting origin surfaces here, not as a
      // silent second hop; tell the operator to point baseUrl at the final one.
      sendJson(res, 502, 'AIRBOARD_UNREACHABLE', `AirBoard at ${baseUrl} answered a redirect (${upstream.status}); set baseUrl to the service's final origin`)
      return
    }
    let body
    try {
      body = Buffer.from(await upstream.arrayBuffer())
    } catch (error) {
      sendJson(res, 502, 'AIRBOARD_UNREACHABLE', `AirBoard response was not readable: ${/** @type {Error} */ (error)?.message}`)
      return
    }
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      sendJson(res, 502, 'AIRBOARD_RESPONSE_TOO_LARGE', `AirBoard response was ${body.byteLength} bytes; the cap is ${MAX_RESPONSE_BYTES}`)
      return
    }
    if (res.writableEnded) return
    res.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-store' })
    res.end(body)
  }
}

/** Row configuration: the service address. The access token is a credential
 *  (AIRBOARD_TOKEN by default) resolved through `ctx.credentials` — written by
 *  the Plugins-page secret control into the credential store, or supplied by
 *  the launch environment; the legacy `token` field remains as a read-only
 *  fallback for profiles that predate the credential store. */
export const Config = Schema.object({
  baseUrl: Schema.string().default('http://ab.antaresy.cc').volatile(),
  token: Schema.string().role('secret').default('').volatile(),
  tokenEnv: Schema.string().role('credential-ref').default('AIRBOARD_TOKEN').volatile(),
})

/**
 * Resolve the AirBoard token: credential store first, legacy config value
 * second. Exposed for tests.
 * @param {{ resolve(ref: string): Promise<{ value: string } | undefined> }} credentials - the credentials service.
 * @param {string} ref - credential reference name.
 * @param {unknown} legacyToken - the deprecated config `token` field.
 * @returns {Promise<string>} the token, or '' when nothing supplies one.
 */
export async function resolveAirboardToken(credentials, ref, legacyToken) {
  const stored = await credentials?.resolve?.(ref)
  if (stored?.value !== undefined && stored.value !== '') return stored.value
  return readString(legacyToken)
}

/**
 * Mount the proxy on the Web server when one runs. `webServer` is optional so
 * the bundle stays inert in headless profiles; `credentials` is resolved when
 * present so the token follows the credential store (and the legacy config
 * value still works where the store is absent).
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ baseUrl?: unknown, token?: unknown, tokenEnv?: unknown }} config - validated row config.
 */
export function apply(ctx, config) {
  ctx.inject(['webServer', 'credentials'], async (webCtx) => {
    const tokenEnv = readString(config.tokenEnv) || 'AIRBOARD_TOKEN'
    const makeResolvedHandler = async () => makeProxyHandler({
      baseUrl: config.baseUrl,
      token: await resolveAirboardToken(webCtx.credentials, tokenEnv, config.token),
    })
    let handler = await makeResolvedHandler()
    // A credential write (the Plugins-page secret control) re-resolves the
    // token without waiting for a profile reload.
    const offTokenUpdates = webCtx.on('credentials/reference-updated', async (ref) => {
      if (ref === tokenEnv) handler = await makeResolvedHandler()
    })
    webCtx.effect(
      () => {
        const off = webCtx.webServer.register({
          kind: 'prefix',
          path: PROXY_PREFIX,
          handler: (req, res) => handler(req, res),
        })
        return () => { off(); offTokenUpdates() }
      },
      'dsh-airboard: read-only AirBoard proxy',
    )
  })
}
