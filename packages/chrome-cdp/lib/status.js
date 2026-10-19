/**
 * Status surface: a Typert remote service the Plugins card reads, plus the
 * /cdc slash command. Modeled on feishu-gateway's diagnostics remote
 * (packages/feishu-gateway/lib/diagnostics.js; marker shape from
 * packages/typert/protocol — decorator syntax is unavailable in plain ESM).
 * Contained: every method try/catches; diagnostics must never destabilize
 * the host.
 *
 * Import strategy: static top-level peer import — the exact sibling pattern
 * (packages/feishu-gateway/lib/diagnostics.js:19; both packages declare
 * dsh-typert-protocol as a peerDependency, transitively present in
 * node_modules, verified resolving under node --test). Preserves the named
 * class export; see the task report for the controller-ruling alternative.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export class ChromeCdpStatus extends TypertRemoteService {
  constructor(ctx, getState) {
    super(ctx, 'chromeCdp', { namespace: 'chromeCdp' })
    this.getStateFn = getState
  }

  /** Config snapshot + upstream entry for the Plugins card. @Remote */
  status() {
    try { return this.getStateFn() } catch { return { available: false } }
  }
}

{
  const direct = Object.freeze({ kind: 'direct' })
  Object.defineProperty(ChromeCdpStatus.prototype, REMOTE_METHODS, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([Object.freeze({ method: 'status', invocation: direct })]),
    }),
  })
}

/** Register the remote service and the /cdc slash command (both contained). */
export function registerStatus(ctx, getState) {
  const disposers = []
  // A cordis Service self-registers with ctx and its lifecycle follows the
  // fiber — plain construction in try/catch is the feishu-gateway pattern
  // (packages/feishu-gateway/index.js:168-173). The slash command is optional
  // (packages/interaction/commands/src/index.ts: ctx.commands.register).
  try { new ChromeCdpStatus(ctx, getState) } catch (error) { ctx.logger?.warn?.(`chrome-cdp: status service failed to register: ${String(error)}`) }
  const commands = (() => { try { return ctx.get('commands') } catch { return undefined } })()
  if (commands !== undefined) {
    try {
      disposers.push(commands.register({
        name: 'cdc',
        description: 'Chrome CDP connection status (chrome-cdp plugin)',
        handler: async () => {
          try {
            const s = getState()
            return { kind: 'success', text: JSON.stringify(s, null, 2) }
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) }
          }
        },
      }))
    } catch {}
  }
  return () => { for (const d of disposers) { try { d?.() } catch {} } }
}
