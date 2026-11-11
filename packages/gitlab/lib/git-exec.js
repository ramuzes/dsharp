/**
 * Host-side git runner for the GitLab plugin.
 *
 * Every git command the agent asks for runs in the HOST process (not the
 * sandboxed session shell), so network access to GitLab needs no per-call
 * approval. Credentials ride a per-invocation
 * `-c http.extraHeader="Authorization: Basic base64(oauth2:<token>)"` —
 * documented GitLab PAT transport for git over HTTPS — which keeps the
 * repository config clean (no token in remotes, hooks, or on-disk config)
 * and confines the secret to the short-lived argv of the host process.
 * Captured stdout/stderr is redacted against both the raw token and its
 * base64 form before anything returns to a tool result.
 *
 * Filesystem reach is restricted to the configured workspace roots: any
 * resolved repo path outside them is refused (gitlab/path-outside-workspace).
 */
import { spawn } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { GitlabError, redact } from './gitlab-api.js'

/** Resolve `candidate` against `cwd` and require it inside one of `roots`. */
export function resolveInsideRoots(candidate, roots) {
  const list = (roots ?? []).map((r) => resolve(String(r)))
  const abs = resolve(String(candidate ?? '.'))
  const ok = list.some((root) => abs === root || abs.startsWith(root + sep))
  if (!ok) {
    throw new GitlabError(
      'gitlab/path-outside-workspace',
      `Path ${abs} is outside the allowed workspace roots (${list.join(', ') || 'none configured'}). Git operations are restricted to the session workspace.`,
    )
  }
  return abs
}

/** Build the Basic auth extraHeader value for `git -c http.extraHeader=...`. */
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
 * @param {Function} run - raw runner (args, cwd) => {stdout, stderr} WITHOUT auth header.
 */
export async function readOriginRemote(run, repoDir) {
  const { stdout } = await run(['config', '--get', 'remote.origin.url'], repoDir)
  const url = String(stdout ?? '').trim()
  return url === '' ? null : url
}

/**
 * Spawn `git` and capture output. `token` (when provided) adds the Basic
 * auth extraHeader and redacts both the raw and base64 forms from output.
 * @param {string[]} args - git arguments.
 * @param {{ cwd?: string, token?: string, timeoutMs?: number, env?: object, gitBin?: string }} options
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function runGit(args, { cwd, token = '', timeoutMs = 120_000, env, gitBin = 'git' } = {}) {
  return new Promise((resolve_, reject) => {
    const fullArgs = token === '' ? args : ['-c', `http.extraHeader=${buildAuthHeader(token)}`, ...args]
    const child = spawn(gitBin, fullArgs, {
      cwd,
      env: env === undefined ? process.env : env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new GitlabError('gitlab/git-failed', `cannot spawn git: ${error?.message ?? error}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const out = redact(stdout, token)
      const err = redact(stderr, token)
      if (code === 0) resolve_({ stdout: out, stderr: err })
      else {
        const first = err.split('\n').filter((l) => l.trim() !== '').slice(-5).join('\n')
        reject(new GitlabError('gitlab/git-failed', `git ${args[0]} exited ${code}:\n${first || out.slice(0, 300)}`))
      }
    })
  })
}

/**
 * Compose the fetch/push target for a repo: prefer the configured `origin`
 * remote when it is an http(s) URL on the configured instance; otherwise
 * (ssh origin, or no remote and a `project` argument was given) fall back to
 * the explicit project URL with remote-tracking refspec handling done by the
 * caller. SSH-only origins are refused with a hint, per the plugin's
 * HTTP(S)-only transport decision.
 * @returns {Promise<{ mode: 'remote', name: 'origin' } | { mode: 'url', url: string }>}
 */
export async function resolveFetchTarget({ run, repoDir, baseUrl, project, token }) {
  const origin = await readOriginRemote(run, repoDir)
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

/** The [view] of runGit the higher-level helpers pass around (bound runner). */
export function makeRunner({ timeoutMs }) {
  const run = (args, cwd) => runGit(args, { cwd, timeoutMs })
  /** Authenticated runner used for network-facing commands. */
  const runAuthed = (args, cwd, token) => runGit(args, { cwd, token, timeoutMs })
  return { run, runAuthed }
}
