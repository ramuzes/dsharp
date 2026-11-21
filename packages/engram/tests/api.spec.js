// Tests for the engram HTTP client. The fetchImpl fake mirrors the live
// engram 3.7.2 contract shapes exactly (AGENTS.md: fakes must replicate real
// strictness — status codes, JSON bodies, error field names) so a green suite
// means the parser matches what the daemon actually sends.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EngramError,
  createEngramClient,
  probeHealth,
  isSupportedVersion,
} from '../lib/engram-api.js'

/** Build a strict fake fetch with per-call recording. */
function makeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(url, init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const okJson = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const baseDeps = {
  baseUrlProvider: () => 'http://127.0.0.1:7437',
  tokenProvider: () => 'secret-token',
  timeoutMsProvider: () => 5000,
}

test('get serializes query and sends Bearer token', async () => {
  const fetchImpl = makeFetch(() => okJson({ items: [] }))
  const client = createEngramClient({ ...baseDeps, fetchImpl })
  const res = await client.get('/search', { q: 'x', project: 'p', all_projects: true })
  assert.deepEqual(res, { items: [] })
  const { url, init } = fetchImpl.calls[0]
  assert.equal(url, 'http://127.0.0.1:7437/search?q=x&project=p&all_projects=true')
  assert.equal(init.headers.Authorization, 'Bearer secret-token')
  assert.equal(init.method, 'GET')
})

test('Authorization header omitted when token is empty', async () => {
  const fetchImpl = makeFetch(() => okJson({ ok: true }))
  const client = createEngramClient({ ...baseDeps, tokenProvider: () => '', fetchImpl })
  await client.get('/health')
  assert.ok(!('Authorization' in fetchImpl.calls[0].init.headers))
})

test('post sends JSON body and parses JSON response', async () => {
  const fetchImpl = makeFetch(() => okJson({ id: 'o1' }))
  const client = createEngramClient({ ...baseDeps, fetchImpl })
  const res = await client.post('/observations', { session_id: 's', content: 'c' })
  assert.deepEqual(res, { id: 'o1' })
  const { init } = fetchImpl.calls[0]
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.equal(init.body, JSON.stringify({ session_id: 's', content: 'c' }))
})

test('del issues DELETE request', async () => {
  const fetchImpl = makeFetch(() => okJson({ deleted: true }))
  const client = createEngramClient({ ...baseDeps, fetchImpl })
  await client.del('/observations', { id: 'o1' })
  const { url, init } = fetchImpl.calls[0]
  assert.equal(init.method, 'DELETE')
  assert.ok(url.includes('id=o1'))
})

test('non-2xx maps to engram/http with status and parsed info', async () => {
  const fetchImpl = makeFetch(() =>
    okJson({ error: 'session_id and content are required' }, 400))
  const client = createEngramClient({ ...baseDeps, fetchImpl })
  await assert.rejects(
    client.post('/observations', {}),
    (err) => {
      assert.ok(err instanceof EngramError)
      assert.equal(err.code, 'engram/http')
      assert.equal(err.status, 400)
      assert.equal(err.info.error, 'session_id and content are required')
      assert.ok(err.message.includes('engram/http'))
      assert.ok(err.message.includes('session_id and content are required'))
      return true
    },
  )
})

test('non-JSON 2xx body maps to engram/bad-response', async () => {
  const fetchImpl = makeFetch(() =>
    new Response('<html>gateway</html>', { status: 200 }))
  const client = createEngramClient({ ...baseDeps, fetchImpl })
  await assert.rejects(
    client.get('/health'),
    (err) => {
      assert.ok(err instanceof EngramError)
      assert.equal(err.code, 'engram/bad-response')
      return true
    },
  )
})

test('network failure maps to engram/unreachable', async () => {
  const fetchImpl = makeFetch(() => {
    throw new TypeError('fetch failed')
  })
  const client = createEngramClient({ ...baseDeps, fetchImpl })
  await assert.rejects(
    client.get('/health'),
    (err) => {
      assert.ok(err instanceof EngramError)
      assert.equal(err.code, 'engram/unreachable')
      return true
    },
  )
})

test('external signal abort maps to engram/unreachable, not a hang', async () => {
  const controller = new AbortController()
  const fetchImpl = makeFetch((_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(Object.assign(new TypeError('fetch failed'), { name: 'AbortError' })))
    }))
  const client = createEngramClient({ ...baseDeps, fetchImpl })
  await assert.rejects(
    client.get('/health', undefined, controller.signal),
    (err) => err instanceof EngramError && err.code === 'engram/unreachable',
  )
})

test('timeout abort maps to engram/unreachable', async () => {
  const fetchImpl = makeFetch((_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(Object.assign(new TypeError('fetch failed'), { name: 'AbortError' })))
    }))
  const client = createEngramClient({
    ...baseDeps,
    timeoutMsProvider: () => 10,
    fetchImpl,
  })
  await assert.rejects(
    client.get('/health'),
    (err) => err instanceof EngramError && err.code === 'engram/unreachable',
  )
})

test('probeHealth returns version and capabilities', async () => {
  const fetchImpl = makeFetch(() => okJson({
    status: 'ok',
    service: 'engram',
    version: '3.7.2',
    instance_id: 'abc',
    capabilities: { observations: true },
  }))
  const client = createEngramClient({ ...baseDeps, fetchImpl })
  const health = await probeHealth(client)
  assert.equal(health.version, '3.7.2')
  assert.deepEqual(health.capabilities, { observations: true })
  assert.ok(fetchImpl.calls[0].url.endsWith('/health'))
})

test('isSupportedVersion accepts 3.7+ and rejects older/other', () => {
  assert.equal(isSupportedVersion('3.7.2'), true)
  assert.equal(isSupportedVersion('3.8.0'), true)
  assert.equal(isSupportedVersion('4.0.0'), true)
  assert.equal(isSupportedVersion('3.6.9'), false)
  assert.equal(isSupportedVersion('2.9.9'), false)
  assert.equal(isSupportedVersion('garbage'), false)
  assert.equal(isSupportedVersion(undefined), false)
})

test('malformed baseUrl surfaces as EngramError engram/unreachable, not a raw TypeError', async () => {
  const client = createEngramClient({
    baseUrlProvider: () => 'not a url at all',
    tokenProvider: () => '',
    timeoutMsProvider: () => 1000,
    fetchImpl: async () => { throw new Error('fetch must never run for a malformed base URL') },
  })
  await assert.rejects(
    client.get('/health'),
    (err) => err instanceof EngramError && err.code === 'engram/unreachable',
  )
})
