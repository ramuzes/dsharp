/**
 * One-shot staged member requests (2026-11-25).
 *
 * The "+" dialog no longer injects an instruction into the conversation. It
 * stages what the user chose — template, per-spawn model, first task — through
 * the Remote, then runs `/roster`; the command handler takes the request of
 * ITS OWN session, so the free-text task never has to travel through a
 * command line and a request can never fire in a session other than the one
 * the user was looking at.
 *
 * A slot holds one request per session (the latest stage wins) and expires,
 * so a dialog that staged and never ran the command leaves nothing behind.
 */

/**
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 * @returns {{
 *   readonly size: number,
 *   peek(sessionId: string): { templateRef: string, model: object | null, task: string } | undefined,
 *   put(sessionId: string, request: { templateRef: string, model: object | null, task: string }): void,
 *   take(sessionId: string): { templateRef: string, model: object | null, task: string } | undefined,
 * }}
 */
export function createStaging({ ttlMs = 120_000, now = () => Date.now() } = {}) {
  /** sessionId -> { request, expiresAt } (ms on `now`'s clock). */
  const slots = new Map()
  // Lazy expiry: every access prunes, so an abandoned slot never fires later
  // and costs nothing beyond the next access.
  const prune = () => {
    const at = now()
    for (const [sessionId, slot] of slots) {
      if (slot.expiresAt <= at) slots.delete(sessionId)
    }
  }
  return {
    get size() {
      prune()
      return slots.size
    },
    put(sessionId, request) {
      prune()
      slots.set(sessionId, { request, expiresAt: now() + ttlMs })
    },
    /** The pending request of one session WITHOUT consuming it (expired ones read as absent). */
    peek(sessionId) {
      prune()
      return slots.get(sessionId)?.request
    },
    take(sessionId) {
      prune()
      const slot = slots.get(sessionId)
      if (slot === undefined) return undefined
      // Single use, whatever happens next: a failed run must not replay.
      slots.delete(sessionId)
      return slot.request
    },
  }
}
