/**
 * Agent-facing GitLab tools + their prompt section.
 *
 * Six groups, every operation an explicitly named tool with parameter
 * descriptions:
 *   - git remote ops (clone/fetch/push/pull) — token injected host-side
 *   - local branch/commit history ops — confined by the session's sandbox
 *   - stale merged branch cleanup — delete only ever allowed for merged
 *   - pipelines & jobs (incl. scheduled pipelines)
 *   - merge requests (create/cancel/update/comment/review)
 *   - issues / milestones / releases
 *
 * The token stays Host-side (lib/gitlab-api.js, lib/git-exec.js); failures
 * surface as plain text naming the GitlabError code. Git processes run under
 * the CALLING session's own sandbox policy (sandboxPolicy.resolve +
 * sandbox.confine — the same confinement bash uses), not a plugin-own
 * permission list. Branch deletion is merged-only by design: local deletes
 * use `git branch -d` (never -D) and remote deletes verify via the compare
 * API that the branch contains no commits absent from the target branch
 * before calling DELETE.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GitlabError, projectIdSegment } from './gitlab-api.js'
import { projectHttpUrl, resolveFetchTarget, resolveRepoPath } from './git-exec.js'

/** Plain-text tool output (session-query's TEXT_OUTPUT shape). */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

export const GITLAB_PROMPT_TEXT =
  'GitLab operations go through the gitlab_* tools instead of glab or raw git-over-network in bash: '
  + 'they run Host-side with the configured GitLab token, so no sandbox approval is needed and the token never appears in results. '
  + 'Use gitlab_repo_info to resolve a project (accepts namespace/path or numeric id) and learn its default branch. '
  + 'git remote transport is HTTPS only; git processes run under the calling session\'s own sandbox policy (same confinement as its shell), so workspace paths follow the session permission mode. '
  + 'Branch deletion is merged-only: gitlab_stale_branches lists remote branches already merged, and gitlab_delete_branch refuses unmerged branches. '
  + 'Pipelines are triggered and watched with gitlab_pipeline_* / gitlab_job_get (job log tail), and scheduled pipelines with gitlab_schedule_*. '
  + 'Merge requests: gitlab_mr_create / gitlab_mr_update (state_event close cancels one) / gitlab_mr_comment (plain or line-position review) / gitlab_mr_get (include_changes reads the diff). '
  + 'Issues, milestones, and releases have gitlab_issue_* / gitlab_milestone_* / gitlab_release_* tools.'

/** Map one tool failure to model-facing text; never rethrow into the host. */
function failure(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return `GitLab request timed out or was cancelled (${String(error?.message ?? error)}).`
  }
  const code = error?.code ?? 'gitlab/unreachable'
  return `GitLab call failed (${code}${error?.status !== undefined ? ` HTTP ${error.status}` : ''}): ${error?.message ?? String(error)}`
}

/**
 * Register the tools and the prompt section.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with tools+systemPrompt injected.
 * @param {{
 *   api: { get: Function, post: Function, put: Function, del: Function },
 *   getBaseUrl: () => string,
 *   getToken: () => string,
 *   getPolicy: (exec?: { agent?: { session?: unknown } }) => { mode: string, workspaceRoot: string, additionalWritableRoots?: readonly string[] },
 *   gitTimeoutMs: () => number,
 *   gitRun: (args: string[], cwd: string, exec?: object, options?: { token?: string, timeoutMs?: number }) => Promise<{ stdout: string, stderr: string }>,
 * }} deps
 * @returns {() => void} disposer removing the section and all tools.
 */
export function registerAgentTools(ctx, deps) {
  const { api } = deps
  // Per-call baseUrl: reads the volatile config on every use, so Plugins-page
  // edits apply live (same contract as the token).
  const baseUrl = () => deps.getBaseUrl()
  const gitRun = deps.gitRun
  const gitTimeout = () => deps.gitTimeoutMs()
  const token = () => deps.getToken()

  const offs = []
  offs.push(ctx.systemPrompt.section({
    name: 'tool:gitlab',
    order: 2360, // after airboard (2350), before TOOL_GOAL (2400)
    text: GITLAB_PROMPT_TEXT,
  }))

  const register = (tool) => offs.push(ctx.tools.register(tool))

  /** Resolve the repo dir argument against the session policy's workspace root. */
  const repoDir = (args, exec) => resolveRepoPath(args.repo ?? '.', deps.getPolicy(exec))

  /** Authenticated local git run bound to a repo dir. */
  const gitAuthed = (args, gitArgs, exec) => gitRun(gitArgs, repoDir(args, exec), exec, { token: token(), timeoutMs: gitTimeout() })
  const gitLocal = (args, gitArgs, exec) => gitRun(gitArgs, repoDir(args, exec), exec, { timeoutMs: gitTimeout() })

  const pid = (project) => projectIdSegment(project)

  // ---- project ------------------------------------------------------------
  register(defineTool({
    name: 'gitlab_repo_info',
    description: 'Read one GitLab project\'s key facts: default branch, http/ssh URLs, visibility, last activity. Accepts namespace/path or numeric id.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path with namespace (e.g. "group/repo") or numeric id.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const p = await api.get(`/projects/${pid(args.project)}`, undefined, exec?.signal)
        return JSON.stringify({
          id: p.id, path: p.path_with_namespace, default_branch: p.default_branch,
          web_url: p.web_url, http_url: p.http_url_to_repo, ssh_url: p.ssh_url_to_repo,
          visibility: p.visibility, archived: p.archived, last_activity_at: p.last_activity_at,
        })
      } catch (error) { return failure(error) }
    },
  }))

  // ---- git remote ops -----------------------------------------------------
  register(defineTool({
    name: 'gitlab_git_clone',
    description: 'Clone a GitLab repository over HTTPS into the workspace. Runs Host-side with the configured token (no credential prompts); the destination must be inside the session workspace.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path with namespace or numeric id.' },
      dir: { type: 'string', required: true, description: 'Destination directory inside the workspace (absolute, or relative to the workspace root).' },
      branch: { type: 'string', description: 'Branch to check out after cloning (default: the project\'s default branch).' },
      depth: { type: 'integer', description: 'Shallow clone depth in commits (omit for a full clone).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const dir = resolveRepoPath(args.dir, deps.getPolicy())
        const info = await api.get(`/projects/${pid(args.project)}`)
        const gitArgs = ['clone', ...(args.branch ? ['-b', args.branch] : []), ...(args.depth ? ['--depth', String(args.depth)] : []), projectHttpUrl(baseUrl(), info.path_with_namespace), dir]
        const { stdout, stderr } = await gitRun(gitArgs, undefined, undefined, { token: token(), timeoutMs: gitTimeout() })
        return `Cloned ${info.path_with_namespace} into ${dir}${stdout ? `\n${stdout}` : ''}${stderr ? `\n${stderr}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_fetch',
    description: 'Fetch the GitLab remote (branches and tags) into an existing workspace clone, Host-side with the configured token. Updates remote-tracking refs; use gitlab_git_pull to also move the local branch.',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      project: { type: 'string', description: 'Project path/id; needed when the clone has no origin remote. Ignored when a proper https origin exists.' },
      prune: { type: 'boolean', description: 'Prune deleted remote branches (default true).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const dir = repoDir(args)
        const target = await resolveFetchTarget({ run: (a, c, e) => gitRun(a, c, e, { timeoutMs: gitTimeout() }), repoDir: dir, baseUrl: baseUrl(), project: args.project, exec })
        const gitArgs = target.mode === 'remote'
          ? ['fetch', ...(args.prune === false ? [] : ['--prune']), '--tags', 'origin']
          : ['fetch', ...(args.prune === false ? [] : ['--prune']), '--tags', target.url, '+refs/heads/*:refs/remotes/origin/*']
        const { stdout, stderr } = await gitRun(gitArgs, dir, exec, { token: token(), timeoutMs: gitTimeout() })
        return `Fetched.${stdout.trim() ? `\n${stdout.trim()}` : ''}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_push',
    description: 'Push a local branch or tag ref to the GitLab remote, Host-side with the configured token. No force-push: the remote ref is only fast-forwarded; rebase or merge first when the remote is ahead.',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      from: { type: 'string', required: true, description: 'Local ref to push, e.g. "main", "feature/x", or "refs/tags/v1.2.0".' },
      to: { type: 'string', description: 'Remote ref to update (default: same as from).' },
      project: { type: 'string', description: 'Project path/id; needed when the clone has no origin remote.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const dir = repoDir(args)
        if (args.to === '') return 'Refusing an empty remote ref (that deletes the remote branch). Use gitlab_delete_branch for merged-branch cleanup.'
        const target = await resolveFetchTarget({ run: (a, c, e) => gitRun(a, c, e, { timeoutMs: gitTimeout() }), repoDir: dir, baseUrl: baseUrl(), project: args.project, exec })
        if (target.mode === 'url') throw new GitlabError('gitlab/git-failed', 'Pushing needs an https origin remote in the clone. Set it with `git remote add origin <project https url>` first.')
        const refspec = `${args.from}:${args.to ?? args.from}`
        const { stdout, stderr } = await gitRun(['push', 'origin', refspec], dir, exec, { token: token(), timeoutMs: gitTimeout() })
        return `Pushed ${refspec}.${stdout.trim() ? `\n${stdout.trim()}` : ''}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_pull',
    description: 'Sync the current local branch with the GitLab remote: fetch Host-side with the configured token, then rebase (default) or merge. This is the operation to repeat before pushing shared branches.',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      project: { type: 'string', description: 'Project path/id; needed when the clone has no origin remote.' },
      strategy: { type: 'string', enum: ['rebase', 'merge'], description: 'How to integrate fetched commits (default rebase).' },
      branch: { type: 'string', description: 'Remote branch to integrate (default: the current branch\'s upstream).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const dir = repoDir(args)
        const target = await resolveFetchTarget({ run: (a, c, e) => gitRun(a, c, e, { timeoutMs: gitTimeout() }), repoDir: dir, baseUrl: baseUrl(), project: args.project, exec })
        const fetchArgs = target.mode === 'remote'
          ? ['fetch', '--prune', '--tags', 'origin']
          : ['fetch', '--prune', '--tags', target.url, '+refs/heads/*:refs/remotes/origin/*']
        await gitRun(fetchArgs, dir, exec, { token: token(), timeoutMs: gitTimeout() })
        const upstream = args.branch ? `origin/${args.branch}` : '@{upstream}'
        const integrate = args.strategy === 'merge'
          ? ['merge', '--ff-only', upstream]
          : ['rebase', upstream]
        const { stdout, stderr } = await gitRun(integrate, dir, exec, { timeoutMs: gitTimeout() })
        return `Pulled (${args.strategy ?? 'rebase'}).${stdout.trim() ? `\n${stdout.trim()}` : ''}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  // ---- local branch / history management ----------------------------------
  register(defineTool({
    name: 'gitlab_git_status',
    description: 'Read a workspace repository\'s status: current branch, ahead/behind counts, and changed files (porcelain).',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const { stdout } = await gitLocal(args, ['status', '--porcelain=v1', '--branch'], exec)
        return stdout
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_log',
    description: 'Read a workspace repository\'s commit log, newest first, one line per commit.',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      ref: { type: 'string', description: 'Branch / tag / commit to log (default: HEAD).' },
      max: { type: 'integer', description: 'Maximum commits to return (default 20).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const { stdout } = await gitLocal(args, ['log', '--oneline', `-${Math.max(1, Math.min(Number(args.max) || 20, 200))}`, args.ref ?? 'HEAD'], exec)
        return stdout
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_checkout',
    description: 'Switch a workspace repository to an existing branch/commit/tag, or create a new branch from the current HEAD and switch to it.',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      ref: { type: 'string', description: 'Existing branch / commit / tag to check out (omit when creating).' },
      create: { type: 'string', description: 'New branch name to create and check out.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        if (!args.create && !args.ref) return 'Provide ref (switch) or create (new branch).'
        const { stdout, stderr } = await gitLocal(args, args.create ? ['checkout', '-b', args.create] : ['checkout', args.ref], exec)
        return `Switched.${stdout.trim() ? `\n${stdout.trim()}` : ''}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_branch',
    description: 'Manage LOCAL branches: list (with tracking info), create from a start point, or delete. Delete is merged-only (`git branch -d`, never -D): git refuses branches whose commits are not merged; push the branch or cherry-pick first.',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      action: { type: 'string', required: true, enum: ['list', 'create', 'delete'], description: 'What to do.' },
      name: { type: 'string', description: 'Branch name (required for create/delete).' },
      start_point: { type: 'string', description: 'Start point for create (default: current HEAD).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        if (args.action !== 'list' && !args.name) return 'name is required for create/delete.'
        const gitArgs = args.action === 'list' ? ['branch', '-vv']
          : args.action === 'create' ? ['branch', args.name, ...(args.start_point ? [args.start_point] : [])]
            : ['branch', '-d', args.name]
        const { stdout, stderr } = await gitLocal(args, gitArgs, exec)
        return `${args.action} done.${stdout.trim() ? `\n${stdout.trim()}` : ''}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_rebase',
    description: 'Rebase the current branch (or a named branch, checked out first) onto another ref — the way to sync with a shared base branch before pushing.',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      onto: { type: 'string', required: true, description: 'Base ref to rebase onto, e.g. "main" or "origin/main".' },
      branch: { type: 'string', description: 'Branch to rebase (default: current branch).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        if (args.branch) await gitLocal(args, ['checkout', args.branch], exec)
        const { stdout, stderr } = await gitLocal(args, ['rebase', args.onto], exec)
        return `Rebased onto ${args.onto}.${stdout.trim() ? `\n${stdout.trim()}` : ''}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_cherry_pick',
    description: 'Cherry-pick commits onto the current branch, by hash or a range like "abc123^..def456". Conflicts abort non-destructively (git cherry-pick default); resolve and continue via bash git.',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      commits: { type: 'string', required: true, description: 'Commit hash or range expression to cherry-pick.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const { stdout, stderr } = await gitLocal(args, ['cherry-pick', args.commits], exec)
        return `Cherry-picked ${args.commits}.${stdout.trim() ? `\n${stdout.trim()}` : ''}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_merge',
    description: 'Merge a branch into the current branch of a workspace repository.',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      branch: { type: 'string', required: true, description: 'Branch to merge in.' },
      no_ff: { type: 'boolean', description: 'Create a merge commit even when a fast-forward is possible.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const { stdout, stderr } = await gitLocal(args, ['merge', ...(args.no_ff ? ['--no-ff'] : []), args.branch], exec)
        return `Merged ${args.branch}.${stdout.trim() ? `\n${stdout.trim()}` : ''}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_git_tag',
    description: 'Manage LOCAL tags: list, create at a ref, or delete. Push a tag with gitlab_git_push (from "refs/tags/<name>").',
    parameters: {
      repo: { type: 'string', description: 'Repository directory inside the workspace (default: workspace root).' },
      action: { type: 'string', required: true, enum: ['list', 'create', 'delete'], description: 'What to do.' },
      name: { type: 'string', description: 'Tag name (required for create/delete).' },
      target: { type: 'string', description: 'Ref for create (default: current HEAD).' },
      message: { type: 'string', description: 'Annotated-tag message (omit for a lightweight tag).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        if (args.action !== 'list' && !args.name) return 'name is required for create/delete.'
        const gitArgs = args.action === 'list' ? ['tag', '--list']
          : args.action === 'create'
            ? args.message ? ['tag', '-a', args.name, '-m', args.message, ...(args.target ? [args.target] : [])]
              : ['tag', args.name, ...(args.target ? [args.target] : [])]
            : ['tag', '-d', args.name]
        const { stdout, stderr } = await gitLocal(args, gitArgs, exec)
        return `${args.action} done.${stdout.trim() ? `\n${stdout.trim()}` : ''}${stderr.trim() ? `\n${stderr.trim()}` : ''}`
      } catch (error) { return failure(error) }
    },
  }))

  // ---- stale merged branch cleanup ----------------------------------------
  const compareMerged = async (project, branch, target, signal) => {
    const cmp = await api.get(`/projects/${pid(project)}/repository/compare`, { from: target, to: branch }, signal)
    return Array.isArray(cmp?.commits) && cmp.commits.length === 0
  }

  register(defineTool({
    name: 'gitlab_stale_branches',
    description: 'List REMOTE branches that are safe to delete: already merged into a target branch (verified via the compare API) or whose merge request was merged. Skips the default and protected branches. Follow with gitlab_delete_branch.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      merged_into: { type: 'string', description: 'Branch the others must be merged into (default: project default branch).' },
      include_protected: { type: 'boolean', description: 'Also report protected branches (they are never deletable; default false).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const info = await api.get(`/projects/${pid(args.project)}`, undefined, exec?.signal)
        const target = args.merged_into ?? info.default_branch
        const branches = await api.get(`/projects/${pid(args.project)}/repository/branches`, { per_page: 50, page: 1 }, exec?.signal)
        const mergedMrs = await api.get(`/projects/${pid(args.project)}/merge_requests`, { state: 'merged', per_page: 100, page: 1 }, exec?.signal)
        const mergedSources = new Set(mergedMrs.map((mr) => mr.source_branch))
        const out = []
        for (const b of branches) {
          if (b.name === info.default_branch) continue
          if (b.merged === true) { out.push({ branch: b.name, merged_via: 'gitlab-flag' }); continue }
          if (b.protected && args.include_protected !== true) continue
          if (mergedSources.has(b.name)) { out.push({ branch: b.name, merged_via: 'merged-mr' }); continue }
          if (mergedSources.size > 0 || branches.length <= 25) {
            const merged = await compareMerged(args.project, b.name, target, exec?.signal).catch(() => null)
            if (merged === true) out.push({ branch: b.name, merged_via: 'compare' })
          }
        }
        return JSON.stringify({ project: info.path_with_namespace, merged_into: target, stale: out }, null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_delete_branch',
    description: 'Delete one REMOTE branch on GitLab — merged branches only. The tool verifies via the compare API that the branch has no commits absent from the target branch and refuses otherwise; the default and protected branches are always refused. For unmerged branches use a merge request instead.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      branch: { type: 'string', required: true, description: 'Remote branch to delete.' },
      merged_into: { type: 'string', description: 'Branch it must be merged into (default: project default branch).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const info = await api.get(`/projects/${pid(args.project)}`, undefined, exec?.signal)
        if (args.branch === info.default_branch) return 'Refusing to delete the default branch.'
        const b = await api.get(`/projects/${pid(args.project)}/repository/branches/${encodeURIComponent(args.branch)}`, undefined, exec?.signal)
        if (b?.protected) return 'Refusing to delete a protected branch.'
        if (b?.merged !== true) {
          const target = args.merged_into ?? info.default_branch
          const merged = await compareMerged(args.project, args.branch, target, exec?.signal)
          if (!merged) return `Refusing to delete "${args.branch}": it still has commits not merged into "${target}". Merge it first (merge request or gitlab_git_merge + push).`
        }
        await api.del(`/projects/${pid(args.project)}/repository/branches/${encodeURIComponent(args.branch)}`, undefined, exec?.signal)
        return `Deleted remote branch ${args.branch}.`
      } catch (error) { return failure(error) }
    },
  }))

  // ---- pipelines & jobs ----------------------------------------------------
  register(defineTool({
    name: 'gitlab_pipeline_trigger',
    description: 'Create (trigger) a new pipeline for a ref, optionally with CI variables. Follow with gitlab_pipeline_get to watch it.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      ref: { type: 'string', required: true, description: 'Branch or tag to run the pipeline for.' },
      variables: { type: 'array', description: 'CI variables, each item {"key": ..., "value": ...}.', items: { type: 'object', additionalProperties: true } },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const created = await api.post(`/projects/${pid(args.project)}/pipeline`, { ref: args.ref, ...(args.variables ? { variables: args.variables } : {}) }, exec?.signal)
        return JSON.stringify({ id: created.id, status: created.status, ref: created.ref, web_url: created.web_url })
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_pipeline_list',
    description: 'List pipelines of a project, newest first; filter by ref or status (running, pending, success, failed, ...). Paginated.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      ref: { type: 'string', description: 'Filter by branch/tag.' },
      status: { type: 'string', description: 'Filter by status, e.g. running, failed, success.' },
      page: { type: 'integer', description: 'Page number (default 1, 20 per page).' },
      per_page: { type: 'integer', description: 'Results per page (max 100, default 20).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const rows = await api.get(`/projects/${pid(args.project)}/pipelines`, { ref: args.ref, status: args.status, page: args.page, per_page: args.per_page }, exec?.signal)
        return JSON.stringify(rows.map((p) => ({ id: p.id, iid: p.iid, status: p.status, ref: p.ref, sha: p.sha?.slice(0, 8), created_at: p.created_at, web_url: p.web_url })), null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_pipeline_get',
    description: 'Read one pipeline: status, ref, sha, duration, and its jobs (name, stage, status) for spotting the failing job; then gitlab_job_get for that job\'s log.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      pipeline_id: { type: 'integer', required: true, description: 'Pipeline id.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const p = await api.get(`/projects/${pid(args.project)}/pipelines/${args.pipeline_id}`, undefined, exec?.signal)
        const jobs = await api.get(`/projects/${pid(args.project)}/pipelines/${args.pipeline_id}/jobs`, { per_page: 50 }, exec?.signal)
        return JSON.stringify({
          id: p.id, status: p.status, ref: p.ref, sha: p.sha?.slice(0, 8), source: p.source,
          created_at: p.created_at, finished_at: p.finished_at, duration: p.duration, web_url: p.web_url,
          jobs: jobs.map((j) => ({ id: j.id, name: j.name, stage: j.stage, status: j.status, duration: j.duration, web_url: j.web_url })),
        }, null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_pipeline_cancel',
    description: 'Cancel a running or pending pipeline.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      pipeline_id: { type: 'integer', required: true, description: 'Pipeline id.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const p = await api.post(`/projects/${pid(args.project)}/pipelines/${args.pipeline_id}/cancel`, {}, exec?.signal)
        return `Pipeline ${args.pipeline_id} canceled (status ${p.status}).`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_pipeline_retry',
    description: 'Retry a failed or canceled pipeline (failed jobs are retried).',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      pipeline_id: { type: 'integer', required: true, description: 'Pipeline id.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const p = await api.post(`/projects/${pid(args.project)}/pipelines/${args.pipeline_id}/retry`, {}, exec?.signal)
        return `Pipeline ${args.pipeline_id} retry requested (status ${p.status}).`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_job_get',
    description: 'Read one CI job: status, stage, runner, duration, commit, and the tail of its log trace — the tool for diagnosing a failed pipeline job.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      job_id: { type: 'integer', required: true, description: 'Job id (see gitlab_pipeline_get jobs).' },
      log_tail: { type: 'integer', description: 'Number of trailing log lines to return (default 80; 0 for none).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const j = await api.get(`/projects/${pid(args.project)}/jobs/${args.job_id}`, undefined, exec?.signal)
        const lines = Math.max(0, Math.min(Number(args.log_tail ?? 80), 500))
        const trace = lines > 0
          ? await api.get(`/projects/${pid(args.project)}/jobs/${args.job_id}/trace`, undefined, exec?.signal, { text: true })
          : undefined
        const tail = trace === undefined ? '' : `\n--- trace (last ${lines} lines) ---\n${trace.split('\n').slice(-lines).join('\n')}`
        return JSON.stringify({
          id: j.id, name: j.name, status: j.status, stage: j.stage, ref: j.ref,
          commit: j.commit?.message?.split('\n')[0], runner: j.runner?.description,
          duration: j.duration, web_url: j.web_url,
        }, null, 2) + tail
      } catch (error) { return failure(error) }
    },
  }))

  // ---- scheduled pipelines --------------------------------------------------
  register(defineTool({
    name: 'gitlab_schedule_list',
    description: 'List pipeline schedules (定时流水线) of a project with their cron, ref, and active state.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const rows = await api.get(`/projects/${pid(args.project)}/pipeline_schedules`, undefined, exec?.signal)
        return JSON.stringify(rows.map((s) => ({ id: s.id, description: s.description, ref: s.ref, cron: s.cron, cron_timezone: s.cron_timezone, active: s.active, next_run_at: s.next_run_at, last_pipeline: s.last_pipeline })), null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_schedule_create',
    description: 'Create a pipeline schedule (定时流水线): a cron expression plus the ref to build. Active by default.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      description: { type: 'string', required: true, description: 'Human-readable schedule name.' },
      ref: { type: 'string', required: true, description: 'Branch or tag to build.' },
      cron: { type: 'string', required: true, description: 'Cron expression in the schedule\'s timezone, e.g. "0 3 * * *".' },
      cron_timezone: { type: 'string', description: 'IANA timezone for the cron (default: instance-local / "UTC").' },
      active: { type: 'boolean', description: 'Whether the schedule runs (default true).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const created = await api.post(`/projects/${pid(args.project)}/pipeline_schedules`, {
          description: args.description, ref: args.ref, cron: args.cron,
          ...(args.cron_timezone ? { cron_timezone: args.cron_timezone } : {}),
          active: args.active ?? true,
        }, exec?.signal)
        return JSON.stringify({ id: created.id, description: created.description, cron: created.cron, active: created.active })
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_schedule_update',
    description: 'Update or pause/resume a pipeline schedule: change cron, ref, description, or flip its active flag.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      schedule_id: { type: 'integer', required: true, description: 'Schedule id (see gitlab_schedule_list).' },
      description: { type: 'string', description: 'New description (omit to keep).' },
      ref: { type: 'string', description: 'New ref (omit to keep).' },
      cron: { type: 'string', description: 'New cron expression (omit to keep).' },
      cron_timezone: { type: 'string', description: 'New IANA timezone (omit to keep).' },
      active: { type: 'boolean', description: 'true activates, false pauses (omit to keep).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const body = {}
        for (const key of ['description', 'ref', 'cron', 'cron_timezone', 'active']) {
          if (args[key] !== undefined) body[key] = args[key]
        }
        if (Object.keys(body).length === 0) return 'Nothing to update: provide at least one field.'
        const updated = await api.put(`/projects/${pid(args.project)}/pipeline_schedules/${args.schedule_id}`, body, exec?.signal)
        return `Schedule ${args.schedule_id} updated (cron ${updated.cron}, active ${updated.active}).`
      } catch (error) { return failure(error) }
    },
  }))

  // ---- merge requests -------------------------------------------------------
  register(defineTool({
    name: 'gitlab_mr_create',
    description: 'Open a merge request: source branch → target branch with a title. Optionally remove the source branch and squash commits on merge.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      source_branch: { type: 'string', required: true, description: 'Branch containing the work.' },
      target_branch: { type: 'string', required: true, description: 'Branch to merge into.' },
      title: { type: 'string', required: true, description: 'MR title.' },
      description: { type: 'string', description: 'MR description (markdown).' },
      remove_source_branch: { type: 'boolean', description: 'Delete the source branch when merged (default false).' },
      squash: { type: 'boolean', description: 'Squash commits when merging (default false).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const mr = await api.post(`/projects/${pid(args.project)}/merge_requests`, {
          source_branch: args.source_branch, target_branch: args.target_branch, title: args.title,
          ...(args.description !== undefined ? { description: args.description } : {}),
          remove_source_branch: args.remove_source_branch ?? false, squash: args.squash ?? false,
        }, exec?.signal)
        return JSON.stringify({ iid: mr.iid, title: mr.title, state: mr.state, web_url: mr.web_url })
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_mr_list',
    description: 'List merge requests of a project; filter by state (opened, closed, merged, all — default opened). Paginated.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      state: { type: 'string', enum: ['opened', 'closed', 'merged', 'all'], description: 'State filter (default opened).' },
      page: { type: 'integer', description: 'Page number (default 1, 20 per page).' },
      per_page: { type: 'integer', description: 'Results per page (max 100, default 20).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const rows = await api.get(`/projects/${pid(args.project)}/merge_requests`, { state: args.state, page: args.page, per_page: args.per_page }, exec?.signal)
        return JSON.stringify(rows.map((m) => ({ iid: m.iid, title: m.title, state: m.state, source_branch: m.source_branch, target_branch: m.target_branch, author: m.author?.username, merged_at: m.merged_at, web_url: m.web_url })), null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_mr_get',
    description: 'Read one merge request: description, branches, review status, and (by default) the file diffs — the tool for reviewing an MR\'s content.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      mr_iid: { type: 'integer', required: true, description: 'MR iid (project-local number).' },
      include_changes: { type: 'boolean', description: 'Include the changed files and patch (default true).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const m = await api.get(`/projects/${pid(args.project)}/merge_requests/${args.mr_iid}`, undefined, exec?.signal)
        const base = {
          iid: m.iid, title: m.title, state: m.state, draft: m.work_in_progress,
          source_branch: m.source_branch, target_branch: m.target_branch, author: m.author?.username,
          description: m.description, upvotes: m.upvotes, downvotes: m.downvotes,
          has_conflicts: m.has_conflicts, merge_status: m.merge_status, web_url: m.web_url,
        }
        if (args.include_changes === false) return JSON.stringify(base, null, 2)
        const changes = await api.get(`/projects/${pid(args.project)}/merge_requests/${args.mr_iid}/changes`, undefined, exec?.signal)
        const files = (changes.changes ?? []).map((c) => ({
          path: c.new_path, old_path: c.old_path, new_file: c.new_file, deleted_file: c.deleted_file, renamed_file: c.renamed_file, diff: c.diff?.slice(0, 2000),
        }))
        return JSON.stringify({ ...base, changes_count: changes.changes_count, changes: files }, null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_mr_update',
    description: 'Update a merge request: retitle, rewrite the description, close it (state_event "close" — this is how you cancel an MR), reopen, or change merge options.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      mr_iid: { type: 'integer', required: true, description: 'MR iid.' },
      title: { type: 'string', description: 'New title (omit to keep).' },
      description: { type: 'string', description: 'New description (omit to keep).' },
      state_event: { type: 'string', enum: ['close', 'reopen'], description: 'close cancels the MR; reopen restores it.' },
      remove_source_branch: { type: 'boolean', description: 'Delete the source branch when merged.' },
      squash: { type: 'boolean', description: 'Squash commits when merging.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const body = {}
        for (const key of ['title', 'description', 'state_event', 'remove_source_branch', 'squash']) {
          if (args[key] !== undefined) body[key] = args[key]
        }
        if (Object.keys(body).length === 0) return 'Nothing to update: provide at least one field.'
        const m = await api.put(`/projects/${pid(args.project)}/merge_requests/${args.mr_iid}`, body, exec?.signal)
        return `MR !${m.iid} updated (state ${m.state}).`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_mr_comment',
    description: 'Comment on a merge request: a general note, or — with a position object — a review comment pinned to a file/line of the diff. base_sha/start_sha/head_sha come from gitlab_mr_get changes.diffs base_sha or the MR\'s diff_refs.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      mr_iid: { type: 'integer', required: true, description: 'MR iid.' },
      body: { type: 'string', required: true, description: 'Comment text (markdown).' },
      position: { type: 'object', additionalProperties: true, description: 'Pin the comment to a diff line; provide base_sha, start_sha, head_sha (from the MR diff_refs), position_type:"text", new_path, old_path, and new_line (new side) or old_line (old side).', properties: { base_sha: { type: 'string' }, start_sha: { type: 'string' }, head_sha: { type: 'string' }, position_type: { type: 'string' }, new_path: { type: 'string' }, old_path: { type: 'string' }, new_line: { type: 'integer' }, old_line: { type: 'integer' } } },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        if (args.position === undefined) {
          const note = await api.post(`/projects/${pid(args.project)}/merge_requests/${args.mr_iid}/notes`, { body: args.body }, exec?.signal)
          return `Note ${note.id} posted on MR !${args.mr_iid}.`
        }
        const p = args.position
        await api.post(`/projects/${pid(args.project)}/merge_requests/${args.mr_iid}/discussions`, {
          body: args.body,
          position: { position_type: 'text', ...p },
        }, exec?.signal)
        return `Diff review comment posted on MR !${args.mr_iid}.`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_mr_reviews',
    description: 'List a merge request\'s discussions and comments (including diff-anchored review notes) with author and body.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      mr_iid: { type: 'integer', required: true, description: 'MR iid.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const rows = await api.get(`/projects/${pid(args.project)}/merge_requests/${args.mr_iid}/discussions`, { per_page: 50 }, exec?.signal)
        return JSON.stringify(rows.map((d) => ({
          id: d.id, resolved: d.resolved, diff_anchored: d.notes?.[0]?.type === 'DiffNote',
          notes: (d.notes ?? []).map((n) => ({ author: n.author?.username, body: n.body, system: n.system, created_at: n.created_at })),
        })), null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  // ---- issues / milestones / releases ---------------------------------------
  register(defineTool({
    name: 'gitlab_issue_create',
    description: 'Create an issue with title, optional description, comma-separated labels, milestone, and due date.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      title: { type: 'string', required: true, description: 'Issue title.' },
      description: { type: 'string', description: 'Issue description (markdown).' },
      labels: { type: 'string', description: 'Comma-separated label names.' },
      milestone_id: { type: 'integer', description: 'Milestone id (see gitlab_milestone_list).' },
      due_date: { type: 'string', description: 'Due date YYYY-MM-DD.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const body = { title: args.title, ...(args.description !== undefined ? { description: args.description } : {}), ...(args.labels !== undefined ? { labels: args.labels } : {}), ...(args.milestone_id !== undefined ? { milestone_id: args.milestone_id } : {}), ...(args.due_date !== undefined ? { due_date: args.due_date } : {}) }
        const issue = await api.post(`/projects/${pid(args.project)}/issues`, body, exec?.signal)
        return JSON.stringify({ iid: issue.iid, title: issue.title, state: issue.state, web_url: issue.web_url })
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_issue_list',
    description: 'List issues of a project; filter by state (opened/closed/all), labels, milestone title, or assignee username. Paginated.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      state: { type: 'string', enum: ['opened', 'closed', 'all'], description: 'State filter (default opened).' },
      labels: { type: 'string', description: 'Comma-separated label names to require.' },
      milestone: { type: 'string', description: 'Milestone title.' },
      assignee_username: { type: 'string', description: 'Assignee username.' },
      page: { type: 'integer', description: 'Page number (default 1, 20 per page).' },
      per_page: { type: 'integer', description: 'Results per page (max 100, default 20).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const rows = await api.get(`/projects/${pid(args.project)}/issues`, {
          state: args.state, labels: args.labels, milestone: args.milestone,
          assignee_username: args.assignee_username, page: args.page, per_page: args.per_page,
        }, exec?.signal)
        return JSON.stringify(rows.map((i) => ({ iid: i.iid, title: i.title, state: i.state, labels: i.labels, milestone: i.milestone?.title, assignees: i.assignees?.map((a) => a.username), due_date: i.due_date, web_url: i.web_url })), null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_issue_get',
    description: 'Read one issue: description, labels, milestone, assignees, dates; optionally include its comment thread.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      issue_iid: { type: 'integer', required: true, description: 'Issue iid (project-local number).' },
      include_notes: { type: 'boolean', description: 'Also return the comment thread (default false).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const i = await api.get(`/projects/${pid(args.project)}/issues/${args.issue_iid}`, undefined, exec?.signal)
        const base = { iid: i.iid, title: i.title, state: i.state, description: i.description, labels: i.labels, milestone: i.milestone?.title, assignees: i.assignees?.map((a) => a.username), created_at: i.created_at, closed_at: i.closed_at, due_date: i.due_date, web_url: i.web_url }
        if (args.include_notes !== true) return JSON.stringify(base, null, 2)
        const notes = await api.get(`/projects/${pid(args.project)}/issues/${args.issue_iid}/notes`, { per_page: 50 }, exec?.signal)
        return JSON.stringify({ ...base, notes: notes.filter((n) => !n.system).map((n) => ({ author: n.author?.username, body: n.body, created_at: n.created_at })) }, null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_issue_update',
    description: 'Update an issue: retitle, rewrite the description, close or reopen it (state_event), change labels / milestone / due date.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      issue_iid: { type: 'integer', required: true, description: 'Issue iid.' },
      title: { type: 'string', description: 'New title (omit to keep).' },
      description: { type: 'string', description: 'New description (omit to keep).' },
      state_event: { type: 'string', enum: ['close', 'reopen'], description: 'close or reopen the issue.' },
      labels: { type: 'string', description: 'Comma-separated labels (replaces the set).' },
      milestone_id: { type: 'integer', description: 'New milestone id (omit to keep).' },
      due_date: { type: 'string', description: 'New due date YYYY-MM-DD.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const body = {}
        for (const key of ['title', 'description', 'state_event', 'labels', 'milestone_id', 'due_date']) {
          if (args[key] !== undefined) body[key] = args[key]
        }
        if (Object.keys(body).length === 0) return 'Nothing to update: provide at least one field.'
        const i = await api.put(`/projects/${pid(args.project)}/issues/${args.issue_iid}`, body, exec?.signal)
        return `Issue #${i.iid} updated (state ${i.state}).`
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_milestone_list',
    description: 'List a project\'s milestones with state and due date; filter by state (active/closed).',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      state: { type: 'string', enum: ['active', 'closed'], description: 'State filter.' },
      page: { type: 'integer', description: 'Page number.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const rows = await api.get(`/projects/${pid(args.project)}/milestones`, { state: args.state, page: args.page, per_page: 50 }, exec?.signal)
        return JSON.stringify(rows.map((m) => ({ id: m.id, iid: m.iid, title: m.title, state: m.state, description: m.description, due_date: m.due_date, start_date: m.start_date, expired: m.expired })), null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_milestone_create',
    description: 'Create a project milestone with a title, optional description and due date.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      title: { type: 'string', required: true, description: 'Milestone title.' },
      description: { type: 'string', description: 'Milestone description (markdown).' },
      due_date: { type: 'string', description: 'Due date YYYY-MM-DD.' },
      start_date: { type: 'string', description: 'Start date YYYY-MM-DD.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const m = await api.post(`/projects/${pid(args.project)}/milestones`, {
          title: args.title,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.due_date !== undefined ? { due_date: args.due_date } : {}),
          ...(args.start_date !== undefined ? { start_date: args.start_date } : {}),
        }, exec?.signal)
        return JSON.stringify({ id: m.id, iid: m.iid, title: m.title, state: m.state })
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_release_create',
    description: 'Create a release (版本发布) for a tag: the tag is created at ref when it does not exist, with name and release notes.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      tag_name: { type: 'string', required: true, description: 'Tag for the release (created when missing).' },
      ref: { type: 'string', description: 'Commit/branch the tag points at when creating it (default: default branch).' },
      name: { type: 'string', description: 'Release name (default: tag name).' },
      description: { type: 'string', description: 'Release notes (markdown; "Changelog" section by default).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      try {
        const r = await api.post(`/projects/${pid(args.project)}/releases`, {
          tag_name: args.tag_name,
          ...(args.ref !== undefined ? { ref: args.ref } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
        }, exec?.signal)
        return JSON.stringify({ tag: r.tag_name, name: r.name, released_at: r.released_at, assets_links: (r.assets?.links ?? []).length, commit: r.commit?.id?.slice(0, 8) })
      } catch (error) { return failure(error) }
    },
  }))

  register(defineTool({
    name: 'gitlab_release_list',
    description: 'List a project\'s releases (tag, name, release date). Paginated.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project path/id.' },
      page: { type: 'integer', description: 'Page number.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        const rows = await api.get(`/projects/${pid(args.project)}/releases`, { page: args.page, per_page: 50 }, exec?.signal)
        return JSON.stringify(rows.map((r) => ({ tag: r.tag_name, name: r.name, released_at: r.released_at, commit: r.commit?.id?.slice(0, 8) })), null, 2)
      } catch (error) { return failure(error) }
    },
  }))

  return () => { for (const off of offs.reverse()) off() }
}
