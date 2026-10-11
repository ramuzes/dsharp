// lib/commands.js
/**
 * Slash-command parsing and the Switch Guard decision/translation helpers.
 * Pure logic: execution lives in the driver.
 */

const COMMANDS = new Set(['ws', 'session', 'model', 'status', 'stop', 'doctor', 'help'])

/** Commands that take a named subcommand (/ws, /session); the rest treat tokens as args. */
const SUBCOMMANDS = new Set(['ws', 'session'])

/**
 * Parse one inbound text as a gateway command.
 * @returns {{ name: string, sub: string | undefined, args: string[] } | null}
 */
export function parseCommand(text, prefix = '/') {
  if (typeof text !== 'string' || !text.startsWith(prefix)) return null
  const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean)
  const [name, ...rest] = parts
  if (name === undefined || !COMMANDS.has(name)) return null
  if (SUBCOMMANDS.has(name)) {
    const [sub, ...args] = rest
    return { name, sub, args }
  }
  return { name, sub: undefined, args: rest }
}

/** Switch Guard: mutations require the target session to be idle. */
export function guardDecision({ running }) {
  if (running === true) {
    return { allowed: false, reason: '会话运行中：请先 /stop 打断当前回合，或等它完成后再切换。' }
  }
  return { allowed: true }
}

/** Map DSH single-writer errors to a friendly chat message. */
export function translateGuardError(error) {
  const text = `${error?.rpcError?.code ?? ''} ${error?.message ?? String(error)}`
  if (text.includes('writer-held') || text.includes('agent-busy')) {
    return '会话正被占用（可能在运行中）：请先 /stop 或稍后重试。'
  }
  return error?.message ?? String(error)
}

export const HELP_TEXT = [
  '/ws list — 列出所有工作区',
  '/ws use <名称> — 切换绑定的工作区',
  '/ws new <路径> [标题] — 注册新工作区并绑定',
  '/session new — 在当前工作区开新会话',
  '/session list [页码] — 工作区全部会话（时间倒序，10/页，可点按钮恢复）',
  '/session resume — 从会话历史中恢复',
  '/session resume <sessionId|序号> — 直接恢复指定会话',
  '/stop — 打断当前回合',
  '/model — 查看或选择模型',
  '/status — 显示当前状态卡',
  '/doctor — 网关自检（凭证/连接/事件/绑定）',
  '/help — 本帮助',
].join('\n')
