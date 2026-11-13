/** Unit tests for the GitLab REST client (strict fetch fake). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGitlabClient, GitlabError, projectIdSegment, redact } from '../lib/gitlab-api.js'

/** Fake fetch capturing the request and answering a canned response. */
function fakeFetch(capture, response) {
  return async (url, init) => {
    capture.url = String(url)
    capture.init = init
    if (typeof response === 'function') return response(url, init)
    return response
  }
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })

test('projectIdSegment encodes namespace paths once', () => {
  assert.equal(projectIdSegment('group/sub/repo'), 'group%2Fsub%2Frepo')
  assert.equal(projectIdSegment(42), '42')
})

test('redact removes the raw token and its base64 form', () => {
  assert.equal(redact(`boom glpat-abc123 ${Buffer.from('glpat-abc123').toString('base64')}`, 'glpat-abc123'),
    'boom *** ***')
  assert.equal(redact(undefined, 'x'), '')
})

test('client sends PRIVATE-TOKEN header and builds query', async () => {
  const cap = {}
  const client = createGitlabClient({
    baseUrl: 'https://gitlab.example.com/',
    tokenProvider: () => 'glpat-xyz',
    fetchImpl: fakeFetch(cap, okJson([])),
  })
  await client.get('/projects/group%2Frepo/pipelines', { ref: 'main', status: undefined, page: 2 })
  assert.equal(cap.url, 'https://gitlab.example.com/api/v4/projects/group%2Frepo/pipelines?ref=main&page=2')
  assert.equal(cap.init.headers['private-token'], 'glpat-xyz')
  assert.equal(cap.init.method, 'GET')
})

test('client posts JSON with content-type', async () => {
  const cap = {}
  const client = createGitlabClient({ baseUrl: 'https://gl.example', tokenProvider: () => 't', fetchImpl: fakeFetch(cap, okJson({ iid: 3 })) })
  const out = await client.post('/projects/1/merge_requests', { title: 'x' })
  assert.deepEqual(out, { iid: 3 })
  assert.equal(cap.init.headers['content-type'], 'application/json')
  assert.equal(cap.init.body, JSON.stringify({ title: 'x' }))
})

test('api error maps to GitlabError with status and redacted detail', async () => {
  const cap = {}
  const client = createGitlabClient({ baseUrl: 'https://gl.example', tokenProvider: () => 'glpat-secret', fetchImpl: fakeFetch(cap, {
    ok: false, status: 400, json: async () => ({ message: 'bad request glpat-secret' }), text: async () => JSON.stringify({ message: 'bad request glpat-secret' }),
  }) })
  await assert.rejects(client.post('/projects/1/pipeline', { ref: 'x' }), (e) => {
    assert.ok(e instanceof GitlabError)
    assert.equal(e.code, 'gitlab/api-error')
    assert.equal(e.status, 400)
    assert.ok(!e.message.includes('glpat-secret'), 'token must be redacted from the error text')
    assert.ok(e.message.includes('***'))
    return true
  })
})

test('network failure maps to gitlab/unreachable', async () => {
  const client = createGitlabClient({ baseUrl: 'https://gl.example', tokenProvider: () => 't', fetchImpl: async () => { throw new TypeError('fetch failed') } })
  await assert.rejects(client.get('/projects'), (e) => e.code === 'gitlab/unreachable')
})

test('non-JSON body maps to gitlab/bad-response', async () => {
  const client = createGitlabClient({ baseUrl: 'https://gl.example', tokenProvider: () => 't', fetchImpl: fakeFetch({}, { ok: true, status: 200, json: async () => { throw new Error('nope') }, text: async () => '<html>' }) })
  await assert.rejects(client.get('/projects'), (e) => e.code === 'gitlab/bad-response')
})

test('empty baseUrl fails fast with gitlab/not-configured', async () => {
  const client = createGitlabClient({ baseUrl: '', tokenProvider: () => 't', fetchImpl: fakeFetch({}, okJson({})) })
  await assert.rejects(client.get('/projects'), (e) => e.code === 'gitlab/not-configured')
})

test('text mode returns raw redacted text (job trace)', async () => {
  const cap = {}
  const client = createGitlabClient({ baseUrl: 'https://gl.example', tokenProvider: () => 'glpat-t', fetchImpl: fakeFetch(cap, { ok: true, status: 200, text: async () => `step failed glpat-t` }) })
  const trace = await client.get('/projects/1/jobs/9/trace', undefined, undefined, { text: true })
  assert.equal(trace, 'step failed ***')
  assert.equal(cap.init.headers.accept, 'text/plain')
})

test('client follows a live baseUrl/timeout change via providers (Plugins-page edit)', async () => {
  let base = 'https://gl-one.example'
  let timeout = 20_000
  const cap = {}
  const client = createGitlabClient({
    baseUrl: base,
    baseUrlProvider: () => base,
    timeoutProvider: () => timeout,
    tokenProvider: () => 't',
    fetchImpl: fakeFetch(cap, okJson([])),
  })
  await client.get('/projects')
  assert.equal(cap.url, 'https://gl-one.example/api/v4/projects')
  base = 'https://gl-two.example/'
  timeout = 5000
  await client.get('/projects')
  assert.equal(cap.url, 'https://gl-two.example/api/v4/projects', 'baseUrl must resolve per request')
  base = ''
  await assert.rejects(client.get('/projects'), (e) => e.code === 'gitlab/not-configured')
})
