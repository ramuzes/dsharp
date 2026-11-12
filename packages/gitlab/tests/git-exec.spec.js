/** Unit tests for the host-side git runner (session-sandbox confinement, auth env, redaction). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAuthHeader, makeGitRunner, parseRemoteUrl, projectHttpUrl,
  resolveRepoPath, spawnCollect,
} from '../lib/git-exec.js'
import { GitlabError } from '../lib/gitlab-api.js'

test('parseRemoteUrl understands https and ssh forms', () => {
  assert.deepEqual(parseRemoteUrl('https://gitlab.example.com/group/repo.git'), { path: 'group/repo', https: true })
  assert.deepEqual(parseRemoteUrl('git@gitlab.example.com:group/repo.git'), { path: 'group/repo', https: false })
  assert.deepEqual(parseRemoteUrl('ssh://git@gitlab.example.com/group/repo.git'), { path: 'group/repo', https: false })
  assert.equal(parseRemoteUrl('file:///tmp/x'), null)
})

test('projectHttpUrl, buildAuthHeader, resolveRepoPath', () => {
  assert.equal(projectHttpUrl('https://gitlab.example.com/', 'group/repo'), 'https://gitlab.example.com/group/repo.git')
  assert.equal(buildAuthHeader('tok'), `Authorization: Basic ${Buffer.from('oauth2:tok').toString('base64')}`)
  // repo paths resolve against the SESSION policy's workspace root
  assert.equal(resolveRepoPath('proj', { mode: 'workspace-write', workspaceRoot: '/home/ramuz/ws' }), '/home/ramuz/ws/proj')
  assert.equal(resolveRepoPath('/elsewhere/x', { mode: 'workspace-write', workspaceRoot: '/home/ramuz/ws' }), '/elsewhere/x')
})

function fakeSandboxScript(dir, body) {
  const script = join(dir, 'fake-runner')
  writeFileSync(script, `#!/bin/sh\n${body}\n`)
  chmodSync(script, 0o755)
  return script
}

test('makeGitRunner resolves the session policy per call and confines non-full-access modes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gitlab-'))
  const gitBin = fakeSandboxScript(dir, 'echo "confined: $@"')
  const confined = []
  const policies = []
  const sessionA = { id: 'sess-a' }
  const sandbox = {
    confine: async (argv, policy) => { confined.push({ argv, policy }); return { argv: [gitBin, ...argv], denialSignatures: ['EROFS'] } },
  }
  const sandboxPolicy = {
    resolve: (request) => {
      policies.push(request)
      // workspace-write with the calling session's cwd as root (sandbox-policy semantics)
      return { mode: 'workspace-write', workspaceRoot: '/home/ramuz/ws', sessionId: request?.session?.id }
    },
  }
  const run = makeGitRunner({ sandbox, sandboxPolicy, gitBin: 'git' })
  const exec = { agent: { session: sessionA } }
  const { stdout } = await run(['status'], dir, exec)
  assert.ok(stdout.includes('confined: git status'), stdout)
  assert.equal(confined.length, 1)
  assert.deepEqual(confined[0].argv, ['git', 'status'])
  assert.equal(confined[0].policy.mode, 'workspace-write')
  assert.deepEqual(policies, [{ session: sessionA }], 'policy resolves against the calling session')
})

test('makeGitRunner spawns directly under danger-full-access and injects the token via env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gitlab-'))
  // echo the config env git reads, so the test proves the token rides env, not argv
  const gitBin = fakeSandboxScript(dir, 'echo "argv=$1" ; echo "env=$GIT_CONFIG_COUNT|$GIT_CONFIG_KEY_0=$GIT_CONFIG_VALUE_0"')
  const sandbox = { confine: async () => { throw new Error('must not confine full access') } }
  const sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/home/ramuz/ws' }) }
  const run = makeGitRunner({ sandbox, sandboxPolicy, gitBin })
  const { stdout } = await run(['fetch'], dir, undefined, { token: 'glpat-x' })
  assert.ok(stdout.includes('argv=fetch'))
  // The header's base64 IS the token in encoded form, so redaction turns it
  // into *** — the env echo proves injection happened without ever echoing it.
  assert.ok(stdout.includes('env=1|http.extraHeader=Authorization: Basic ***'), stdout)
  assert.ok(!stdout.includes('glpat-x'))
  const b64 = Buffer.from('oauth2:glpat-x').toString('base64')
  assert.ok(!stdout.includes(b64))
})

test('makeGitRunner fails closed without the sandbox services in confined modes', async () => {
  const sandboxPolicy = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/ws' }) }
  const run = makeGitRunner({ sandboxPolicy, gitBin: 'git' })
  await assert.rejects(run(['status'], '/ws/p'), (e) => {
    assert.equal(e.code, 'gitlab/git-failed')
    assert.ok(e.message.includes('refuse to run git unconfined'))
    return true
  })
  const noPolicy = makeGitRunner({ sandbox: undefined, sandboxPolicy: undefined, gitBin: 'git' })
  await assert.rejects(noPolicy(['status'], '/ws/p'), (e) => e.message.includes('sandboxPolicy service is unavailable'))
})

test('spawnCollect maps a sandbox denial to the session-policy explanation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gitlab-'))
  const gitBin = fakeSandboxScript(dir, 'echo "open: Operation not permitted: EROFS on write" >&2\nexit 1')
  await assert.rejects(
    spawnCollect([gitBin, 'status'], { cwd: dir, timeoutMs: 5000, denialSignatures: ['EROFS'] }),
    (e) => {
      assert.ok(e instanceof GitlabError)
      assert.equal(e.code, 'gitlab/git-failed')
      assert.ok(e.message.includes("session's sandbox policy"), e.message)
      return true
    })
})

test('spawnCollect redacts the token from captured output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gitlab-'))
  const gitBin = fakeSandboxScript(dir, 'echo "token glpat-oups ${0}" >&2\necho ok')
  const { stdout, stderr } = await spawnCollect([gitBin, 'fetch'], { cwd: dir, token: 'glpat-oups', timeoutMs: 5000 })
  assert.equal(stdout.trim(), 'ok')
  assert.ok(stderr.includes('***'))
  assert.ok(!stderr.includes('glpat-oups'))
})

test('spawnCollect maps nonzero exit to gitlab/git-failed with last stderr lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gitlab-'))
  const gitBin = fakeSandboxScript(dir, 'echo "line1" >&2\necho "fatal: bad" >&2\nexit 128')
  await assert.rejects(spawnCollect([gitBin, 'push'], { cwd: dir, timeoutMs: 5000 }), (e) => {
    assert.equal(e.code, 'gitlab/git-failed')
    assert.ok(e.message.includes('fatal: bad'))
    assert.ok(e.message.includes('exited 128'))
    return true
  })
})
