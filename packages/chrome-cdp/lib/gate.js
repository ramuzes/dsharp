/**
 * The per-action approval gate. A global tools/pre-execute listener matches
 * the mcp__chrome-cdp__ prefix and returns {kind:'ask'} for sensitive calls;
 * the host's serviceAsk turns ask into ctx.approval.request, which the Web
 * GUI renders as Allow/Deny on the streamed tool-call card, fail-closed when
 * no approval channel is composed
 * (packages/core/tools/src/index.ts:599-612, 1517-1519, 1735-1776).
 */
export const TOOL_PREFIX = 'mcp__chrome-cdp__'
export const APPROVAL_POLICIES = ['sensitive', 'all', 'none']

/** chrome-devtools-mcp@1.9.0 tool names that never mutate browser state. */
export const DEFAULT_READ_ONLY_TOOLS = Object.freeze([
  'list_pages', 'list_network_requests', 'list_console_messages', 'list_extensions', 'list_webmcp_tools',
  'get_network_request', 'get_console_message', 'get_tab_id', 'get_os_app_state',
  'take_snapshot', 'take_screenshot', 'wait_for',
  'performance_start_trace', 'performance_stop_trace', 'performance_analyze_insight',
  'take_heapsnapshot', 'close_heapsnapshot', 'compare_heapsnapshots', 'query_heapsnapshot_objects',
  'get_heapsnapshot_class_nodes', 'get_heapsnapshot_details', 'get_heapsnapshot_dominators',
  'get_heapsnapshot_duplicate_strings', 'get_heapsnapshot_edges', 'get_heapsnapshot_object_details',
  'get_heapsnapshot_retainers', 'get_heapsnapshot_retaining_paths', 'get_heapsnapshot_summary',
])

export function decideApproval(settings, toolName) {
  const { policy, readOnlyTools } = settings ?? {}
  if (typeof toolName !== 'string' || !toolName.startsWith(TOOL_PREFIX)) return { kind: 'allow' }
  if (policy === 'none') return { kind: 'allow' }
  const bare = toolName.slice(TOOL_PREFIX.length)
  if (policy === 'sensitive' && readOnlyTools.includes(bare)) return { kind: 'allow' }
  return {
    kind: 'ask',
    reason: `chrome-cdp: ${bare} on the attached Chrome`,
    displayReason: {
      en: `Allow the Chrome action "${bare}"?`,
      zh: `允许执行 Chrome 操作「${bare}」吗？`,
    },
  }
}

/**
 * Register the global pre-execute listener. Containment: the callback never
 * throws (a plugin bug must not kill the host); on internal error it falls
 * back to asking, which is fail-closed, and delegates everything else.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {() => { policy: string, readOnlyTools: string[] }} getSettings - re-read per call.
 */
export function registerApprovalGate(ctx, getSettings) {
  return ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const name = exec?.name
      if (typeof name !== 'string' || !name.startsWith(TOOL_PREFIX)) return next()
      const decision = decideApproval(getSettings(), name)
      if (decision.kind === 'allow') return next()
      return decision
    } catch {
      // Fail closed: ask (denied when no approval channel) rather than throw.
      return { kind: 'ask', reason: 'chrome-cdp: gate error, asking as fallback' }
    }
  })
}
