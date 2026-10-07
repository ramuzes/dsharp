/**
 * Host-half contract tests: the read-only proxy whitelist, upstream URL
 * construction, and the webServer handler's request/response behavior with a
 * stubbed fetch. The Config schema is smoke-checked for its defaults.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROXY_PREFIX, resolveProxyRequest, buildUpstreamUrl, makeProxyHandler, Config,
} from '../index.js'

/** Encode a string as an ArrayBuffer, the way fetch body types behave. */
function bytes(text) {
  return new TextEncoder().encode(text).buffer
}

/** A minimal ServerResponse double capturing what the handler writes. */
function mockRes() {
  const state = { status: undefined, headers: undefined, body: '', calls: [] }
  return [state, {
    get writableEnded() { return state.calls.includes('end') },
    writeHead(status, headers) { state.status = status; state.headers = headers; state.calls.push('writeHead') },
    end(chunk) { if (chunk !== undefined) state.body += Buffer.from(chunk).toString(); state.calls.push('end') },
  }]
}

/** A fetch double returning a fixed status/body, recording every call. */
function mockFetch({ status = 200, body = '{}', contentType = 'application/json', error } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (error !== undefined) throw error
    return {
      status,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => bytes(body),
    }
  }
  return [calls, impl]
}

/** Run one handler round against the given request. */
async function round(handler, { method = 'GET', url } = {}) {
  const [state, res] = mockRes()
  const req = { method, url }
  await handler(req, res)
  return state
}

test('PROXY_PREFIX is an absolute path without a trailing slash', () => {
  assert.equal(PROXY_PREFIX, '/airboard')
  assert.ok(!PROXY_PREFIX.endsWith('/'))
})

test('resolveProxyRequest allows the read-only GET surface', () => {
  const allowed = [
    '/airboard/api/health',
    '/airboard/api/agents/instructions',
    '/airboard/api/projects',
    '/airboard/api/projects/CORE',
    '/airboard/api/projects/CORE/resources',
    '/airboard/api/projects/CORE/resources/ADR-1',
    '/airboard/api/projects/CORE/resources/ADR-1/revisions',
    '/airboard/api/projects/CORE/resources/ADR-1/revisions/3',
    '/airboard/api/search',
  ]
  for (const url of allowed) {
    assert.deepEqual(resolveProxyRequest('GET', url), {
      subpath: url.slice(PROXY_PREFIX.length),
      query: '',
    }, url)
  }
})

test('resolveProxyRequest keeps the query string and decodes nothing', () => {
  assert.deepEqual(
    resolveProxyRequest('GET', '/airboard/api/search?q=%E9%BE%99&kind=ADR&fields=slim'),
    { subpath: '/api/search', query: '?q=%E9%BE%99&kind=ADR&fields=slim' },
  )
})

test('resolveProxyRequest rejects writes, foreign paths, and extra segments', () => {
  const rejected = [
    ['POST', '/airboard/api/projects/CORE/resources'],
    ['PATCH', '/airboard/api/projects/CORE/resources/ADR-1'],
    ['DELETE', '/airboard/api/projects/CORE/resources/ADR-1'],
    ['GET', '/airboard/api/users'],
    ['GET', '/airboard/api/me/tokens'],
    ['GET', '/airboard/api/plugins'],
    ['GET', '/airboard/api/projects/CORE/resources/ADR-1/bindings'],
    ['GET', '/airboard/api/projects/A/B'],
    ['GET', '/airboard/api/projects/CORE/resources/ADR-1/nope'],
    ['GET', '/airboard'],
    ['GET', '/airboard/'],
    ['GET', '/airboard/api'],
    // Dot segments normalize before matching: this one becomes /secret and
    // no longer carries the proxy prefix.
    ['GET', '/airboard/../secret'],
    // A foreign prefix must never be proxied.
    ['GET', '/other/api/projects'],
  ]
  for (const [method, url] of rejected) {
    assert.equal(resolveProxyRequest(method, url), null, `${method} ${url}`)
  }
})

test('buildUpstreamUrl joins base, subpath, and query without double slashes', () => {
  assert.equal(
    buildUpstreamUrl('http://ab.antaresy.cc', '/api/projects', ''),
    'http://ab.antaresy.cc/api/projects',
  )
  assert.equal(
    buildUpstreamUrl('http://ab.antaresy.cc/', '/api/projects', '?kind=ADR'),
    'http://ab.antaresy.cc/api/projects?kind=ADR',
  )
  assert.equal(
    buildUpstreamUrl('http://host:3010/', '/api/projects/CORE/resources', ''),
    'http://host:3010/api/projects/CORE/resources',
  )
})

test('makeProxyHandler relays an upstream response with the secret token attached', async () => {
  const [calls, impl] = mockFetch({ status: 200, body: '[{"key":"CORE"}]' })
  const handler = makeProxyHandler(
    { baseUrl: { get: () => 'http://ab.antaresy.cc' }, token: { get: () => 'abt_secret' } },
    { fetchImpl: impl },
  )
  const state = await round(handler, { url: '/airboard/api/projects' })
  assert.equal(state.status, 200)
  assert.match(state.headers['content-type'], /application\/json/)
  assert.equal(state.headers['cache-control'], 'no-store')
  assert.equal(state.body, '[{"key":"CORE"}]')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://ab.antaresy.cc/api/projects')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.authorization, 'Bearer abt_secret')
  assert.equal(calls[0].init.redirect, 'manual')
})

test('makeProxyHandler works unauthenticated for public endpoints', async () => {
  const [calls, impl] = mockFetch({ status: 200, body: '{"status":"ok"}' })
  const handler = makeProxyHandler(
    { baseUrl: 'http://ab.antaresy.cc', token: '' },
    { fetchImpl: impl },
  )
  const state = await round(handler, { url: '/airboard/api/health' })
  assert.equal(state.status, 200)
  assert.equal(calls[0].init.headers.authorization, undefined)
  assert.equal(state.body, '{"status":"ok"}')
})

test('makeProxyHandler answers 404 for disallowed or non-GET requests without fetching', async () => {
  const [calls, impl] = mockFetch()
  const handler = makeProxyHandler({ baseUrl: 'http://ab.antaresy.cc', token: 't' }, { fetchImpl: impl })
  for (const [method, url] of [['POST', '/airboard/api/projects'], ['GET', '/airboard/api/users']]) {
    const state = await round(handler, { method, url })
    assert.equal(state.status, 404)
    assert.match(state.body, /NOT_ALLOWED/)
  }
  assert.equal(calls.length, 0)
})

test('makeProxyHandler relays upstream error envelopes verbatim', async () => {
  const [, impl] = mockFetch({
    status: 401,
    body: '{"error":{"code":"UNAUTHORIZED","message":"missing or invalid bearer token"}}',
  })
  const handler = makeProxyHandler({ baseUrl: 'http://ab.antaresy.cc', token: '' }, { fetchImpl: impl })
  const state = await round(handler, { url: '/airboard/api/projects' })
  assert.equal(state.status, 401)
  assert.match(state.body, /UNAUTHORIZED/)
})

test('makeProxyHandler maps upstream failures to 502 AIRBOARD_UNREACHABLE', async () => {
  const handler = makeProxyHandler(
    { baseUrl: 'http://ab.antaresy.cc', token: '' },
    { fetchImpl: async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }) } },
  )
  const state = await round(handler, { url: '/airboard/api/projects' })
  assert.equal(state.status, 502)
  assert.match(state.body, /AIRBOARD_UNREACHABLE/)
  assert.match(state.body, /ECONNREFUSED/)
})

test('makeProxyHandler reports an unusable baseUrl as 503 NOT_CONFIGURED', async () => {
  const [calls, impl] = mockFetch()
  const handler = makeProxyHandler({ baseUrl: '', token: '' }, { fetchImpl: impl })
  const state = await round(handler, { url: '/airboard/api/projects' })
  assert.equal(state.status, 503)
  assert.match(state.body, /AIRBOARD_BASE_URL/)
  assert.equal(calls.length, 0)
})

test('makeProxyHandler reads volatile config values per request', async () => {
  let current = 'abt_first'
  const handler = makeProxyHandler(
    { baseUrl: { get: () => 'http://ab.antaresy.cc' }, token: { get: () => current } },
    {
      fetchImpl: async (url, init) => {
        seen.push(init.headers.authorization)
        return { status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => bytes('{}') }
      },
    },
  )
  const seen = []
  await round(handler, { url: '/airboard/api/projects' })
  current = 'abt_second'
  await round(handler, { url: '/airboard/api/projects' })
  assert.deepEqual(seen, ['Bearer abt_first', 'Bearer abt_second'])
})

test('Config declares the documented defaults', () => {
  assert.ok(Config, 'Config is exported')
  const json = JSON.stringify(Config)
  assert.match(json, /baseUrl/)
  assert.match(json, /token/)
  assert.match(json, /http:\/\/ab\.antaresy\.cc/)
  // The schema document carries the secret role on the token field.
  assert.match(json, /secret/)
})
