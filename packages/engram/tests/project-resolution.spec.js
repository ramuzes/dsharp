/**
 * Project resolution tests (Task 4).
 *
 * Fakes mirror the real engram 3.7.2 probe shapes exactly:
 *   normal    -> 200 { project, project_source, project_path, cwd }
 *   ambiguous -> 200 { project: null, project_source: 'ambiguous', available_projects }
 *   unsafe    -> 409 body with explicit_project_required semantics, surfaced by
 *                the real client as EngramError('engram/http', ..., { status: 409, info })
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createProjectResolver,
  ProjectAmbiguousError,
  ProjectExplicitRequiredError,
} from '../lib/project-resolution.js'
import { EngramError } from '../lib/engram-api.js'

/** Minimal session shape matching what the host hands to event handlers. */
function fakeSession(id, cwd) {
  return { id, getWorkingDir: () => cwd }
}

/**
 * Fake client counting probe calls. `probe` maps the cwd query value to a
 * response body; `failWith` makes the probe throw instead (mirrors how the
 * real client surfaces a 409 as a typed EngramError).
 */
function fakeClient({ probe = {}, failWith = null } = {}) {
  const calls = []
  return {
    calls,
    async get(path, query) {
      assert.equal(path, '/project/current')
      const cwd = query.cwd
      calls.push(cwd)
      if (failWith) throw failWith
      return probe[cwd]
    },
  }
}

test('probe resolves normal git-backed project', async () => {
  const client = fakeClient({
    probe: {
      '/w/x': { project: 'myrepo', project_source: 'git', project_path: '/w/x', cwd: '/w/x' },
    },
  })
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'auto',
    getFixedProject: () => '',
    getProjectMap: () => ({}),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  const result = await resolve(fakeSession('s1', '/w/x'))
  assert.deepEqual(result, { project: 'myrepo', source: 'git' })
})

test('ambiguous probe raises ProjectAmbiguousError with available list', async () => {
  const client = fakeClient({
    probe: {
      '/w/x': { project: null, project_source: 'ambiguous', available_projects: ['repoA', 'repoB'] },
    },
  })
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'auto',
    getFixedProject: () => '',
    getProjectMap: () => ({}),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  await assert.rejects(
    resolve(fakeSession('s1', '/w/x')),
    (err) => {
      assert.ok(err instanceof ProjectAmbiguousError)
      assert.deepEqual(err.available, ['repoA', 'repoB'])
      return true
    },
  )
})

test('409 explicit_project_required raises ProjectExplicitRequiredError', async () => {
  const client = fakeClient({
    failWith: new EngramError('engram/http', 'engram/http: GET /project/current -> 409', {
      status: 409,
      info: { error: 'explicit_project_required' },
    }),
  })
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'auto',
    getFixedProject: () => '',
    getProjectMap: () => ({}),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  await assert.rejects(
    resolve(fakeSession('s1', '/w/x')),
    (err) => {
      assert.ok(err instanceof ProjectExplicitRequiredError)
      return true
    },
  )
})

test('longest prefix in project map wins over shorter', async () => {
  const client = fakeClient() // must never probe
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'auto',
    getFixedProject: () => '',
    getProjectMap: () => ({ '/w': 'short', '/w/x/sub': 'longer' }),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  const result = await resolve(fakeSession('s1', '/w/x/sub/deep'))
  assert.deepEqual(result, { project: 'longer', source: 'map' })
  assert.equal(client.calls.length, 0)
})

test('explicit argument beats fixed mode and map and probe', async () => {
  const client = fakeClient() // must never probe
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'fixed',
    getFixedProject: () => 'fixedproj',
    getProjectMap: () => ({ '/w': 'mapped' }),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  const result = await resolve(fakeSession('s1', '/w'), 'explicitproj')
  assert.deepEqual(result, { project: 'explicitproj', source: 'explicit' })
  assert.equal(client.calls.length, 0)
})

test('fixed mode with empty value is a misconfiguration error', async () => {
  const client = fakeClient()
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'fixed',
    getFixedProject: () => '   ',
    getProjectMap: () => ({}),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  await assert.rejects(
    resolve(fakeSession('s1', '/w/x')),
    (err) => {
      assert.ok(err instanceof EngramError)
      assert.equal(err.code, 'engram/project-misconfigured')
      return true
    },
  )
})

test('cache hit does not re-probe for same session and cwd', async () => {
  const client = fakeClient({
    probe: {
      '/w/x': { project: 'myrepo', project_source: 'git', project_path: '/w/x', cwd: '/w/x' },
    },
  })
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'auto',
    getFixedProject: () => '',
    getProjectMap: () => ({}),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  const session = fakeSession('s1', '/w/x')
  const first = await resolve(session)
  const second = await resolve(session)
  assert.deepEqual(first, second)
  assert.equal(client.calls.length, 1)
})

test('a new cwd triggers a fresh probe', async () => {
  const client = fakeClient({
    probe: {
      '/w/x': { project: 'xrepo', project_source: 'git', project_path: '/w/x', cwd: '/w/x' },
      '/w/y': { project: 'yrepo', project_source: 'git', project_path: '/w/y', cwd: '/w/y' },
    },
  })
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'auto',
    getFixedProject: () => '',
    getProjectMap: () => ({}),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  const session = fakeSession('s1', '/w/x')
  await resolve(session)
  session.getWorkingDir = () => '/w/y'
  const result = await resolve(session)
  assert.deepEqual(result, { project: 'yrepo', source: 'git' })
  assert.deepEqual(client.calls, ['/w/x', '/w/y'])
})

test('map key matches child paths but not sibling directories', async () => {
  const client = fakeClient({
    probe: {
      '/w/x2': { project: 'probe-fallback', project_source: 'git', project_path: '/w/x2', cwd: '/w/x2' },
    },
  })
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'auto',
    getFixedProject: () => '',
    getProjectMap: () => ({ '/w/x': 'mapped' }),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  // Sibling directory /w/x2 must NOT match key /w/x -> falls through to probe.
  assert.deepEqual(await resolve(fakeSession('s1', '/w/x2')), { project: 'probe-fallback', source: 'git' })
  assert.deepEqual(client.calls, ['/w/x2'])
  // Exact key and child path must match.
  assert.deepEqual(await resolve(fakeSession('s2', '/w/x')), { project: 'mapped', source: 'map' })
  assert.deepEqual(await resolve(fakeSession('s3', '/w/x/sub')), { project: 'mapped', source: 'map' })
  assert.deepEqual(client.calls, ['/w/x2']) // no further probes
})

test('200 with null project but non-ambiguous source falls through to bad-response', async () => {
  const client = fakeClient({
    probe: {
      '/w/x': { project: null, project_source: 'unclassified', available_projects: [] },
    },
  })
  const { resolve } = createProjectResolver({
    client,
    getMode: () => 'auto',
    getFixedProject: () => '',
    getProjectMap: () => ({}),
    getWorkingDir: (s) => s.getWorkingDir(),
  })
  await assert.rejects(
    resolve(fakeSession('s1', '/w/x')),
    (err) => {
      assert.ok(err instanceof EngramError)
      assert.equal(err.code, 'engram/bad-response')
      assert.ok(!(err instanceof ProjectAmbiguousError))
      return true
    },
  )
})
