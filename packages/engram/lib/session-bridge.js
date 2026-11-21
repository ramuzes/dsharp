/*
 * Session bridge (Task 6): DSH agent lifecycles -> engram sessions.
 *
 * DSH interface facts (verified in source, this repo's convention):
 *  - `agent/created` is dispatched serially on the registry's carrier with
 *    payload { agent, source, signal? } — dsh
 *    packages/core/agent/src/runtime-types.ts:291 and the emit site
 *    packages/core/agent/src/index.ts:575
 *    (`await this.ctx.serial(entry.carrier, 'agent/created', {...})`).
 *    NOTE: the payload is an object, so the listener destructures `{ agent }`
 *    (controller pre-approved this deviation from the brief's `agent => ...`).
 *  - `ctx.effect(fn)` registers a lifecycle effect on the fiber; the disposer
 *    returned by the effect body runs on fiber disposal (cordis
 *    vendor/cordis/lib/index.js:487, vendor/cordis/lib/types/fiber.d.ts:58-62:
 *    "Disposers run in reverse registration order when the owning fiber
 *    unloads"). Registering on `agent.ctx` therefore pairs session `end`
 *    with agent disposal.
 *
 * Engram API mirrored (real daemon):
 *  - POST /sessions { id, project, ownership_mode, resume } -> 201
 *    { id, status: 'created' } (create-or-renew, idempotent).
 *  - POST /sessions/{id}/end body {} -> 2xx.
 *
 * Containment: every bridge failure is caught and routed to `note`; nothing
 * ever throws into the host — a broken daemon must not block the agent.
 */

const RENEW_TTL_MS = 4 * 60 * 1000 // ensureSession debounce window

/**
 * deps:
 *  - client: { get, post, del } (Task 2).
 *  - resolveProject: (agent) => Promise<{ project, source }> — ASYNC; the
 *    Task 4 resolver's contract. Task 8's wiring adapts the session-keyed
 *    resolver: `resolveProject: (agent) => resolver.resolve(agent?.session)`.
 *  - note: (message) => void, containment sink.
 *  - sessionIdOf: (agent) => string.
 *  - now: () => number, injectable clock for the renewal TTL.
 */
export function registerSessionBridge(rootCtx, deps) {
  const {
    client,
    resolveProject,
    note,
    sessionIdOf = (agent) => agent?.session?.id ?? '',
    now = () => Date.now(),
  } = deps

  // Sessions we registered or renewed, keyed by engram session id
  // ('dsh-' + dsh session id). dispose() ends each one, contained.
  const live = new Map()
  // agent key -> last successful registration timestamp (ms clock).
  const lastSuccess = new Map()
  const disposers = []

  /**
   * Perform one registration (create-or-renew). Resolves true on success.
   * All failures are contained: note + false; never throws.
   */
  async function registerSession(agent) {
    const dshSessionId = sessionIdOf(agent)
    if (!dshSessionId) {
      note('bridge-no-session-id')
      return false
    }
    const id = 'dsh-' + dshSessionId
    // The resolver is ASYNC (Task 4: `async resolve(session, explicit?)`
    // returns a Promise<{ project, source }>). It must be awaited inside the
    // try/catch — both to get the real project (a sync read would POST
    // `project: undefined`) and so a rejected promise is caught here instead
    // of escaping as an unhandled rejection into the host.
    let project
    try {
      // Task 8's wiring adapts the session-keyed resolver:
      // `resolveProject: (agent) => resolver.resolve(agent?.session)`.
      const resolved = await resolveProject(agent)
      project = resolved.project
    } catch {
      // Unresolved project (ambiguous / explicit required / daemon error):
      // no POST, surface via note, keep the agent unblocked.
      note('bridge-unresolved-project')
      return false
    }
    try {
      const res = await client.post('/sessions', {
        id,
        project,
        ownership_mode: 'project_owned',
        resume: true,
      })
      if (res && typeof res.status === 'number' && res.status >= 400) {
        note('bridge-register-failed:' + res.status)
        return false
      }
      live.set(id, { agent })
      lastSuccess.set(dshSessionId, now())
      return true
    } catch (err) {
      note('bridge-register-failed:' + (err?.message ?? String(err)))
      return false
    }
  }

  /**
   * Register immediately when an agent appears; pair `end` with agent
   * disposal through agent.ctx.effect (cordis runs the returned disposer on
   * fiber unload).
   */
  function onAgentCreated({ agent }) {
    try {
      const dispose = agent.ctx.effect(() => {
        // Fire-and-forget on purpose: the serial agent/created dispatch must
        // not wait on the daemon; failures are contained inside
        // registerSession and re-checked via ensureSession on first save.
        registerSession(agent)
        const dshSessionId = sessionIdOf(agent)
        const id = 'dsh-' + dshSessionId
        // Teardown runs on agent fiber disposal (cordis effect semantics).
        return () => endSession(id)
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) {
      // Even wiring must not break the host (e.g. inactive agent ctx).
      note('bridge-wire-failed:' + (err?.message ?? String(err)))
    }
  }

  /**
   * Contained session end: POST /sessions/{id}/end with empty body.
   * Never throws; failures only note.
   */
  async function endSession(id) {
    try {
      const res = await client.post(`/sessions/${id}/end`, {})
      if (res && typeof res.status === 'number' && res.status >= 400) {
        note('bridge-end-failed:' + res.status)
      }
    } catch (err) {
      note('bridge-end-failed:' + (err?.message ?? String(err)))
    } finally {
      live.delete(id)
    }
  }

  /**
   * Called by engram_save before a write: re-POST if this agent has no
   * successful registration within the TTL window. No-op within 4 minutes
   * of the last success. Contained.
   */
  async function ensureSession(agent) {
    const dshSessionId = sessionIdOf(agent)
    if (!dshSessionId) {
      note('bridge-no-session-id')
      return
    }
    const ts = lastSuccess.get(dshSessionId)
    if (typeof ts === 'number' && now() - ts < RENEW_TTL_MS) return
    await registerSession(agent)
  }

  const offCreated = rootCtx.on('agent/created', onAgentCreated)
  disposers.push(offCreated)

  /**
   * Bridge teardown (plugin unload): end every session still marked live.
   * Contained — a failing end never blocks unloading.
   */
  async function dispose() {
    for (const disposer of disposers.splice(0).reverse()) {
      try {
        const r = disposer()
        if (r && typeof r.then === 'function') await r
      } catch (err) {
        note('bridge-dispose-failed:' + (err?.message ?? String(err)))
      }
    }
    for (const id of [...live.keys()]) await endSession(id)
    lastSuccess.clear()
  }

  return { dispose, ensureSession }
}
