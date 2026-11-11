/**
 * REST client for the GitLab API v4.
 *
 * One wrapper over fetch with the row's baseUrl and a Host-side token
 * provider (credential store first — see index.js). The token never leaves
 * the Host process: it rides only the `PRIVATE-TOKEN` request header, and
 * every error message / response body is redacted against it before it can
 * reach a tool result (lib/agent-tools.js failure path included).
 *
 * API surface follows GitLab API v4 (docs.gitlab.com/ee/api/). The project
 * "id" in paths accepts the URL-encoded namespace path, e.g.
 * encodeURIComponent('group/project').
 */

/** Normalized upstream failure surfaced to tool executions. */
export class GitlabError extends Error {
  /**
   * @param {string} code - 'gitlab/not-configured' | 'gitlab/unreachable'
   *   | 'gitlab/bad-response' | 'gitlab/api-error' | 'gitlab/path-outside-workspace'
   *   | 'gitlab/git-failed'.
   * @param {string} message - human-readable cause, safe for the model.
   * @param {number} [status] - upstream HTTP status when one was received.
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'GitlabError'
    this.code = code
    this.status = status
  }
}

/** Replace every occurrence of the secret (and its common encodings) with ***. */
export function redact(text, token) {
  if (!token || typeof text !== 'string') return text ?? ''
  let out = text.split(token).join('***')
  for (const variant of [token, `oauth2:${token}`, `:${token}`]) {
    try { out = out.split(Buffer.from(variant).toString('base64')).join('***') } catch { /* not encodable */ }
  }
  return out
}

/**
 * URL-encode a project reference once for use as a path segment.
 * Accepts numeric ids as-is and namespace paths like 'group/project'.
 * @param {string | number} project
 * @returns {string}
 */
export function projectIdSegment(project) {
  return encodeURIComponent(String(project))
}

/**
 * @param {{
 *   baseUrl: string,
 *   tokenProvider: () => string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {{ get, post, put, del }} JSON-request helpers; each resolves the
 * parsed upstream JSON body (or raw text when text=true), and rejects with
 * GitlabError on failure.
 */
export function createGitlabClient({ baseUrl, tokenProvider, timeoutMs = 20_000, fetchImpl = fetch }) {
  const origin = baseUrl.replace(/\/+$/, '')
  const api = `${origin}/api/v4`

  const request = async (method, path, { query, body, signal, text } = {}) => {
    if (origin === '') throw new GitlabError('gitlab/not-configured', 'GitLab baseUrl is not set; configure it on the Plugins page (or GITLAB_URL).')
    const token = tokenProvider()
    const url = new URL(`${api}${path}`)
    if (query !== undefined) {
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value))
      }
    }
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: text ? 'text/plain' : 'application/json',
          ...(token === '' ? {} : { 'private-token': token }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
      throw new GitlabError('gitlab/unreachable', redact(String(error?.message ?? error), token))
    }
    if (text) {
      if (!response.ok) throw new GitlabError('gitlab/api-error', await upstreamErrorText(response, token), response.status)
      return redact(await response.text(), token)
    }
    let json
    const raw = await response.text()
    try { json = raw === '' ? undefined : JSON.parse(raw) } catch {
      throw new GitlabError('gitlab/bad-response', `GitLab answered non-JSON (HTTP ${response.status}): ${redact(raw.slice(0, 200), token)}`, response.status)
    }
    if (!response.ok) {
      const detail = json?.message ?? json?.error ?? JSON.stringify(json).slice(0, 300)
      throw new GitlabError('gitlab/api-error', `GitLab HTTP ${response.status}: ${redact(String(detail), token)}`, response.status)
    }
    return json
  }

  return {
    get: (path, query, signal, opts = {}) => request('GET', path, { query, signal, ...opts }),
    post: (path, body, signal) => request('POST', path, { body, signal }),
    put: (path, body, signal) => request('PUT', path, { body, signal }),
    del: (path, body, signal) => request('DELETE', path, { body, signal }),
  }
}

/** Build the model-facing error message for a !ok JSON response. */
async function upstreamErrorText(response, token) {
  const raw = await response.text()
  let detail = raw
  try { detail = JSON.parse(raw)?.message ?? raw } catch { /* keep raw */ }
  return `GitLab HTTP ${response.status}: ${redact(String(detail).slice(0, 300), token)}`
}
