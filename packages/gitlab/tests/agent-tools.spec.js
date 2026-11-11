/**
 * Unit tests for the agent tool set (strict fakes: inject-scoped ctx,
 * fake API client, fake git runner). Covers registration shape, the
 * merged-only branch deletion contract, workspace path guard, and the
 * apply() mount stages with reactive config wrappers.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentTools } from '../lib/agent-tools.js'
import { apply } from '../index.js'

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
const defaultDeps = (api, gitRun) => ({
  api,
  baseUrl: 'https://gitlab.example.com',
  getToken: () => 'glpat-test',
  getRoots: () => [ROOT],
  gitTimeoutMs: () => 5000,
  ...(gitRun === undefined ? {} : { gitRun }),
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

test('gitlab_git_status runs local git inside the roots only', async () => {
  const { ctx, registered } = makeCtx()
  const seen = []
  const gitRun = async (args, opts) => { seen.push({ args, opts }); return { stdout: '## main', stderr: '' } }
  registerAgentTools(ctx, defaultDeps(makeApi(), gitRun))
  const status = byName(registered, 'gitlab_git_status')
  const ok = await status.execute({ repo: '/home/ramuz/ws/proj' })
  assert.equal(ok, '## main')
  assert.deepEqual(seen[0].args, ['status', '--porcelain=v1', '--branch'])
  assert.equal(seen[0].opts.cwd, '/home/ramuz/ws/proj')
  const denied = await status.execute({ repo: '/etc' })
  assert.ok(denied.includes('gitlab/path-outside-workspace'), denied)
})

test('gitlab_git_fetch with a proper https origin uses remote mode and token header', async () => {
  const { ctx, registered } = makeCtx()
  const seen = []
  const gitRun = async (args, opts) => {
    seen.push({ args, opts })
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
  assert.deepEqual(injects[0].list, ['tools', 'systemPrompt', 'credentials'])
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
