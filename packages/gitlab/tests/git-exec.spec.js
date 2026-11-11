/** Unit tests for the host-side git runner (path guard, auth, redaction). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAuthHeader, parseRemoteUrl, projectHttpUrl,
  resolveInsideRoots, runGit,
} from '../lib/git-exec.js'
import { GitlabError } from '../lib/gitlab-api.js'

test('resolveInsideRoots accepts inside and equal, rejects escape', () => {
  const roots = ['/home/ramuz/ws']
  assert.equal(resolveInsideRoots('/home/ramuz/ws/repo', roots), '/home/ramuz/ws/repo')
  assert.equal(resolveInsideRoots('/home/ramuz/ws', roots), '/home/ramuz/ws')
  assert.equal(resolveInsideRoots(join('/home/ramuz/ws', 'sub/../repo'), roots), '/home/ramuz/ws/repo')
  assert.throws(() => resolveInsideRoots('/home/ramuz/ws-evil', roots), (e) => e.code === 'gitlab/path-outside-workspace')
  assert.throws(() => resolveInsideRoots('/etc', roots), (e) => e.code === 'gitlab/path-outside-workspace')
  assert.throws(() => resolveInsideRoots(join('/home/ramuz/ws', '..', 'secret'), roots), (e) => e.code === 'gitlab/path-outside-workspace')
  assert.throws(() => resolveInsideRoots('/any', []), (e) => e.code === 'gitlab/path-outside-workspace')
})

test('parseRemoteUrl understands https and ssh forms', () => {
  assert.deepEqual(parseRemoteUrl('https://gitlab.example.com/group/repo.git'), { path: 'group/repo', https: true })
  assert.deepEqual(parseRemoteUrl('git@gitlab.example.com:group/repo.git'), { path: 'group/repo', https: false })
  assert.deepEqual(parseRemoteUrl('ssh://git@gitlab.example.com/group/repo.git'), { path: 'group/repo', https: false })
  assert.equal(parseRemoteUrl('file:///tmp/x'), null)
})

test('projectHttpUrl and buildAuthHeader', () => {
  assert.equal(projectHttpUrl('https://gitlab.example.com/', 'group/repo'), 'https://gitlab.example.com/group/repo.git')
  assert.equal(buildAuthHeader('tok'), `Authorization: Basic ${Buffer.from('oauth2:tok').toString('base64')}`)
})

test('runGit injects the auth extraHeader and redacts token from output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gitlab-'))
  const script = join(dir, 'fake-git')
  writeFileSync(script, '#!/bin/sh\necho "argv: $@"\necho "token glpat-oups ${0}" >&2\nexit 0\n')
  chmodSync(script, 0o755)
  const { stdout, stderr } = await runGit(['fetch', 'origin'], { cwd: dir, token: 'glpat-oups', gitBin: script, timeoutMs: 5000 })
  const b64 = Buffer.from('oauth2:glpat-oups').toString('base64')
  // the extraHeader argv itself is redacted: the base64 never survives
  assert.ok(stdout.includes('argv: -c http.extraHeader=Authorization: Basic *** fetch origin'), stdout)
  assert.ok(!stdout.includes('glpat-oups') && !stdout.includes(b64))
  assert.ok(stderr.includes('***'))
  assert.ok(!stderr.includes('glpat-oups'))
})

test('runGit maps nonzero exit to gitlab/git-failed with last stderr lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gitlab-'))
  const script = join(dir, 'fake-git')
  writeFileSync(script, '#!/bin/sh\necho "line1" >&2\necho "fatal: bad" >&2\nexit 128\n')
  chmodSync(script, 0o755)
  await assert.rejects(runGit(['push'], { cwd: dir, gitBin: script, timeoutMs: 5000 }), (e) => {
    assert.ok(e instanceof GitlabError)
    assert.equal(e.code, 'gitlab/git-failed')
    assert.ok(e.message.includes('fatal: bad'))
    assert.ok(e.message.includes('exited 128'))
    return true
  })
})
