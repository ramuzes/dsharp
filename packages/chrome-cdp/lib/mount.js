/**
 * Vendored per-Session exclusive MCP mount, replacing the browser-use runtime
 * dependency (desktop distributions do not carry that subsystem; ADR-0004
 * revision 2026-11-20). Pattern origin:
 * packages/experimental/browser-use-runtime/src/mcp.ts:128-194 - one MCP
 * child per live Agent, mounted on the Agent's own ctx fiber (so teardown is
 * automatic), discovered before the Agent's queued input runs via the
 * prepended 'agent/created' listener.
 *
 * Simplifications versus the runtime version (documented, intentional):
 * - exclusivity without dsh-browser-use: a single module-level holder; while
 *   held, later Sessions mount nothing and simply have no browser tools.
 *   The runtime's tool-masking variant needs dsh-scope + the browserUse
 *   registry, which are exactly the dependencies being removed.
 * - the holder is released when the holder Session's fiber ends
 *   (agent.ctx.effect), after which a NEW or resumed Session can claim it.
 */
export function mountPerSession(ctx, options, deps = {}) {
  let holder = null // { agent } while one Session owns the browser endpoint
  const mountInto = deps.mountInto ?? defaultMountInto(deps.McpClient)
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (holder) return // busy: this Session continues without browser tools
    try {
      signal?.throwIfAborted?.()
      await mountInto(agent, options, signal)
      if (holder) return // lost a race between concurrent creations
      holder = { agent }
      agent.ctx.effect(() => {
        // Synchronous claim release: nothing to drain, the MCP child is torn
        // down by the holder Session's own fiber.
        if (holder && holder.agent === agent) holder = null
      }, options.name + '.holder')
    } catch (error) {
      console.error('chrome-cdp mount failed:', error && (error.stack || error.message))
      // Contained: a failed mount leaves this Session without browser tools;
      // the next agent/created retries. Never destabilize the host.
    }
  }, { prepend: true })
  return {
    /** The Session currently holding the mount, if any. */
    get holderAgent() { return holder ? holder.agent : null },
  }
}

function defaultMountInto(McpClient) {
  return async (agent, options, signal) => {
    const client = McpClient ?? await import('@deepseek-ai/dsh-mcp-client')
    await agent.ctx.plugin(client, client.Config({
      transport: 'stdio',
      serverName: options.name,
      command: options.command,
      args: options.args,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs }),
      failOnStartupError: true,
      reconnect: { enabled: false },
    }))
  }
}
