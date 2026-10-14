/**
 * Proxy support for the Lark SDK's two HTTP halves.
 *
 * WHY THIS EXISTS (the desktop deployment incident): the SDK resolves its own
 * axios (declared ^1.16) and lets axios's env-proxy path handle https_proxy —
 * older axios lines hand an https: destination to Node's http.request and die
 * with `Protocol "https:" not supported. Expected "http:"`, so a perfectly
 * standard `https_proxy=http://127.0.0.1:PORT` breaks BOTH the REST client and
 * the WS config pull, while the ws socket itself ignores proxy env entirely.
 *
 * The plugin therefore owns the proxy decision once, deterministically:
 *   - REST: an axios instance with `proxy: false` + explicit agents (CONNECT
 *     tunneling by axios 1.20, the version this package pins), passed to both
 *     `Lark.Client` and `Lark.WSClient` through their `httpInstance` seam.
 *     The instance replicates defaultHttpInstance's response unwrap
 *     (`return resp.data`), which the SDK's call sites rely on.
 *   - WS: an `HttpsProxyAgent` passed as WSClient's `agent` (the sanctioned
 *     param) so the wss:// socket itself goes through the proxy.
 *
 * Standard env semantics: https_proxy for https targets, http_proxy for http,
 * all_proxy as fallback, no_proxy bypass list (comma-separated, leading dots
 * and wildcards tolerated).
 */

/** True when hostname matches one no_proxy entry. */
function matchesNoProxy(hostname, list) {
  if (typeof list !== 'string' || list.trim() === '') return false
  for (const raw of list.split(',')) {
    let entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    if (entry.startsWith('.')) entry = entry.slice(1)
    const host = hostname.toLowerCase()
    if (host === entry || host.endsWith(`.${entry}`)) return true
  }
  return false
}

const firstString = (...values) => values.find(v => typeof v === 'string' && v !== '')

/**
 * Resolve the proxy URL for one target URL from the standard env vars.
 * @param {string} target - absolute URL (the configured open-platform domain).
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {string | undefined} proxy URL, or undefined to connect directly.
 */
export function proxyUrlFor(target, env = process.env) {
  let url
  try { url = new URL(target) } catch { return undefined }
  if (matchesNoProxy(url.hostname, firstString(env.no_proxy, env.NO_PROXY) ?? '')) return undefined
  const https = url.protocol === 'https:'
  const candidates = https
    ? [firstString(env.https_proxy, env.HTTPS_PROXY), firstString(env.all_proxy, env.ALL_PROXY), firstString(env.http_proxy, env.HTTP_PROXY)]
    : [firstString(env.http_proxy, env.HTTP_PROXY), firstString(env.all_proxy, env.ALL_PROXY), firstString(env.https_proxy, env.HTTPS_PROXY)]
  return candidates.find(c => c !== undefined) ?? undefined
}

/** Lazily loaded agent/axios constructors: unit tests without these packages
 * (or with fake SDKs) never pay for the real imports. */
let loaded = undefined
async function loadImplementations() {
  if (loaded === undefined) {
    const [{ default: axios }, { HttpsProxyAgent }, { HttpProxyAgent }] = await Promise.all([
      import('axios'), import('https-proxy-agent'), import('http-proxy-agent'),
    ])
    loaded = { axios, HttpsProxyAgent, HttpProxyAgent }
  }
  return loaded
}

/**
 * Build the SDK `httpInstance` for a proxied deployment. Mirrors
 * defaultHttpInstance (node-sdk lib/index.js): response interceptor unwraps
 * `resp.data` unless `$return_headers` asks for headers too. `proxy: false`
 * disables axios's own env handling entirely — our agents are the only path.
 * @param {string} proxyUrl
 * @param {{ axios?: any, HttpsProxyAgent?: any, HttpProxyAgent?: any }} [seams] test seams.
 * @returns {Promise<any>} axios instance.
 */
export async function createProxiedLarkHttpInstance(proxyUrl, seams = {}) {
  const impl = seams.axios !== undefined && seams.HttpsProxyAgent !== undefined && seams.HttpProxyAgent !== undefined
    ? { axios: seams.axios, HttpsProxyAgent: seams.HttpsProxyAgent, HttpProxyAgent: seams.HttpProxyAgent }
    : await loadImplementations()
  const instance = impl.axios.create({
    proxy: false,
    httpAgent: new impl.HttpProxyAgent(proxyUrl),
    httpsAgent: new impl.HttpsProxyAgent(proxyUrl),
  })
  instance.interceptors.response.use(
    resp => (resp.config !== undefined && resp.config['$return_headers'])
      ? { data: resp.data, headers: resp.headers }
      : resp.data,
  )
  return instance
}

/**
 * The ws socket agent for WSClient (`agent` param): one CONNECT-tunneling
 * agent serves the wss:// long connection through the http proxy.
 * @param {string | undefined} proxyUrl
 * @param {{ HttpsProxyAgent?: any }} [seams] test seam.
 * @returns {Promise<any | undefined>} agent, or undefined for direct egress.
 */
export async function wsAgentFor(proxyUrl, seams = {}) {
  if (proxyUrl === undefined) return undefined
  const HttpsProxyAgent = seams.HttpsProxyAgent ?? (await loadImplementations()).HttpsProxyAgent
  return new HttpsProxyAgent(proxyUrl)
}
