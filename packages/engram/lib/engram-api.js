/**
 * engram HTTP client — the dependency-free base lib module (Task 2).
 *
 * Error mapping is exact per the engram contract:
 *   network failure      -> engram/unreachable
 *   non-2xx response     -> engram/http     (status + info = parsed JSON body)
 *   non-JSON 2xx body    -> engram/bad-response
 * Every failure path throws a typed EngramError, never a raw exception,
 * and abort/timeout surfaces as engram/unreachable instead of hanging.
 */
export class EngramError extends Error {
  /**
   * @param {string} code namespaced error code, e.g. 'engram/http'
   * @param {string} message human-readable text including the code and,
   *   when present, the server's `error` field
   * @param {{ status?: number, info?: unknown }} [detail]
   */
  constructor(code, message, { status, info } = {}) {
    super(message)
    this.name = 'EngramError'
    this.code = code
    this.status = status
    this.info = info
  }
}

/** Parse a JSON body; anything unparsable becomes null (caller decides). */
async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * @param {string} baseUrl daemon base URL, no trailing slash assumptions
 * @param {string} path path beginning with '/'
 * @param {Record<string, unknown>|undefined} [query]
 */
function buildUrl(baseUrl, path, query) {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url
}

/**
 * @param {{ baseUrlProvider(): string, tokenProvider(): string,
 *           timeoutMsProvider(): number, fetchImpl?: typeof fetch }} deps
 * @returns {{ get(path: string, query?: object, signal?: AbortSignal): Promise<any>,
 *             post(path: string, body?: unknown, signal?: AbortSignal): Promise<any>,
 *             del(path: string, query?: object, signal?: AbortSignal): Promise<any> }}
 */
export function createEngramClient({
  baseUrlProvider,
  tokenProvider,
  timeoutMsProvider,
  fetchImpl = fetch,
}) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {{ query?: object, body?: unknown, signal?: AbortSignal }} [opts]
   */
  async function request(method, path, { query, body, signal } = {}) {
    const url = buildUrl(baseUrlProvider(), path, query)
    const token = tokenProvider()
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'

    // Combine the caller's signal with the timeout so an external cancel
    // or the deadline both abort the fetch (Node >= 20 has AbortSignal.any).
    // Only pass defined signals — AbortSignal.any rejects undefined entries.
    const signals = [signal, AbortSignal.timeout(timeoutMsProvider())].filter(
      (s) => s !== undefined && s !== null)
    const timeoutSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)

    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: timeoutSignal,
      })
    } catch (err) {
      // fetch failure, external abort, and timeout all land here as
      // TypeError/AbortError — surface as one typed unreachable error.
      throw new EngramError('engram/unreachable',
        `engram/unreachable: request to ${path} failed (${err?.message ?? err})`)
    }

    if (!response.ok) {
      const info = await readJson(response)
      // 409 conflict bodies and friends carry an `error` string field;
      // include it in the message so callers can act without re-parsing.
      const serverError = info && typeof info.error === 'string' ? info.error : ''
      throw new EngramError('engram/http',
        `engram/http: ${method} ${path} -> ${response.status}${serverError ? `: ${serverError}` : ''}`,
        { status: response.status, info })
    }

    const data = await readJson(response)
    if (data === null) {
      throw new EngramError('engram/bad-response',
        `engram/bad-response: ${method} ${path} returned a non-JSON 2xx body`,
        { status: response.status })
    }
    return data
  }

  return {
    get: (path, query, signal) => request('GET', path, { query, signal }),
    post: (path, body, signal) => request('POST', path, { body, signal }),
    del: (path, query, signal) => request('DELETE', path, { query, signal }),
  }
}

/**
 * Probe /health and narrow the payload to what later tasks branch on.
 * @param {{ get(path: string, query?: object, signal?: AbortSignal): Promise<any> }} client
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ version: string, capabilities: object }>}
 */
export async function probeHealth(client, signal) {
  const health = await client.get('/health', undefined, signal)
  return { version: health.version, capabilities: health.capabilities }
}

/**
 * True iff the daemon version is at least 3.7 in major.minor terms.
 * @param {string|undefined} version
 * @returns {boolean}
 */
export function isSupportedVersion(version) {
  if (typeof version !== 'string') return false
  const match = /^(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  const [major, minor] = [Number(match[1]), Number(match[2])]
  return major > 3 || (major === 3 && minor >= 7)
}
