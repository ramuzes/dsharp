/*
 * Proactive context injection (Task 7): register a system-prompt section on
 * each agent that renders a compact engram project-memory summary.
 *
 * DSH interface facts (verified in source, this repo's convention):
 *  - `agent/created` is dispatched with payload { agent, source, signal? } —
 *    dsh packages/core/agent/src/runtime-types.ts:291, emit site
 *    packages/core/agent/src/index.ts:575; the listener destructures { agent }.
 *  - PromptSection providers receive NO session identity: the section's
 *    `text` is a zero-arg provider (dsh packages/core/system-prompt/src —
 *    AssembleContext carries only { scope?, signal? }). The ONLY correct
 *    channel is therefore registering the section on the agent's own context
 *    (`agent.ctx.systemPrompt.section(...)`) and closing over the agent
 *    object — which is exactly what this module does.
 *  - `ctx.effect(fn)` runs the body synchronously at registration and runs
 *    the returned disposer on fiber disposal (cordis vendor/cordis/lib/
 *    index.js:487, types fiber.d.ts:58-62), so the section is removed with
 *    the agent. The plugin additionally keeps the disposer keyed by agent
 *    (dual ownership, per repo convention — same pattern as session-bridge.js).
 *
 * Engram API mirrored (real daemon): GET /context with query
 * { project, compact: 'true', max_bytes } -> 200 JSON whose body carries a
 * `context` string; the provider renders
 * `"## Project memory (engram)\n" + body.context`.
 *
 * Containment: ANY provider failure (disabled, resolver throw, client error,
 * non-JSON body) returns `''` — an empty section text contributes nothing to
 * the prompt — and surfaces a note. Nothing ever throws into prompt assembly.
 */

const HEADER = '## Project memory (engram)\n'

/**
 * deps (brief-verbatim):
 *  - client: { get(path, query) } (Task 2).
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
   * TTL cache keyed per (session id, cwd). Both parts come from the agent's
   * own session (the resolver also caches per session+cwd internally, Task 4),
   * so a working-directory change or a new session naturally misses.
   * @type {Map<string, { text: string, at: number }>}
   */
  const cache = new Map()
  // agent -> disposer kept by the plugin's own fiber (dual ownership with the
  // agent's effect; session-bridge.js convention).
  const agentDisposers = new Map()

  /**
   * One provider run for one agent. Never throws; always returns a string.
   * @param {object} agent
   * @returns {Promise<string>} section text ('' on any failure).
   */
  async function provider(agent) {
    try {
      if (!getEnabled()) return ''

      const sessionId = agent?.session?.id ?? ''
      const cwd = agent?.session?.cwd ?? ''
      const key = `${sessionId}:${cwd}`
      const ts = now()
      const hit = cache.get(key)
      if (hit && ts - hit.at < ttlMs) return hit.text

      let project
      try {
        // Async resolver: awaited inside try/catch so a rejection
        // (ProjectAmbiguousError / ProjectExplicitRequiredError / EngramError)
        // is contained here instead of escaping into prompt assembly.
        const resolved = await resolveProject(agent)
        project = resolved.project
      } catch {
        // Unresolved project: no client call, fail-open with a note.
        note('context-injection-unresolved-project')
        return ''
      }

      const body = await client.get('/context', {
        project,
        compact: 'true',
        max_bytes: getMaxBytes(),
      })
      const context = body && typeof body === 'object' ? body.context : undefined
      if (typeof context !== 'string') {
        note('context-injection-bad-response')
        return ''
      }

      const text = HEADER + context
      cache.set(key, { text, at: ts })
      return text
    } catch (err) {
      // Client error / any unexpected failure: fail-open + note, never throw.
      note('context-injection-failed:' + (err?.message ?? String(err)))
      return ''
    }
  }

  /**
   * Wire one agent: register the section inside agent.ctx.effect (removed on
   * agent disposal) and keep the disposer for the plugin's own teardown.
   */
  function onAgentCreated({ agent }) {
    try {
      const systemPrompt = agent?.ctx?.systemPrompt
      if (!systemPrompt || typeof systemPrompt.section !== 'function') {
        note('context-injection-no-system-prompt')
        return
      }
      const dispose = agent.ctx.effect(() => {
        systemPrompt.section({
          name: 'engram:memory',
          order: 2330,
          text: () => provider(agent),
        })
        return () => agentDisposers.delete(agent)
      })
      if (typeof dispose === 'function') agentDisposers.set(agent, dispose)
    } catch (err) {
      // Even wiring must not break the host (e.g. inactive agent ctx).
      note('context-injection-wire-failed:' + (err?.message ?? String(err)))
    }
  }

  const offCreated = rootCtx.on('agent/created', onAgentCreated)

  /** Plugin teardown: unregister the listener and the retained disposers. */
  function dispose() {
    offCreated()
    agentDisposers.clear()
    cache.clear()
  }

  return dispose
}
