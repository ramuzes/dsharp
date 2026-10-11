// lib/router.js
/**
 * The chat → workspace + active-session binding store (the SPEC's Binding).
 * Switching is pointer movement: the demoted session goes to the head of a
 * capped history so /session resume can offer it back.
 */

const HISTORY_LIMIT = 10

export class BindingRouter {
  /** @param {{ persist?: { load(): Promise<any>, save(state: any): Promise<void> } }} [options] */
  constructor({ persist } = {}) {
    this.persist = persist ?? {
      load: async () => undefined,
      save: async () => {},
    }
    /** @type {Map<string, any>} */
    this.bindings = new Map()
  }

  async load() {
    const state = await this.persist.load()
    if (Array.isArray(state)) {
      for (const b of state) if (b?.chatId) this.bindings.set(b.chatId, b)
    }
  }

  async save() {
    await this.persist.save([...this.bindings.values()])
  }

  /** The binding for one chat, or undefined. */
  async get(chatId) { return this.bindings.get(chatId) }

  /** Create or replace the workspace binding of one chat. */
  async bind(chatId, { workspaceId, workspaceTitle, workspacePath }) {
    const existing = this.bindings.get(chatId)
    // Omit absent optional keys instead of writing undefined: the JSON store
    // drops undefined anyway, and an explicit undefined would resurface as a
    // missing required key if the schema ever regressed.
    this.bindings.set(chatId, {
      chatId,
      workspaceId,
      workspaceTitle,
      workspacePath,
      sessionHistory: existing?.sessionHistory ?? [],
      updatedAt: Date.now(),
    })
    await this.save()
  }

  /** Point the chat's Active Session at sessionId; demote the old one into history. */
  async setActive(chatId, sessionId, sessionTitle) {
    const binding = this.bindings.get(chatId)
    if (binding === undefined) throw new Error(`no binding for chat ${chatId}`)
    const history = binding.sessionHistory.filter(e => e.sessionId !== sessionId)
    if (binding.activeSessionId !== undefined && binding.activeSessionId !== sessionId) {
      history.unshift({ sessionId: binding.activeSessionId, title: binding.activeSessionTitle ?? binding.activeSessionId })
    }
    binding.activeSessionId = sessionId
    binding.activeSessionTitle = sessionTitle
    binding.sessionHistory = history.slice(0, HISTORY_LIMIT)
    binding.updatedAt = Date.now()
    await this.save()
  }

  /** Session history for /session resume, most recent first. */
  async history(chatId) { return this.bindings.get(chatId)?.sessionHistory ?? [] }

  /**
   * The chat whose Active Session is sessionId, or undefined. The answerer's
   * load-bearing feishu routing path: the host exposes no per-session source
   * field, so our own durable bindings decide which questions round-trip.
   */
  chatForSession(sessionId) {
    for (const binding of this.bindings.values()) {
      if (binding.activeSessionId === sessionId) return binding.chatId
    }
    return undefined
  }
}
