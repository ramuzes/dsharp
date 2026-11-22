/**
 * Model-assisted template drafting over one reusable draft session per
 * workspace (ADR-0010). Pure meta-prompt/parse/extract helpers plus the
 * `runDraft` orchestrator the `agentRoster.draft` remote calls. Drafts are
 * PROPOSALS: nothing here ever writes a template — the user saves (or drops)
 * the parsed result in the modal.
 *
 * Every host interface below was verified against the dsh source
 * (/home/ramuz/deepseek-harness, AGENTS.md 2b: the source is the single
 * source of truth for in-process consumers):
 *
 * - `sessionController.resolveAgent(sessionId)` returns `{ agent }` or
 *   `{ error: RemoteError<'session/not-found'|...> }`
 *   (packages/api/session-controller/src/agent.ts:87-92). The schedule
 *   precedent rethrows `resolved.error` as-is
 *   (packages/schedule/schedule/src/index.ts:250-257) — followed verbatim for
 *   both the requesting session and the draft session.
 * - The requesting session's workspace directory is
 *   `agent.session.header.cwd` (Session header creation metadata, core
 *   session src/index.ts:567; the session-controller itself reads
 *   `agent.session.header.cwd`, agent.ts:303,340). Undefined when the session
 *   was created without a cwd — surfaced as a typed bad request, not a guess.
 * - `sessionController.create({ sessionId, cwd })` mints an ordinary Session
 *   and returns `{ sessionId }` — the authoritative identity, which may
 *   reuse a named blank session (commands.ts:120-158, types.ts:272-277).
 *   schedule's createAgent does exactly this shape
 *   (packages/schedule/schedule/src/runtime.ts:471-486) with a
 *   `session-${randomUUID()}` id (runtime.ts:442) — the id shape used here.
 * - `sessionTitle.get(session)` returns undefined while untitled;
 *   `rename(session, title)` pins a user title no automatic revision may
 *   override (packages/session/session-title/src/index.ts:393-427, :516-517).
 *   schedule's nameSession pins only when untitled and treats a rename
 *   failure as non-fatal (runtime.ts:494-501) — both followed.
 * - `agent.followup(message)` queues one ordinary follow-up turn and wakes
 *   the driver (core/agent src/runtime-types.ts:246-252);
 *   `createUserMessage` from `@deepseek-ai/dsh-llm` builds the identified
 *   immutable user message (schedule runtime.ts:3, 353-363 — the exact
 *   delivery pattern: followup(createUserMessage(...)) then
 *   `await sessions.flush(agent.session)`).
 * - `source.kind` choice (plan instruction, verified BEFORE wiring): the
 *   installed @deepseek-ai/dsh-llm 0.0.1-rc.1 MessageSourceMap is the closed
 *   union `user | plugin | model | tool` (lib/types/message.d.ts:94-104);
 *   the current dsh checkout keeps it merge-extensible with producer-declared
 *   kinds (core llm message.ts MessageSourceMap — schedule augments it with
 *   `'schedule'` via a TypeScript `declare module`, runtime.ts:4-8, an
 *   augmentation a plain-JS plugin cannot make). The only producer kind that
 *   is a legal user-message kind in EVERY revision is `'user'` — the closest
 *   legal user-message kind, used here deliberately.
 * - `sessions.flush(session)` is THE durability checkpoint and returns
 *   whether at least one durability listener participated
 *   (core/session src/index.ts:1410-1438); schedule throws when it does not
 *   acknowledge (runtime.ts:359-361) — translated here to
 *   `roster/draft-flush-failed`.
 * - `turn/end` carries `{ turn, reason }` with no message payload
 *   (core/session src/types.ts:299-307), so the session surface is the
 *   source of the answer: `session.deriveMessages()` yields the
 *   model-visible Message[] and the LAST assistant message's text blocks are
 *   the turn's answer — the feishu-gateway lastAssistantText port
 *   (packages/feishu-gateway/lib/driver.js:42-60).
 * - The turn wait listens on `scope.on('session/event', (session, event) =>
 *   …, { global: true })` — the GLOBAL stream, not a scoped waterfall
 *   (feishu index.js:326-331 pattern; session events dispatch through the
 *   store's carrier, core/session src/index.ts:897-906). Session events
 *   discriminate on `event.type` over `{ type, seq, time, data }`
 *   (types.ts:510-536). The disposer scope.on returns is called on EVERY
 *   settle path (success, typed failure, timeout) from a finally — and the
 *   registration itself is fiber-tracked by cordis, so disposing the plugin
 *   scope mid-draft removes the listener as well.
 * - Optional model selection: ADR-0010 consequence — the draft session is an
 *   ordinary session with its own model selection, so a cheaper model chosen
 *   in the modal rides `sessionController.selectModel({ sessionId,
 *   provider, model, reasoningEffort? })`, the sanctioned Remote surface the
 *   Web GUI uses (session-controller src/index.ts:289-292, ModelSelection at
 *   types.ts:83-87). `null` / omission keeps the session's own selection.
 */
import { randomUUID } from 'node:crypto'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readString } from './wire.js'
import { ModelRef } from './store.js'

/** Turn budget for one draft (plan constant): 180 seconds. */
export const DRAFT_TIMEOUT_MS = 180_000

/** Fixed title pinning the draft session row in the session list. */
export const DRAFT_SESSION_TITLE = 'Agent roster drafter'

/**
 * Build the drafting meta-prompt for one brief (plan contract, verbatim
 * content requirements): the model returns ONLY a JSON object with string
 * fields name (2–4 words) / description (one line) / prompt (full standing
 * prompt as instructions to the agent itself), all values in the language of
 * the brief, no markdown fences, no commentary.
 * @param {unknown} brief - the user's authoring brief (defensively coerced).
 * @returns {string}
 */
export function buildMetaPrompt(brief) {
  const text = readString(brief)
  return [
    'You are drafting a roster member definition from the brief below.',
    '',
    'Return ONLY a JSON object — no markdown code fences, no commentary, and nothing before or after the object — with exactly these string fields:',
    '- "name": the member\'s display name, 2–4 words.',
    '- "description": a one-line description of what the member is for.',
    '- "prompt": the member\'s full standing prompt — its duties, working rules, constraints, and output expectations — written as instructions addressed to the agent itself ("You ...").',
    '',
    'Write every field value in the same language as the brief.',
    '',
    'Brief:',
    text,
  ].join('\n')
}

/**
 * Parse the drafter's answer. The FIRST `{...}` block is JSON.parse'd;
 * anything else — no block, invalid JSON, or a parse whose fields are not
 * the three promised strings — is a parse failure: the whole text becomes
 * `prompt` with empty `name`/`description` and `parsed: false` (the caller
 * then hands the raw text to the user for manual authoring). The
 * strings-only acceptance is this module's own boundary assertion: the
 * return type promises three strings, so a JSON array or a missing field is
 * a failed parse, not a half-filled draft.
 * @param {unknown} text - the assistant turn text (defensively coerced).
 * @returns {{ name: string, description: string, prompt: string, parsed: boolean }}
 */
export function parseDraft(text) {
  const raw = typeof text === 'string' ? text : ''
  const start = raw.indexOf('{')
  if (start !== -1) {
    // Locate the close of the FIRST block, honoring braces inside JSON
    // strings so a description like "uses {braces}" cannot cut the block.
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = start; i < raw.length && end === -1; i++) {
      const ch = raw[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) end = i
      }
    }
    if (end !== -1) {
      try {
        const value = JSON.parse(raw.slice(start, end + 1))
        if (isDraftShape(value)) {
          return { name: value.name, description: value.description, prompt: value.prompt, parsed: true }
        }
      } catch {
        // Fall through to the raw-text fallback.
      }
    }
  }
  return { name: '', description: '', prompt: raw, parsed: false }
}

/** Whether a parsed value carries the three promised string fields. */
const isDraftShape = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  && typeof value.name === 'string'
  && typeof value.description === 'string'
  && typeof value.prompt === 'string'

/**
 * The final assistant text of a turn, read from the session surface:
 * deriveMessages() returns the model-visible Message[] in order, so the last
 * assistant message's text blocks are the turn's answer. `turn/end` carries
 * only { turn, reason } — no message payload — so the session is the source.
 * Graceful '' when the surface is unavailable or holds no assistant message.
 * Port of packages/feishu-gateway/lib/driver.js:42-60.
 * @param {{ deriveMessages?: () => unknown }} [session]
 * @returns {string}
 */
export function lastAssistantText(session) {
  const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : undefined
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    return (message.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')
  }
  return ''
}

/**
 * Resolve one optional host service: the deps bag wins, then the scope's
 * sanctioned name lookup (`scope.get(name)` returns undefined when the
 * service is absent — the same optional-service rule lib/store.js uses for
 * storageDomain). Absence is the CALLER's typed-error decision, not a crash.
 * @param {object} [scope] - plugin ctx or inject scope.
 * @param {object} [deps] - explicit service bag (test seam / DI).
 * @param {string} name - service name.
 */
const service = (scope, deps, name) => (deps?.[name] !== undefined ? deps[name] : scope?.get?.(name))

/**
 * Run one AI-assisted draft (ADR-0010 lifecycle): resolve the requesting
 * session's workspace, ensure the per-cwd draft session (created once, title
 * pinned once), deliver the meta-prompt as an ordinary follow-up turn, await
 * durable flush then `turn/end`, and return the parsed draft. Nothing is
 * saved — the result is a proposal for the modal.
 *
 * @param {object} scope - plugin ctx; its get() name lookup and on() event
 *   registration are the only members touched.
 * @param {{ store: object, sessionController?: object, sessions?: object, sessionTitle?: object }} deps
 *   - the roster store (required) and optional host services.
 * @param {{ sessionId: string, brief: string, model?: import('./store.js').ModelRef | null }} input
 *   - the requesting session, the authoring brief, and an optional cheaper
 *     model for the draft session (ADR-0010; `null` keeps the session's own).
 * @param {number} [timeoutMs] - turn budget, default {@link DRAFT_TIMEOUT_MS}.
 * @returns {Promise<{ name: string, description: string, prompt: string, parsed: boolean }>}
 * @throws {RemoteError} `roster/bad-request`, `roster/no-session-controller`,
 *   `roster/no-sessions`, `roster/draft-flush-failed`,
 *   `roster/draft-timeout`; the session's own typed error when either
 *   session cannot be resolved.
 */
export async function runDraft(scope, deps, input, timeoutMs = DRAFT_TIMEOUT_MS) {
  const store = deps?.store
  if (store === undefined) throw new Error('runDraft: the roster store is required')
  const sessionController = service(scope, deps, 'sessionController')
  const sessions = service(scope, deps, 'sessions')
  if (sessionController === undefined) {
    throw new RemoteError('roster/no-session-controller',
      'sessionController is unavailable — cannot draft without session routing / sessionController 不可用，无法进行草稿生成')
  }
  if (sessions === undefined) {
    throw new RemoteError('roster/no-sessions',
      'sessions service is unavailable — cannot flush the draft delivery / sessions 服务不可用，无法确认草稿消息')
  }

  const sessionId = readString(input?.sessionId)
  const brief = readString(input?.brief)
  if (sessionId === '') {
    throw new RemoteError('roster/bad-request', 'sessionId is required / sessionId 不能为空', { field: 'sessionId' })
  }
  if (brief === '') {
    throw new RemoteError('roster/bad-request', 'brief is required / brief 不能为空', { field: 'brief' })
  }

  // Optional cheaper model for the draft turn (file header, ADR-0010).
  /** @type {{ provider: string, model: string, reasoningEffort?: string } | null} */
  let model = null
  if (input?.model !== undefined && input?.model !== null) {
    const parsed = ModelRef.safeParse(input.model)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      throw new RemoteError('roster/bad-request',
        `model rejected / 模型不合法: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, { issues })
    }
    model = parsed.data
  }

  // Resolve the REQUESTING session's live Agent and take its workspace
  // directory. A typed session error rethrows as-is (schedule precedent).
  // Direct member access throughout: resolveAgent's success arm always
  // carries the agent (agent.ts:90-92), an Agent always exposes its live
  // session (runtime-types.ts:194-195), and a Session always carries a
  // header (core session index.ts) — though header.cwd is legitimately
  // undefined for a session created without one.
  const requesting = await sessionController.resolveAgent(sessionId)
  if ('error' in requesting) throw requesting.error
  const cwd = requesting.agent.session.header.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new RemoteError('roster/bad-request',
      'the requesting session has no working directory — cannot place a draft session / 请求会话没有工作目录，无法放置草稿会话', { field: 'sessionId' })
  }

  // Ensure the per-workspace draft session: reuse the stored pointer, or
  // create once and persist the pointer. The created identity is
  // authoritative (blank-session reuse may rename it, commands.ts:133-158).
  let record = await store.draftSessionFor(cwd)
  if (record === undefined) {
    const created = await sessionController.create({ sessionId: `session-${randomUUID()}`, cwd })
    record = { cwd, sessionId: created.sessionId, createdAt: new Date().toISOString() }
    await store.putDraftSession(record)
  }

  // The draft session's live Agent (create has just resumed it).
  const draft = await sessionController.resolveAgent(record.sessionId)
  if ('error' in draft) throw draft.error
  const agent = draft.agent

  // Pin the fixed title once, only while untitled (schedule nameSession,
  // runtime.ts:494-501): a pinned user title is never revised automatically
  // (session-title :516-517), and a rename failure never stops the draft.
  const sessionTitle = service(scope, deps, 'sessionTitle')
  if (sessionTitle !== undefined && sessionTitle.get(agent.session) === undefined) {
    try {
      sessionTitle.rename(agent.session, DRAFT_SESSION_TITLE)
    } catch {
      // Best effort, schedule precedent: naming must not block delivery.
    }
  }

  // Apply the optional model choice BEFORE the turn (selectModel resumes the
  // session itself; a selection failure is the caller's typed error).
  if (model !== null) {
    await sessionController.selectModel({
      sessionId: record.sessionId,
      provider: model.provider,
      model: model.model,
      ...(typeof model.reasoningEffort === 'string' && model.reasoningEffort !== ''
        ? { reasoningEffort: model.reasoningEffort }
        : {}),
    })
  }

  // Subscribe BEFORE the delivery: a fast agent can end its turn before the
  // awaited flush settles, and the global stream is the sanctioned channel
  // (feishu index.js:326-331). The turn/end event carries no payload — the
  // live session surface supplies the answer afterwards.
  let resolveTurnEnd
  const turnEnd = new Promise((resolve) => { resolveTurnEnd = resolve })
  const off = scope.on('session/event', (session, event) => {
    if (session?.id === record.sessionId && event?.type === 'turn/end') resolveTurnEnd()
  }, { global: true })
  try {
    // schedule delivery pattern, verbatim (runtime.ts:353-363):
    // followup(createUserMessage(...)) then await sessions.flush(agent.session).
    const message = createUserMessage({
      content: [{ type: 'text', text: buildMetaPrompt(brief) }],
      source: { kind: 'user' },
    })
    agent.followup(message)
    let flushed
    try {
      flushed = await sessions.flush(agent.session)
    } catch (error) {
      throw new RemoteError('roster/draft-flush-failed',
        `Session persistence rejected the draft delivery / 会话持久化拒绝草稿消息: ${String(error?.message ?? error)}`,
        { sessionId: record.sessionId })
    }
    if (flushed !== true) {
      throw new RemoteError('roster/draft-flush-failed',
        'Session persistence did not acknowledge the draft delivery / 会话持久化未确认草稿消息', { sessionId: record.sessionId })
    }

    // Turn budget (plan constant): reject roster/draft-timeout when the turn
    // never ends. The timer never holds the host open (unref), and the
    // listener is removed on EVERY settle path by the finally below.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RemoteError('roster/draft-timeout',
          `The draft turn did not finish within ${String(timeoutMs)} ms / 草稿生成未在 ${String(timeoutMs)} ms 内完成`,
          { sessionId: record.sessionId }))
      }, timeoutMs)
      timer.unref?.()
      turnEnd.then(() => { clearTimeout(timer); resolve(undefined) })
    })

    return parseDraft(lastAssistantText(agent.session))
  } finally {
    off()
  }
}
