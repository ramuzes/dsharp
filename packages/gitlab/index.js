/**
 * dsh-gitlab — Host half.
 *
 * One contribution: explicitly named GitLab tools for agents — REST API
 * operations plus git clone/fetch/push/pull — executed in the Host process
 * with the configured GitLab token. This is what removes the per-call
 * sandbox approval friction of running glab or credentialed git inside the
 * session shell: the token never leaves the Host process (credential store
 * first, GITLAB_TOKEN launch env as headless fallback), never rides a tool
 * result, and every captured git/API output is redacted against it.
 *
 * Git processes follow the CALLING session's own sandbox policy — resolved
 * per call through ctx.sandboxPolicy and enforced by ctx.sandbox.confine,
 * the same confinement the bash tool runs under. The plugin keeps NO
 * permission system of its own; remote transport is HTTPS only, with the
 * token injected per-invocation as a Basic auth extraHeader via
 * GIT_CONFIG_KEY_n environment entries (see lib/git-exec.js).
 *
 * Branch deletion is merged-only by design: local deletes go through
 * `git branch -d`, remote deletes verify via the compare API first.
 *
 * Configuration lives on the Loader row (`gitlab`), edited on the Plugins
 * page or defaulted from GITLAB_URL / GITLAB_WORKSPACE_ROOTS through the
 * bundle's patch layer; see README.md.
 */
import Schema from '@deepseek-ai/schemastery'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createGitlabClient } from './lib/gitlab-api.js'
import { makeGitRunner } from './lib/git-exec.js'
import { registerAgentTools } from './lib/agent-tools.js'

/**
 * Read a config field that the Loader may hand over as a volatile wrapper or
 * as a plain value (tests, plain mounts). The Loader hands plugin config
 * fields as schemastery reactive wrappers — objects with `.get()` — never as
 * plain strings; raw use dies with `TypeError: x.replace is not a function`.
 */
function readString(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'string' ? raw : ''
}

/** Read a volatile number field (same reactive-wrapper rule). */
function readNumber(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : NaN
}

/** Row configuration. The token is a credential (GITLAB_TOKEN by default)
 *  resolved through `ctx.credentials` — written by the Plugins-page secret
 *  control into the credential store, or supplied by the launch environment.
 *  It never lands in a patch layer. */
export const Config = Schema.object({
  // All volatile: volatile marks fields the Plugins-page form edits LIVE
  // (settings.mutate persists accepted edits into the profile patch — it is
  // not a persistence switch). An entry with no volatile field is dropped
  // from the settings document and its form shows "configuration unavailable".
  baseUrl: Schema.string().default('').volatile(),
  tokenEnv: Schema.string().role('credential-ref').default('GITLAB_TOKEN').volatile(),
  apiTimeoutMs: Schema.number().min(1000).default(20_000).volatile(),
  gitTimeoutMs: Schema.number().min(1000).default(120_000).volatile(),
})

/**
 * Resolve the GitLab token from the credential store, with the launch
 * environment as headless fallback. Exposed for tests.
 * @param {{ resolve(ref: string): Promise<{ value: string } | undefined> }} credentials - the credentials service.
 * @param {string} ref - credential reference name.
 * @param {() => string} envFallback - reads the launch env value for the ref.
 * @returns {Promise<string>} the token, or '' when nothing supplies one.
 */
export async function resolveGitlabToken(credentials, ref, envFallback) {
  const stored = await credentials?.resolve?.(ref)
  if (stored?.value !== undefined && stored.value !== '') return stored.value
  return envFallback() ?? ''
}

/**
 * Mount the agent tools. Tools register whenever the core tool/prompt
 * services run; the plugin stays inert in headless profiles without them.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ baseUrl?: unknown, tokenEnv?: unknown, apiTimeoutMs?: unknown, gitTimeoutMs?: unknown }} config - validated row config.
 */
export function apply(ctx, config) {
  const tokenEnv = readString(config.tokenEnv) || 'GITLAB_TOKEN'

  // Boot-stage observability (airboard pattern): every stage lands in
  // ~/.dsh/gitlab-status.json so a dead mount names its stage.
  const noteStage = (stage, detail) => {
    try {
      // Env-overridable so tests never touch the real file.
      const file = process.env.GITLAB_STATUS_FILE
        ?? join(homedir(), '.dsh', 'gitlab-status.json')
      writeFileSync(file,
        `${JSON.stringify({ stage, detail: detail ?? null, at: new Date().toISOString() }, null, 2)}\n`)
    } catch { /* best effort */ }
  }
  noteStage('apply')

  // 'tools', 'systemPrompt' and 'credentials' are in the inject list on
  // purpose: accessing a service on a scope that did not inject it throws in
  // cordis ("cannot get property ... without inject"). 'sandboxPolicy' +
  // 'sandbox' (packages/sandbox/sandbox-policy, packages/sandbox/sandbox)
  // put every git process under the CALLING session's own permission policy
  // — the same confinement bash uses — so the tools work in any
  // session/workspace with no static configuration of their own.
  ctx.inject(['tools', 'systemPrompt', 'credentials', 'sandboxPolicy', 'sandbox'], async (agentCtx) => {
    noteStage('tools-inject')
    let currentToken = ''
    try {
      const resolveToken = () => resolveGitlabToken(agentCtx.credentials, tokenEnv,
        () => process.env[tokenEnv] ?? '')
      currentToken = await resolveToken()
      const offTokenUpdates = agentCtx.on('credentials/reference-updated', async (ref) => {
        if (ref === tokenEnv) currentToken = await resolveToken()
      })
      // Defensive reads (volatile wrappers re-read per call so Plugins-page
      // edits apply live; the empty baseUrl surfaces as gitlab/not-configured
      // on first use instead of dying at mount).
      const getBaseUrl = () => readString(config.baseUrl)
      const getApiTimeout = () => readNumber(config.apiTimeoutMs) || 20_000
      const getGitTimeout = () => readNumber(config.gitTimeoutMs) || 120_000
      const client = createGitlabClient({
        baseUrl: getBaseUrl(),
        tokenProvider: () => currentToken,
        timeoutMs: getApiTimeout(),
      })
      // Re-point the client's baseUrl/timeout lazily: createGitlabClient
      // snapshots baseUrl, so rebuild on live config reads is not needed for
      // the token (provider), but a changed baseUrl takes effect after the
      // next plugin reload (documented in README "Reload semantics").
      const offTools = registerAgentTools(agentCtx, {
        api: client,
        baseUrl: getBaseUrl(),
        getToken: () => currentToken,
        gitTimeoutMs: getGitTimeout,
        // Per-call policy: the calling session's own sandbox configuration
        // (mode + workspace root), resolved fresh for every git invocation.
        getPolicy: (exec) => agentCtx.sandboxPolicy.resolve({ session: exec?.agent?.session }),
        gitRun: makeGitRunner({ sandbox: agentCtx.sandbox, sandboxPolicy: agentCtx.sandboxPolicy }),
      })
      noteStage('tools-registered', {
        baseUrl: getBaseUrl(),
        tokenConfigured: currentToken !== '',
      })
      return () => { offTools(); offTokenUpdates() }
    } catch (error) {
      noteStage('tools-failed', String(error))
      throw error
    }
  })
}
