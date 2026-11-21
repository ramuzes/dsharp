/*
 * Proactive context injection (Task 7): register a system-prompt section on
 * each agent that renders a compact engram project-memory summary.
 *
 * DSH interface facts (verified in source, this repo's convention):
 *  - `agent/created` is dispatched with payload { agent, source, signal? } —
 *    dsh packages/core/agent/src/runtime-types.ts:291, emit site
 *    packages/core/agent/src/index.ts:575; the listener destructures { agent }.
 *  - PromptSection.text is `string | ((context: AssembleContext) => string)`
 *    (dsh packages/core/system-prompt/lib/types/index.d.ts:60): the provider
 *    MUST return a string SYNCHRONOUSLY and receives no session identity
 *    (AssembleContext carries only { scope?, signal? }). The ONLY correct
 *    channel is therefore registering the section on the agent's own context
 *    (`agent.ctx.systemPrompt.section(...)`) and closing over the agent
 *    object. The async engram fetch runs as a contained background refresh;
 *    the sync provider reads the cache and, when stale, returns the last
 *    known text (one-step staleness) while the refresh re-populates it.
 *  - `ctx.effect(fn)` runs the body synchronously at registration and runs
 *    the returned disposer on fiber disposal (cordis vendor/cordis/lib/
 *    index.js:487, types fiber.d.ts:58-62), so the section is removed with
 *    the agent. The plugin additionally keeps that combined disposer keyed
 *    by agent (dual ownership; effect disposers belong to their fibers).
 *
 * Engram API mirrored (real daemon): GET /context with query
 * { project, compact: 'true', max_bytes } -> 200 JSON carrying a `context`
 * string; the rendered text is `"## Project memory (engram)\n" + context`.
 *
 * Containment: ANY refresh failure (disabled, resolver throw, client error,
 * non-JSON body) leaves the cache untouched and surfaces a note; the sync
 * path never throws and never awaits.
 */

const HEADER = '## Project memory (engram)\n'

/**
 * deps (brief-verbatim):
 *  - client: { get(path, query) } (Task 2) — returns the parsed JSON body
 *    directly on 2xx (lib/engram-api.js:112).
 *  - resolveProject: (agent) => Promise<{ project, source }> — Task 8's
 *    wiring adapts the session-keyed resolver:
 *    `resolveProject: (agent) => resolver.resolve(agent?.session)`.
 *  - note: (message) => void, containment sink.
 *  - getEnabled(): boolean — false means empty text and ZERO client calls.
 *  - getMaxBytes(): number — the /context max_bytes query value.
 *  - ttlMs: cache window (default 60 s).
 *  - now: () => number, injectable clock for the TTL.
 * @returns {() => void} disposer unregistering the agent/created listener.
 */
export function registerContextInjection(rootCtx, deps) {
  const {
    client,
    resolveProject,
    note,
    getEnabled,
    getMaxBytes,
    ttlMs = 60_000,
    now = Date.now,
  } = deps

  /**
   * TTL cache keyed by the AGENT OBJECT (Finding 2: `agent.session.cwd` is
   * not a live runtime field — the cwd lives on the frozen creation header
   * `session.header.cwd`, dsh packages/core/session/src/index.ts:1276, and
   * the live directory is a WorkingDirectoryService projection; one agent =
   * one session, and the resolver's own session+cwd cache handles cwd moves
   * and self-invalidates, so this module never touches cwd).
   * agent -> { project, text, at }.
   * @type {Map<object, { project: string, text: string, at: number }>}
   */
  const cache = new Map()
  // agent -> combined disposer kept by the plugin (dual ownership with the
  // agent's effect; session-bridge.js convention).
  const agentDisposers = new Map()
  // agent -> in-flight refresh promise (dedupe: a warm-up and a stale read
  // landing in the same tick must not produce two identical fetches).
  const pending = new Map()

  /**
   * Contained background refresh: resolve the project, fetch /context, and
   * update the agent's cache entry. Never throws (note + return on failure);
   * a failure leaves the previous cache entry untouched. Skipped entirely
   * when disabled so that "disabled" means ZERO client calls.
   * @param {object} agent
   */
  async function refresh(agent) {
    if (!getEnabled()) return
    const existing = pending.get(agent)
    if (existing) return existing
    const run = (async () => {
      try {
        const resolved = await resolveProject(agent)
        const project = resolved.project
        const body = await client.get('/context', {
          project,
          compact: 'true',
          max_bytes: getMaxBytes(),
        })
        const context = body && typeof body === 'object' ? body.context : undefined
        if (typeof context !== 'string') {
          note('context-injection-bad-response')
          return
        }
        cache.set(agent, { project, text: HEADER + context, at: now() })
      } catch (err) {
        // Resolver throw (ambiguous / explicit required) and client errors are
        // both contained here; nothing escapes into the host.
        note('context-injection-refresh-failed:' + (err?.message ?? String(err)))
      } finally {
        pending.delete(agent)
      }
    })()
    pending.set(agent, run)
    return run
  }

  /**
   * The SYNC section provider. Reads the cache; on a fresh hit returns the
   * cached text. On a stale or missing entry kicks one contained
   * fire-and-forget refresh and returns the stale text if present, else ''
   * (one-step staleness; the next prompt assembly sees the refreshed cache).
   * Never awaits and never throws.
   * @param {object} agent
   * @returns {string}
   */
  function readCached(agent) {
    try {
      if (!getEnabled()) return ''
      const entry = cache.get(agent)
      if (entry && now() - entry.at < ttlMs) return entry.text
      // Stale or missing: refresh in the background, serve the stale text.
      refresh(agent)
      return entry?.text ?? ''
    } catch (err) {
      // Belt-and-braces: getEnabled/getMaxBytes/now are injected callbacks —
      // a throwing one must not break prompt assembly.
      note('context-injection-read-failed:' + (err?.message ?? String(err)))
      return ''
    }
  }

  /**
   * Wire one agent: register the sync-reading section inside
   * agent.ctx.effect (removed on agent disposal), keep the combined
   * disposer, and kick one warm-up refresh so the first user turn usually
   * finds a warm cache.
   */
  function onAgentCreated({ agent }) {
    try {
      const systemPrompt = agent?.ctx?.systemPrompt
      if (!systemPrompt || typeof systemPrompt.section !== 'function') {
        note('context-injection-no-system-prompt')
        return
      }
      const dispose = agent.ctx.effect(() => {
        const disposeSection = systemPrompt.section({
          name: 'engram:memory',
          order: 2330,
          text: () => readCached(agent),
        })
        refresh(agent) // warm at registration; contained fire-and-forget
        return () => {
          if (typeof disposeSection === 'function') disposeSection()
          agentDisposers.delete(agent)
        }
      })
      if (typeof dispose === 'function') agentDisposers.set(agent, dispose)
    } catch (err) {
      // Even wiring must not break the host (e.g. inactive agent ctx).
      note('context-injection-wire-failed:' + (err?.message ?? String(err)))
    }
  }

  const offCreated = rootCtx.on('agent/created', onAgentCreated)

  /**
   * Plugin teardown: unregister the listener and drop our references.
   * (Effect disposers belong to their fibers — cordis runs each agent's
   * combined disposer on agent disposal; clearing the map here only drops
   * the plugin's retained references.)
   */
  function dispose() {
    offCreated()
    agentDisposers.clear()
    cache.clear()
  }

  return dispose
}
