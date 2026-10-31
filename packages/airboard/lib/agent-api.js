/**
 * Upstream JSON client for the AirBoard agent tools.
 *
 * One small wrapper over fetch with the row's baseUrl and the SAME token
 * resolution the browser proxy uses (credential store first, legacy config
 * fallback) — the token never leaves the Host process and never rides a tool
 * result. Errors are normalized to AirboardError so tool executions can map
 * them to model-facing text without leaking upstream internals.
 *
 * The API contract follows the service's own published agent instructions
 * (GET /api/agents/instructions, contract 2026-09-27.1).
 */

/** Normalized upstream failure surfaced to tool executions. */
export class AirboardError extends Error {
  /**
   * @param {string} code - 'airboard/unreachable' | 'airboard/bad-response' | 'airboard/upstream-error' | 'airboard/not-configured'.
   * @param {string} message - human-readable cause, safe for the model.
   * @param {number} [status] - upstream HTTP status when one was received.
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'AirboardError'
    this.code = code
    this.status = status
  }
}

/**
 * @param {{
 *   baseUrl: string,
 *   tokenProvider?: () => string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {{ get, post, patch }} JSON-request helpers; each resolves the
 * parsed upstream JSON body, and rejects with AirboardError on failure.
 */
export function createAirboardClient({ baseUrl, tokenProvider = () => '', timeoutMs = 15_000, fetchImpl = fetch }) {
  const origin = baseUrl.replace(/\/+$/, '')

  const request = async (method, path, { query, body, signal } = {}) => {
    const url = new URL(`${origin}${path}`)
    if (query !== undefined) {
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value))
      }
    }
    const token = tokenProvider()
    let response
    try {
      response = await fetchImpl(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      // AbortSignal timeout/errors stay identifiable; anything else is a
      // network-layer fault normalized to airboard/unreachable.
      if (error instanceof AirboardError) throw error
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
      throw new AirboardError('airboard/unreachable', String(error?.message ?? error))
    }
    let json
    try { json = await response.json() } catch {
      throw new AirboardError('airboard/bad-response', `AirBoard answered non-JSON (HTTP ${response.status})`, response.status)
    }
    if (!response.ok) {
      const detail = json?.error?.message ?? json?.message ?? JSON.stringify(json).slice(0, 200)
      throw new AirboardError('airboard/upstream-error', `AirBoard HTTP ${response.status}: ${detail}`, response.status)
    }
    return json
  }

  return {
    get: (path, query, signal) => request('GET', path, { query, signal }),
    post: (path, body, signal) => request('POST', path, { body, signal }),
    patch: (path, body, signal) => request('PATCH', path, { body, signal }),
  }
}
