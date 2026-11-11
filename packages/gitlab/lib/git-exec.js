/**
 * Host-side git runner for the GitLab plugin.
 *
 * Every git command the agent asks for runs in the HOST process (not the
 * session shell), so network access to GitLab needs no per-call approval —
 * BUT the process itself runs under the CALLING SESSION's own sandbox
 * policy, resolved per call through `ctx.sandboxPolicy` and enforced by
 * `ctx.sandbox.confine` (packages/sandbox/sandbox/src/index.ts) — the same
 * capability the bash tool uses. The plugin has NO permission system of its
 * own: a session in `workspace-write` confines git to its workspace, a
 * `danger-full-access` session runs unconfined, exactly like its shell.
 * (Pattern follows packages/experimental/client-ui-forge/src/git.ts.)
 *
 * The token never appears in argv: it rides per-invocation GIT_CONFIG_KEY_n
 * environment entries as `http.extraHeader` (Basic auth — documented GitLab
 * PAT transport for git over HTTPS), which keeps the repository config clean
 * (no token in remotes, hooks, or on-disk config). Captured stdout/stderr is
 * redacted against the token and its base64 forms before anything returns.
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { GitlabError, redact } from './gitlab-api.js'

/** Build the Basic auth extraHeader value for git over HTTPS. */
export function buildAuthHeader(token) {
  return `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`
}

/** Human-readable git HTTP(S) remote URL for a project on this instance. */
export function projectHttpUrl(baseUrl, project) {
  const origin = baseUrl.replace(/\/+$/, '')
  return `${origin}/${String(project).replace(/^\/+|\/+$/g, '')}.git`
}

/**
 * Extract the namespace/project path from a remote URL (https or ssh form),
 * and say whether the remote speaks http(s).
 * @returns {{ path: string, https: boolean } | null}
 */
export function parseRemoteUrl(url) {
  const s = String(url ?? '').trim()
  let m = s.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/i)
  if (m) return { path: m[1].replace(/\.git$/, ''), https: true }
  m = s.match(/^[\w.-]+@[\w.-]+:(.+?)(?:\.git)?$/)
  if (m) return { path: m[1].replace(/\.git$/, ''), https: false }
  m = s.match(/^ssh:\/\/[^/]+\/(.+?)(?:\.git)?$/i)
  if (m) return { path: m[1].replace(/\.git$/, ''), https: false }
  return null
}

/**
 * Read the `origin` remote URL from a repository (git config --get remote.origin.url).
 * @param {Function} run - raw runner (args, cwd, exec) => {stdout, stderr}.
 */
export async function readOriginRemote(run, repoDir, exec) {
  const { stdout } = await run(['config', '--get', 'remote.origin.url'], repoDir, exec)
  const url = String(stdout ?? '').trim()
  return url === '' ? null : url
}

/**
 * Spawn one argv and capture output. `token` (when provided) redacts both the
 * raw and base64 forms from output. `denialSignatures` (from
 * SandboxProvider.confine) map a confined failure to the session-policy
 * explanation instead of a bare git error.
 * @param {string[]} argv - FULL argv, argv[0] being the binary to spawn.
 * @param {{ cwd?: string, token?: string, timeoutMs?: number, env?: object, denialSignatures?: readonly string[] }} options
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function spawnCollect(argv, { cwd, token = '', timeoutMs = 120_000, env, denialSignatures = [] } = {}) {
  return new Promise((resolve_, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: env === undefined ? process.env : env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new GitlabError('gitlab/git-failed', `cannot spawn ${argv[0]}: ${error?.message ?? error}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const out = redact(stdout, token)
      const err = redact(stderr, token)
      if (code === 0) { resolve_({ stdout: out, stderr: err }); return }
      const lastLines = err.split('\n').filter((l) => l.trim() !== '').slice(-5).join('\n')
      // A sandbox denial is the session's own policy working, not a git fault:
      // name it as such so the model knows to ask for a wider mode, not to retry.
      const denied = denialSignatures.some((sig) => sig !== '' && err.toLowerCase().includes(sig.toLowerCase()))
      const detail = lastLines || out.slice(0, 300)
      reject(new GitlabError(
        'gitlab/git-failed',
        denied
          ? `git ${argv.at(-1) ?? ''} was blocked by the calling session's sandbox policy (the same confinement its shell runs under); switch the session's permission mode if this path must be writable.\n${detail}`
          : `git exited ${code}:\n${detail}`,
      ))
    })
  })
}

/**
 * Create the per-call git runner bound to the host's sandbox services.
 * Follows client-ui-forge's runGit: resolve the session's policy per call,
 * confine the argv for every mode except danger-full-access, and inject the
 * token through GIT_CONFIG_KEY_n env entries (never argv).
 * @param {{
 *   sandbox?: { confine(argv: string[], policy: object, signal?: AbortSignal): Promise<{ argv: string[], denialSignatures: readonly string[] }> },
 *   sandboxPolicy?: { resolve(request?: { session?: unknown }): { mode: string, workspaceRoot: string, additionalWritableRoots?: readonly string[], sessionId?: unknown } },
 *   gitBin?: string,
 * }} services - host services (ctx.sandbox / ctx.sandboxPolicy), injectable for tests.
 * @returns {(args: string[], cwd: string, exec?: { agent?: { session?: unknown }, signal?: AbortSignal }, options?: { token?: string, timeoutMs?: number }) => Promise<{ stdout: string, stderr: string }>}
 */
export function makeGitRunner({ sandbox, sandboxPolicy, gitBin = 'git' }) {
  return async (args, cwd, exec = undefined, options = {}) => {
    const token = options.token ?? ''
    const timeoutMs = options.timeoutMs ?? 120_000
    const policy = sandboxPolicy?.resolve({ session: exec?.agent?.session })
    if (policy === undefined) {
      throw new GitlabError('gitlab/git-failed', 'the sandboxPolicy service is unavailable; the GitLab tools refuse to run git outside the session policy system')
    }
    let argv = [gitBin, ...args]
    let denialSignatures = []
    if (policy.mode !== 'danger-full-access') {
      if (sandbox === undefined) {
        throw new GitlabError('gitlab/git-failed', 'the sandbox service is unavailable; the GitLab tools refuse to run git unconfined (fail closed, like bash)')
      }
      const confined = await sandbox.confine(argv, policy, exec?.signal)
      argv = confined.argv
      denialSignatures = confined.denialSignatures ?? []
    }
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    if (token !== '') {
      // Environment entries preserve filter subsection names containing '='.
      env.GIT_CONFIG_COUNT = '1'
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
      env.GIT_CONFIG_VALUE_0 = buildAuthHeader(token)
    }
    return spawnCollect(argv, { cwd, env, timeoutMs, token, denialSignatures })
  }
}

/**
 * Compose the fetch target for a repo: prefer the configured `origin` remote
 * when it is an http(s) URL on the configured instance; otherwise (ssh origin,
 * or no remote and a `project` argument was given) fall back to the explicit
 * project URL with remote-tracking refspec handling done by the caller. SSH
 * remote transport is rewritten to the project's https URL on the fly, per
 * the plugin's HTTP(S)-only transport decision.
 * @returns {Promise<{ mode: 'remote', name: 'origin' } | { mode: 'url', url: string }>}
 */
export async function resolveFetchTarget({ run, repoDir, baseUrl, project, exec }) {
  const origin = await readOriginRemote(run, repoDir, exec)
  if (origin !== null) {
    const parsed = parseRemoteUrl(origin)
    if (parsed?.https) return { mode: 'remote', name: 'origin' }
    if (parsed) {
      // ssh origin: rewrite to the project's https URL on the fly
      if (project === undefined) project = parsed.path
      return { mode: 'url', url: projectHttpUrl(baseUrl, project) }
    }
    if (project !== undefined) return { mode: 'url', url: projectHttpUrl(baseUrl, project) }
    throw new GitlabError('gitlab/git-failed', `origin remote ${origin} is neither https nor a parsable ssh URL; pass the 'project' argument so the plugin can target the https remote.`)
  }
  if (project !== undefined) return { mode: 'url', url: projectHttpUrl(baseUrl, project) }
  throw new GitlabError('gitlab/git-failed', 'Repository has no origin remote; pass the \'project\' argument (namespace/path).')
}

/**
 * Resolve a repo path argument against the session policy's workspace root
 * (the directory the calling session's sandbox treats as its workspace).
 */
export function resolveRepoPath(candidate, policy) {
  return resolve(policy.workspaceRoot, String(candidate ?? '.'))
}
