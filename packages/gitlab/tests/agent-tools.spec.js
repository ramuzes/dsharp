/**
 * Unit tests for the agent tool set (strict fakes: inject-scoped ctx,
 * fake API client, fake git runner). Covers registration shape, the
 * merged-only branch deletion contract, workspace path guard, and the
 * apply() mount stages with reactive config wrappers.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentTools } from '../lib/agent-tools.js'
import { apply } from '../index.js'
import { makeGitRunner, spawnCollect } from '../lib/git-exec.js'

/** Strict fake context: ONLY the injected services exist (cordis rule). */
function makeCtx() {
  const registered = []
  const sections = []
  return {
    registered, sections,
    ctx: {
      tools: { register: (tool) => { registered.push(tool); return () => { registered.splice(registered.indexOf(tool), 1) } } },
      systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    },
  }
}

/** Fake API client capturing calls. */
function makeApi(routes = {}) {
  const calls = []
  return {
    calls,
    get: async (path, query, _signal, opts = {}) => { calls.push(['GET', path, query]); return routes.get?.(path, query, opts) ?? {} },
    post: async (path, body) => { calls.push(['POST', path, body]); return routes.post?.(path, body) ?? {} },
    put: async (path, body) => { calls.push(['PUT', path, body]); return routes.put?.(path, body) ?? {} },
    del: async (path, body) => { calls.push(['DELETE', path, body]); return routes.del?.(path, body) ?? {} },
  }
}

const ROOT = '/home/ramuz/ws'
const SESSION_POLICY = { mode: 'workspace-write', workspaceRoot: ROOT }
const defaultDeps = (api, gitRun) => ({
  api,
  getBaseUrl: () => 'https://gitlab.example.com',
  getToken: () => 'glpat-test',
  getPolicy: () => SESSION_POLICY,
  gitTimeoutMs: () => 5000,
  gitRun: gitRun ?? (async () => ({ stdout: '', stderr: '' })),
})

const byName = (registered, name) => registered.find((t) => t.name === name)

test('registers the full explicitly named tool set + prompt section', () => {
  const { ctx, registered, sections } = makeCtx()
  const off = registerAgentTools(ctx, defaultDeps(makeApi()))
  assert.ok(registered.length >= 36, `expected the full set, got ${registered.length}`)
  const names = new Set(registered.map((t) => t.name))
  for (const expected of [
    'gitlab_repo_info', 'gitlab_git_clone', 'gitlab_git_fetch', 'gitlab_git_push', 'gitlab_git_pull',
    'gitlab_git_status', 'gitlab_git_log', 'gitlab_git_checkout', 'gitlab_git_branch',
    'gitlab_git_rebase', 'gitlab_git_cherry_pick', 'gitlab_git_merge', 'gitlab_git_tag',
    'gitlab_stale_branches', 'gitlab_delete_branch',
    'gitlab_pipeline_trigger', 'gitlab_pipeline_list', 'gitlab_pipeline_get',
    'gitlab_pipeline_cancel', 'gitlab_pipeline_retry', 'gitlab_job_get',
    'gitlab_schedule_list', 'gitlab_schedule_create', 'gitlab_schedule_update',
    'gitlab_mr_create', 'gitlab_mr_list', 'gitlab_mr_get', 'gitlab_mr_update',
    'gitlab_mr_comment', 'gitlab_mr_reviews',
    'gitlab_issue_create', 'gitlab_issue_list', 'gitlab_issue_get', 'gitlab_issue_update',
    'gitlab_milestone_list', 'gitlab_milestone_create',
    'gitlab_release_create', 'gitlab_release_list',
  ]) {
    assert.ok(names.has(expected), `missing tool ${expected}`)
  }
  for (const tool of registered) {
    assert.ok(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name} needs a real description`)
  }
  assert.equal(sections.length, 1)
  assert.equal(sections[0].order, 2360)
  off()
  assert.equal(registered.length, 0, 'disposer must unregister everything')
})

test('gitlab_repo_info encodes the project path once', async () => {
  const { ctx, registered } = makeCtx()
  const api = makeApi({ get: (p) => (p === '/projects/group%2Frepo' ? { id: 1, path_with_namespace: 'group/repo', default_branch: 'main' } : null) })
  registerAgentTools(ctx, defaultDeps(api))
  const out = await byName(registered, 'gitlab_repo_info').execute({ project: 'group/repo' })
  const parsed = JSON.parse(out)
  assert.equal(parsed.path, 'group/repo')
  assert.equal(parsed.default_branch, 'main')
})

test('gitlab_git_status resolves repo paths against the session policy workspace root', async () => {
  const { ctx, registered } = makeCtx()
  const seen = []
  const gitRun = async (args, cwd, exec, opts) => { seen.push({ args, cwd, exec, opts }); return { stdout: '## main', stderr: '' } }
  registerAgentTools(ctx, defaultDeps(makeApi(), gitRun))
  const status = byName(registered, 'gitlab_git_status')
  const ok = await status.execute({ repo: 'proj' }, { agent: { session: { id: 's1' } } })
  assert.equal(ok, '## main')
  assert.deepEqual(seen[0].args, ['status', '--porcelain=v1', '--branch'])
  assert.equal(seen[0].cwd, '/home/ramuz/ws/proj')
  assert.equal(seen[0].exec.agent.session.id, 's1')
})

test('gitlab_git_fetch with a proper https origin uses remote mode and token header', async () => {
  const { ctx, registered } = makeCtx()
  const seen = []
  const gitRun = async (args, cwd, exec, opts) => {
    seen.push({ args, cwd, exec, opts })
    if (args[0] === 'config') return { stdout: 'https://gitlab.example.com/group/repo.git\n', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  registerAgentTools(ctx, defaultDeps(makeApi(), gitRun))
  await byName(registered, 'gitlab_git_fetch').execute({ repo: '/home/ramuz/ws/proj' })
  const fetch = seen.find((s) => s.args[0] === 'fetch')
  assert.ok(fetch, 'fetch must run')
  assert.deepEqual(fetch.args, ['fetch', '--prune', '--tags', 'origin'])
  assert.ok(fetch.opts.token === 'glpat-test')
})

test('gitlab_delete_branch refuses unmerged branches, deletes merged ones', async () => {
  const routes = {
    get: (path) => {
      if (path === '/projects/1') return { id: 1, default_branch: 'main' }
      if (path === '/projects/1/repository/branches/feature%2Fx') return { name: 'feature/x', protected: false, merged: false }
      if (path === '/projects/1/repository/compare') return { commits: [{ id: 'abc' }] } // unmerged
      return null
    },
    del: (path) => { callsDel.push(path); return {} },
  }
  const callsDel = []
  const { ctx, registered } = makeCtx()
  registerAgentTools(ctx, defaultDeps(makeApi(routes)))
  const tool = byName(registered, 'gitlab_delete_branch')

  const refused = await tool.execute({ project: '1', branch: 'feature/x' })
  assert.ok(refused.includes('Refusing to delete'), refused)
  assert.equal(callsDel.length, 0)

  // now merged: compare returns zero commits
  const api2 = makeApi({
    get: (path) => {
      if (path === '/projects/1') return { id: 1, default_branch: 'main' }
      if (path === '/projects/1/repository/branches/feature%2Fx') return { name: 'feature/x', protected: false, merged: false }
      if (path === '/projects/1/repository/compare') return { commits: [] }
      return null
    },
    del: (path) => { callsDel.push(path); return {} },
  })
  const { ctx: ctx2, registered: reg2 } = makeCtx()
  registerAgentTools(ctx2, defaultDeps(api2))
  const done = await byName(reg2, 'gitlab_delete_branch').execute({ project: '1', branch: 'feature/x' })
  assert.ok(done.includes('Deleted remote branch feature/x.'), done)
  assert.deepEqual(callsDel, ['/projects/1/repository/branches/feature%2Fx'])
})

test('gitlab_delete_branch always refuses the default branch', async () => {
  const { ctx, registered } = makeCtx()
  const api = makeApi({ get: (p) => (p === '/projects/1' ? { id: 1, default_branch: 'dev' } : null) })
  registerAgentTools(ctx, defaultDeps(api))
  const out = await byName(registered, 'gitlab_delete_branch').execute({ project: '1', branch: 'dev' })
  assert.ok(out.includes('Refusing to delete the default branch'), out)
})

test('gitlab_git_branch delete uses -d (merged-only), never -D', async () => {
  const { ctx, registered } = makeCtx()
  const seen = []
  registerAgentTools(ctx, defaultDeps(makeApi(), async (args, opts) => { seen.push(args); return { stdout: '', stderr: '' } }))
  await byName(registered, 'gitlab_git_branch').execute({ repo: ROOT, action: 'delete', name: 'old' })
  assert.deepEqual(seen[0], ['branch', '-d', 'old'])
})

test('gitlab_git_push refuses a deleting refspec and api failures surface as text', async () => {
  const { ctx, registered } = makeCtx()
  registerAgentTools(ctx, defaultDeps(makeApi(), async () => ({ stdout: '', stderr: '' })))
  const push = byName(registered, 'gitlab_git_push')
  const refused = await push.execute({ repo: ROOT, from: 'main', to: '' })
  assert.ok(refused.includes('Refusing an empty remote ref'), refused)

  const e = new Error('git push exited 128:\nfatal: Authentication failed'); e.code = 'gitlab/git-failed'
  const { ctx: c2, registered: r2 } = makeCtx()
  registerAgentTools(c2, defaultDeps(makeApi(), async (args) => {
    if (args[0] === 'config') return { stdout: 'https://gitlab.example.com/group/repo.git\n', stderr: '' }
    throw e
  }))
  const out = await byName(r2, 'gitlab_git_push').execute({ repo: ROOT, from: 'main' })
  assert.ok(out.includes('GitLab call failed (gitlab/git-failed)'), out)
})

test('gitlab_stale_branches skips default branch and flags merged MRs', async () => {
  const { ctx, registered } = makeCtx()
  const api = makeApi({
    get: (path, query) => {
      if (path === '/projects/1') return { id: 1, path_with_namespace: 'group/repo', default_branch: 'main' }
      if (path === '/projects/1/repository/branches') {
        return [
          { name: 'main', protected: true },
          { name: 'feat-done', protected: false, merged: false },
          { name: 'feat-wip', protected: false, merged: false },
        ]
      }
      if (path === '/projects/1/merge_requests') return [{ source_branch: 'feat-done' }]
      return null
    },
  })
  registerAgentTools(ctx, defaultDeps(api))
  const out = await byName(registered, 'gitlab_stale_branches').execute({ project: '1' })
  const parsed = JSON.parse(out)
  assert.deepEqual(parsed.stale, [{ branch: 'feat-done', merged_via: 'merged-mr' }])
})

test('apply() mounts tools with reactive config wrappers and writes stages', async () => {
  const statusFile = join(mkdtempSync(join(tmpdir(), 'dsh-gitlab-')), 'status.json')
  process.env.GITLAB_STATUS_FILE = statusFile
  const injects = []
  const fakeCtx = { inject: (list, fn) => { injects.push({ list, fn }) } }
  const reactive = (v) => ({ get: () => v })
  apply(fakeCtx, {
    baseUrl: reactive('https://gitlab.example.com'),
    tokenEnv: reactive('GITLAB_TOKEN'),
    apiTimeoutMs: reactive(5000),
    gitTimeoutMs: reactive(5000),
    workspaceRoots: reactive(['/home/ramuz/ws']),
  })
  assert.equal(injects.length, 1)
  assert.deepEqual(injects[0].list, ['tools', 'systemPrompt', 'credentials', 'sandboxPolicy', 'sandbox'])
  const stage1 = JSON.parse(readFileSync(statusFile, 'utf8'))
  assert.equal(stage1.stage, 'apply')

  const { ctx: agentCtx, registered } = makeCtx()
  const tokenUpdates = []
  agentCtx.credentials = { resolve: async () => ({ value: 'glpat-live' }) }
  agentCtx.on = (name, fn) => { if (name === 'credentials/reference-updated') tokenUpdates.push(fn); return () => {} }
  await injects[0].fn(agentCtx)
  assert.ok(registered.length >= 36)
  const stage2 = JSON.parse(readFileSync(statusFile, 'utf8'))
  assert.equal(stage2.stage, 'tools-registered')
  assert.equal(stage2.detail.tokenConfigured, true)

  // credential refresh flips the token provider
  process.env.GITLAB_TOKEN = 'glpat-rotated'
  await tokenUpdates[0]('GITLAB_TOKEN')
  rmSync(join(statusFile, '..'), { recursive: true, force: true })
  delete process.env.GITLAB_STATUS_FILE
})

test('gitlab_git_push with an ssh origin pushes to the explicit https URL without touching the remote', async () => {
  const { ctx, registered } = makeCtx()
  const seen = []
  registerAgentTools(ctx, defaultDeps(makeApi(), async (args) => {
    if (args[0] === 'config') return { stdout: 'git@gitlab.example.com:group/repo.git\n', stderr: '' }
    seen.push(args)
    return { stdout: '', stderr: '' }
  }))
  const out = await byName(registered, 'gitlab_git_push').execute({ repo: ROOT, from: 'main' })
  assert.ok(out.includes('Pushed main:main.'), out)
  // pushes to the explicit https URL, and never rewrites the remote config
  assert.deepEqual(seen[0], ['push', 'https://gitlab.example.com/group/repo.git', 'main:main'])
  const writes = seen.filter((a) => a[0] === 'remote')
  assert.equal(writes.length, 0, 'must not modify the origin remote')
})

test('gitlab_git_push with an https origin pushes via origin', async () => {
  const { ctx, registered } = makeCtx()
  const seen = []
  registerAgentTools(ctx, defaultDeps(makeApi(), async (args) => {
    if (args[0] === 'config') return { stdout: 'https://gitlab.example.com/group/repo.git\n', stderr: '' }
    seen.push(args)
    return { stdout: '', stderr: '' }
  }))
  await byName(registered, 'gitlab_git_push').execute({ repo: ROOT, from: 'main' })
  assert.deepEqual(seen[0], ['push', 'origin', 'main:main'])
})

test('gitlab_git_clone threads exec through policy resolve and the git runner', async () => {
  const { ctx, registered } = makeCtx()
  const seen = {}
  const api = makeApi({ get: () => ({ id: 7, path_with_namespace: 'grp/repo', http_url_to_repo: 'https://gitlab.example.com/grp/repo.git' }) })
  const gitRun = async (args, cwd, exec) => { seen.git = { args, cwd, exec }; return { stdout: '', stderr: '' } }
  const deps = defaultDeps(api, gitRun)
  deps.getPolicy = (exec) => { seen.policyExec = exec; return SESSION_POLICY }
  registerAgentTools(ctx, deps)
  const exec = { signal: { aborted: false }, agent: { session: { id: 's1' } } }
  const out = await byName(registered, 'gitlab_git_clone').execute({ project: 'grp/repo', dir: 'sub/dir' }, exec)
  assert.match(String(out), /Cloned grp\/repo/)
  // exec reaches BOTH the policy resolve (session-owned workspace root, not
  // the deployment fallback) and the runner (confinement + abort).
  assert.equal(seen.policyExec, exec)
  assert.equal(seen.git.exec, exec)
  assert.equal(seen.git.cwd, `${ROOT}/sub/dir`)
})

// ---- MR create: project defaults + target-branch freshness ------------------

/** Fake git runner backed by a workspace clone with an https origin. */
function makeGit(overrides = {}) {
  const seen = []
  const run = async (args) => {
    seen.push(args)
    if (overrides[args[0]]) return overrides[args[0]](args)
    if (args[0] === 'config') return { stdout: 'https://gitlab.example.com/group/repo.git\n', stderr: '' }
    return { stdout: '0\n', stderr: '' }
  }
  return { seen, run }
}

test('gitlab_mr_create leaves remove_source_branch to the project default unless given', async () => {
  const { ctx, registered } = makeCtx()
  const api = makeApi({ post: () => ({ iid: 4, title: 'T', state: 'opened', web_url: 'u' }) })
  registerAgentTools(ctx, defaultDeps(api, makeGit().run))
  const create = byName(registered, 'gitlab_mr_create')
  const base = { project: 'group/repo', source_branch: 'feature/x', target_branch: 'main', title: 'T' }

  await create.execute({ ...base })
  await create.execute({ ...base, remove_source_branch: true })
  await create.execute({ ...base, remove_source_branch: false })
  const bodies = api.calls.map((c) => c[2])
  assert.equal('remove_source_branch' in bodies[0], false, 'omitted → GitLab applies the project default')
  assert.equal(bodies[1].remove_source_branch, true)
  assert.equal(bodies[2].remove_source_branch, false)
  assert.equal(bodies[0].squash, false, 'squash keeps its explicit default')
})

test('gitlab_mr_create fetches first and refuses while the source is behind the target', async () => {
  const { ctx, registered } = makeCtx()
  const api = makeApi({ post: () => ({ iid: 4, title: 'T', state: 'opened', web_url: 'u' }) })
  const git = makeGit({ 'rev-list': () => ({ stdout: '2\n', stderr: '' }), 'rev-parse': () => ({ stdout: 'c'.repeat(40) + '\n', stderr: '' }) })
  registerAgentTools(ctx, defaultDeps(api, git.run))
  const create = byName(registered, 'gitlab_mr_create')
  const out = await create.execute({ repo: 'proj', project: 'group/repo', source_branch: 'feature/x', target_branch: 'main', title: 'T' })
  assert.ok(/Not creating the merge request.*behind "main"/.test(out) && out.includes('2 commit'), out)
  for (const step of ['gitlab_git_pull', 'rebase', 'gitlab_git_push', 'force']) assert.ok(out.includes(step), out)
  assert.equal(api.calls.filter((c) => c[0] === 'POST').length, 0, 'no MR must be opened')
  assert.ok(git.seen.some((a) => a[0] === 'fetch' && a[1] === '--prune'), 'fetch runs before the comparison')
  const count = git.seen.find((a) => a[1] === '--count')
  assert.deepEqual(count, ['rev-list', '--count', 'refs/remotes/origin/feature/x..refs/remotes/origin/main'])

  const fresh = makeCtx()
  registerAgentTools(fresh.ctx, defaultDeps(api, makeGit().run))
  const ok = JSON.parse(await byName(fresh.registered, 'gitlab_mr_create').execute({ repo: 'proj', project: 'group/repo', source_branch: 'feature/x', target_branch: 'main', title: 'T' }))
  assert.equal(ok.target_check, 'current')
})

test('gitlab_mr_create without a local clone skips the freshness check', async () => {
  const { ctx, registered } = makeCtx()
  const api = makeApi({ post: () => ({ iid: 5, title: 'T', state: 'opened', web_url: 'u' }) })
  const git = makeGit({ config: () => { const e = new Error('not a git repository'); e.code = 'gitlab/git-failed'; throw e } })
  registerAgentTools(ctx, defaultDeps(api, git.run))
  const out = await byName(registered, 'gitlab_mr_create').execute({ project: 'group/repo', source_branch: 'feature/x', target_branch: 'main', title: 'T' })
  assert.equal(JSON.parse(out).iid, 5)
  assert.equal(JSON.parse(out).target_check, 'skipped')
  assert.equal(git.seen.some((a) => a[0] === 'fetch'), false)
})

// ---- push: lease-protected force ---------------------------------------------

test('gitlab_git_push force uses a lease on the tracking ref and needs it fetched', async () => {
  const SHA = 'a'.repeat(40)
  const git = makeGit({ 'rev-parse': () => ({ stdout: `${SHA}\n`, stderr: '' }) })
  const { ctx, registered } = makeCtx()
  registerAgentTools(ctx, defaultDeps(makeApi(), git.run))
  const push = byName(registered, 'gitlab_git_push')
  const out = await push.execute({ repo: ROOT, from: 'feature/x', force: true })
  assert.ok(out.includes('Pushed feature/x:feature/x.'), out)
  assert.deepEqual(git.seen.find((a) => a[0] === 'push'), ['push', `--force-with-lease=feature/x:${SHA}`, 'origin', 'feature/x:feature/x'])
  assert.deepEqual(git.seen.find((a) => a[0] === 'rev-parse'), ['rev-parse', '--verify', 'refs/remotes/origin/feature/x'])

  const tag = makeGit({ 'rev-parse': () => ({ stdout: `${SHA}\n`, stderr: '' }) })
  registerAgentTools(makeCtx().ctx, defaultDeps(makeApi(), tag.run))
  const { ctx: c2, registered: r2 } = makeCtx()
  registerAgentTools(c2, defaultDeps(makeApi(), tag.run))
  await byName(r2, 'gitlab_git_push').execute({ repo: ROOT, from: 'v1.2.0', to: 'refs/tags/v1.2.0', force: true })
  assert.ok(tag.seen.some((a) => a[0] === 'push' && a[1] === `--force-with-lease=refs/tags/v1.2.0:${SHA}`), JSON.stringify(tag.seen))

  const noRef = makeGit({ 'rev-parse': () => { const e = new Error('git exited 1'); e.code = 'gitlab/git-failed'; throw e } })
  const { ctx: c3, registered: r3 } = makeCtx()
  registerAgentTools(c3, defaultDeps(makeApi(), noRef.run))
  const refused = await byName(r3, 'gitlab_git_push').execute({ repo: ROOT, from: 'feature/x', force: true })
  assert.ok(/Refusing to force-push.*gitlab_git_fetch/.test(refused), refused)
  assert.equal(noRef.seen.some((a) => a[0] === 'push'), false)
})

test('gitlab_git_push without force never passes a force flag', async () => {
  const git = makeGit()
  const { ctx, registered } = makeCtx()
  registerAgentTools(ctx, defaultDeps(makeApi(), git.run))
  await byName(registered, 'gitlab_git_push').execute({ repo: ROOT, from: 'main', force: false })
  await byName(registered, 'gitlab_git_push').execute({ repo: ROOT, from: 'main' })
  for (const a of git.seen.filter((x) => x[0] === 'push')) assert.deepEqual(a, ['push', 'origin', 'main:main'])
  assert.equal(git.seen.some((x) => x[0] === 'rev-parse'), false)
})

// ---- real git: the lease against actual repositories -------------------------

/**
 * Scratch topology that mirrors the plugin's transports: a bare repo standing
 * in for the GitLab project, reached through `origin` (https) or through the
 * explicit URL the plugin uses for ssh-origin clones.
 */
async function makeScratchProject() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-gitlab-lease-'))
  const url = 'https://gitlab.example.com/group/repo.git'
  const bare = join(tmp, 'r.git')
  // Route the plugin's https URL at the bare repo, and fix the identity: the
  // test stays offline and independent of the host's git configuration. Set
  // in process.env because the plugin's real runner builds its child
  // environment from it. Restored by dispose().
  const savedEnv = { ...process.env }
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: url,
    GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 't', GIT_CONFIG_KEY_2: 'user.email', GIT_CONFIG_VALUE_2: 't@t',
  })
  const run = async (args, cwd) => {
    try { return await spawnCollect(['git', ...args], { cwd }) } catch (error) { throw new Error(`git ${args.join(' ')} (in ${cwd}): ${error.message}`, { cause: error }) }
  }
  /** Commit one file (default f); separate files keep rebases conflict-free. */
  const commit = async (dir, text, file = 'f') => { writeFileSync(join(dir, file), `${text}\n`); await run(['add', file], dir); await run(['commit', '-q', '-m', text], dir) }
  await run(['init', '-q', '--bare', bare], tmp)
  const seed = join(tmp, 'seed')
  await run(['init', '-q', '-b', 'main', seed], tmp)
  await commit(seed, '1')
  await run(['push', '-q', bare, 'main'], seed)
  return {
    tmp, bare, run, commit,
    dispose: () => { rmSync(tmp, { recursive: true, force: true }); for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv) },
  }
}

/** A clone on feature/x whose remote branch already holds one commit of ours. */
async function makeClone(scratch, name, origin) {
  const dir = join(scratch.tmp, name)
  await scratch.run(['clone', '-q', '-b', 'main', scratch.bare, dir])
  await scratch.run(['remote', 'set-url', 'origin', origin], dir)
  await scratch.run(['checkout', '-q', '-b', 'feature/x'], dir)
  await scratch.commit(dir, '2')
  await scratch.run(['push', '-q', scratch.bare, 'feature/x'], dir)
  await scratch.run(['fetch', '-q', scratch.bare, '+refs/heads/*:refs/remotes/origin/*'], dir)
  return dir
}

test('real git: force push honours the lease with an origin remote and with the explicit URL', async () => {
  for (const [name, origin] of [['https-origin', 'https://gitlab.example.com/group/repo.git'], ['ssh-origin', 'git@gitlab.example.com:group/repo.git']]) {
    // One scratch project per transport: each rewrote the same branch name.
    const scratch = await makeScratchProject()
    try {
      const dir = await makeClone(scratch, name, origin)
      const { ctx, registered } = makeCtx()
      const policy = { mode: 'danger-full-access', workspaceRoot: dir }
      registerAgentTools(ctx, { ...defaultDeps(makeApi()), getToken: () => '', getPolicy: () => policy, gitRun: makeGitRunner({ sandboxPolicy: { resolve: () => policy } }) })
      const push = byName(registered, 'gitlab_git_push')

      // History rewritten after the push (what a rebase leaves behind).
      await scratch.run(['commit', '-q', '--amend', '-m', '2-rebased'], dir)
      const plain = await push.execute({ repo: dir, from: 'feature/x' })
      assert.ok(/rejected/.test(plain), `${name}: a plain push must not rewrite: ${plain}`)

      // No tracking ref yet for this clone → refused, asks for a fetch.
      // A clone that never saw the remote branch: no tracking ref, no push
      // (a setup push here would race the earlier steps for the same branch).
      const unborn = join(scratch.tmp, `${name}-unborn`)
      await scratch.run(['clone', '-q', scratch.bare, unborn])
      await scratch.run(['checkout', '-q', '-b', 'feature/x'], unborn)
      await scratch.run(['remote', 'set-url', 'origin', origin], unborn)
      await scratch.run(['update-ref', '-d', 'refs/remotes/origin/feature/x'], unborn)
      await scratch.commit(unborn, 'unpushed')
      const noRef = await push.execute({ repo: unborn, from: 'feature/x', force: true })
      assert.ok(/Refusing to force-push.*gitlab_git_fetch/.test(noRef), `${name}: ${noRef}`)

      // Lease on the tracking ref the clone already has → accepted.
      const forced = await push.execute({ repo: dir, from: 'feature/x', force: true })
      assert.ok(forced.startsWith('Pushed feature/x:feature/x.'), `${name}: ${forced}`)

      // Someone else moves the remote branch: the stale lease must not overwrite it.
      const other = join(scratch.tmp, `${name}-other`)
      await scratch.run(['clone', '-q', scratch.bare, other])
      await scratch.run(['checkout', '-q', '-B', 'feature/x', 'refs/remotes/origin/feature/x'], other)
      await scratch.commit(other, '3')
      await scratch.run(['push', '-q', scratch.bare, 'feature/x'], other)
      await scratch.commit(dir, '4')
      const stale = await push.execute({ repo: dir, from: 'feature/x', force: true })
      assert.ok(/stale info/.test(stale), `${name}: ${stale}`)
      const head = await scratch.run(['rev-parse', 'feature/x'], scratch.bare)
      const theirs = await scratch.run(['rev-parse', 'HEAD'], other)
      assert.equal(head.stdout.trim(), theirs.stdout.trim(), `${name}: the other push must survive`)

      // After a fetch the lease follows the new remote value.
      const fetched = await byName(registered, 'gitlab_git_fetch').execute({ repo: dir })
      assert.ok(fetched.includes('Fetched'), fetched)
      const retried = await push.execute({ repo: dir, from: 'feature/x', force: true })
      assert.ok(retried.startsWith('Pushed feature/x:feature/x.'), `${name}: ${retried}`)
    } finally { scratch.dispose() }
  }
})

test('real git: gitlab_mr_create refuses while the source is behind, passes once rebased', async () => {
  const scratch = await makeScratchProject()
  try {
    const dir = await makeClone(scratch, 'work', 'git@gitlab.example.com:group/repo.git')
    const { ctx, registered } = makeCtx()
    const api = makeApi({ post: () => ({ iid: 9, title: 'T', state: 'opened', web_url: 'u' }) })
    const policy = { mode: 'danger-full-access', workspaceRoot: dir }
    registerAgentTools(ctx, { ...defaultDeps(api), getToken: () => '', getPolicy: () => policy, gitRun: makeGitRunner({ sandboxPolicy: { resolve: () => policy } }) })
    const mr = { repo: dir, project: 'group/repo', source_branch: 'feature/x', target_branch: 'main', title: 'T' }

    // Up to date: the MR opens and says so.
    const fresh = JSON.parse(await byName(registered, 'gitlab_mr_create').execute(mr))
    assert.equal(fresh.target_check, 'current')

    // main moves on the server (another clone pushes to it).
    const other = join(scratch.tmp, 'other')
    await scratch.run(['clone', '-q', '-b', 'main', scratch.bare, other])
    await scratch.commit(other, 'on-main', 'g')
    await scratch.run(['push', '-q', scratch.bare, 'main'], other)
    const behind = await byName(registered, 'gitlab_mr_create').execute(mr)
    assert.ok(/Not creating the merge request yet.*behind "main"/.test(behind) && behind.includes('1 commit'), behind)
    assert.equal(api.calls.filter((c) => c[0] === 'POST').length, 1, 'no second MR')

    // The guidance itself works: pull (rebase) → force push → create.
    const pulled = await byName(registered, 'gitlab_git_pull').execute({ repo: dir, branch: 'main' })
    assert.ok(pulled.startsWith('Pulled (rebase).'), pulled)
    const pushed = await byName(registered, 'gitlab_git_push').execute({ repo: dir, from: 'feature/x', force: true })
    assert.ok(pushed.startsWith('Pushed feature/x:feature/x.'), pushed)
    const done = JSON.parse(await byName(registered, 'gitlab_mr_create').execute(mr))
    assert.equal(done.iid, 9)
    assert.equal(done.target_check, 'current')
    assert.equal(api.calls.filter((c) => c[0] === 'POST').length, 2)
  } finally { scratch.dispose() }
})
