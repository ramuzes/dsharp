/**
 * Outbound formatting: the fallback chain (markdown → post `md` tag → stripped
 * text), size-aware chunking, and the v1 card builders (interactive JSON 1.0).
 */

const MD_HINT = /(^|\n)#{1,6} |\*\*|`{1,3}|(^|\n)[-*>+] |(\[.+\]\(.+\))|(^|\n)\|/

/** True when the text carries markdown the post `md` tag can render. */
export function hasMarkdown(text) { return MD_HINT.test(text) }

/** Strip common markdown to plain text (the last-resort fallback). */
export function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?|```/g, ''))
    .replace(/(^|\n)#{1,6} /g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|\n)[-*>+] /g, '$1')
}

/**
 * Split text into chunks no longer than limit, preferring line boundaries and
 * falling back to a hard split for a single overlong line. join('\n') of the
 * chunks is not guaranteed byte-identical to the input when hard splits occur,
 * so prefer line boundaries: they apply whenever any newline exists in range.
 */
export function chunkText(text, limit) {
  if (text.length <= limit) return [text]
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** Wrap markdown in a zh_cn post payload using the `md` tag. */
export function buildPostContent(text) {
  return { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } }
}

/**
 * Send text through the fallback chain: markdown chunks go post(md)-first and
 * fall back to stripped plain text per chunk when the post send is rejected;
 * after the plain-text safety net, one best-effort post retry with the
 * stripped content restores rich rendering when the failure was transient
 * (e.g. 230025 content too large on the md-rich body).
 * @param {{ sendText: Function, sendJson: Function }} client
 */
export async function formatAndSendText(client, chatId, text, { chunkLimit = 8000 } = {}) {
  const md = hasMarkdown(text)
  const chunks = chunkText(text, chunkLimit)
  for (const chunk of chunks) {
    if (md) {
      try { await client.sendJson(chatId, 'post', buildPostContent(chunk)); continue }
      catch { /* fall through to stripped text */ }
      const plain = stripMarkdown(chunk)
      await client.sendText(chatId, plain)
      try { await client.sendJson(chatId, 'post', buildPostContent(plain)) } catch { /* text already delivered */ }
    } else {
      await client.sendText(chatId, chunk)
    }
  }
}

// --- interactive card JSON 1.0 helpers ---

function mdElement(markdown) { return { tag: 'div', text: { tag: 'lark_md', content: markdown } } }

function button(text, value, style = 'default') {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type: style, value }
}

function card(headerTitle, elements) {
  return { config: { update_multi: true }, header: { title: { tag: 'plain_text', content: headerTitle }, template: 'blue' }, elements }
}

/** Current-binding status card. */
export function buildStatusCard(state) {
  const lines = [
    `**工作区**：${state.workspaceTitle}（\`${state.workspacePath}\`）`,
    `**会话**：${state.sessionTitle}（\`${state.sessionId}\`）`,
    `**模型**：${state.model}${state.modelPending ? '（下一回合生效）' : ''}`,
    `**状态**：${state.running ? '运行中 🟢' : '空闲 ⚪'}`,
  ]
  return card('dsh 当前状态', [mdElement(lines.join('\n'))])
}

/** Structured-question card: one button per option. */
export function buildQuestionCard(question, actionId) {
  const elements = [mdElement(question.question)]
  const buttons = (question.options ?? []).map((opt, i) =>
    button(opt.label, { actionId, kind: 'answer', questionId: question.id, choice: i }))
  elements.push({ tag: 'action', actions: buttons })
  if (question.multi_select) {
    elements.push(mdElement('（多选：请直接回复文字，如 `1,2`）'))
  }
  return card(question.header ?? '需要你的决策', elements)
}

/** Permission-approval card aligned with DSH ApprovalOutcome semantics. */
export function buildApprovalCard(prompt, actionId) {
  const outcomes = [
    ['允许一次', 'allow-once', 'primary'],
    ['本会话允许', 'allow-session', 'default'],
    ['总是允许', 'allow-always', 'default'],
    ['拒绝', 'deny', 'danger'],
  ]
  return card('权限请求', [
    mdElement(prompt),
    { tag: 'action', actions: outcomes.map(([label, outcome, style]) => button(label, { actionId, kind: 'approval', outcome }, style)) },
  ])
}

/** End-of-turn workspace changes summary with per-file diff buttons. */
export function renderChangesCard(summary, makeActionId) {
  const fileLines = (summary.files ?? []).map(f =>
    `\`${f.path}\` +${f.added ?? 0} / -${f.deleted ?? 0}`)
  const elements = [
    mdElement([`第 ${summary.turn} 回合改动：${summary.files?.length ?? 0} 个文件，+${summary.added ?? 0} / -${summary.deleted ?? 0}`,
      ...fileLines].join('\n')),
    { tag: 'action', actions: (summary.files ?? []).map(f =>
      button(`diff ${f.path}`, { actionId: makeActionId(f.path), kind: 'diff', path: f.path })) },
    { tag: 'hr' },
  ]
  return card('改动摘要', elements)
}

/** One file's unified diff as a post message with a fenced code block. */
export function renderDiffMessage(path, diff) {
  return buildPostContent(`**${path}**\n\`\`\`diff\n${diff}\n\`\`\``)
}
