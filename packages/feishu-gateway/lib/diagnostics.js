/**
 * Feishu gateway diagnostics Remote: the `feishuGateway` namespace the
 * Plugins-page card reads for live status and the connectivity probe.
 *
 * The host surface is a TypertRemoteService exactly like
 * credentialsController (packages/api/settings-controller/src/credentials.ts):
 * the Gateway discovers it by scanning live services for the `typertRemote`
 * binding plus the remote-method markers on the prototype
 * (packages/api/gateway/src/index.ts, resolveSrcDescriptor). Plain-node
 * plugins cannot use decorator syntax, so the marker descriptor
 * ('@deepseek-ai/dsh-typert-protocol/remote-methods', version 1) is attached
 * manually below — the exact shape Remote() persists (packages/typert/
 * protocol/src/index.ts, mark()).
 *
 * Both methods carry zero wire parameters, so no strict codecs are needed:
 * the Gateway builds src-json descriptors for them, and the client mounts
 * them with src-json results (client.js $mount contribution).
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** Prototype marker key the protocol reads (REMOTE_METHOD_DESCRIPTOR). */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * The diagnostics service. `getState` returns the live status snapshot
 * (stage, appId, connectedAt, lastWsError, inbound counters); `probe` runs
 * the on-demand connectivity check (credential validity + egress to the
 * open platform, i.e. the doctor.mjs token test over the Remote wire).
 */
export class FeishuGatewayDiagnostics extends TypertRemoteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {() => Record<string, unknown>} getState - live status snapshot.
   * @param {(signal?: AbortSignal) => Promise<Record<string, unknown>>} probe - connectivity check.
   */
  constructor(ctx, getState, probe) {
    super(ctx, 'feishuGateway', { namespace: 'feishuGateway' })
    this.getState = getState
    this.probeFn = probe
  }

  /** Live gateway status for the diagnostics card. @Remote */
  status() {
    return this.getState()
  }

  /** Credential + egress probe for the diagnostics card. @Remote */
  async probe(signal) {
    return this.probeFn(signal)
  }
}

// Manual remote-method markers: decorator syntax is unavailable in plain
// Node ESM, so replicate the version-1 descriptor Remote() would write.
{
  const direct = Object.freeze({ kind: 'direct' })
  Object.defineProperty(FeishuGatewayDiagnostics.prototype, REMOTE_METHODS, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        Object.freeze({ method: 'status', invocation: direct }),
        Object.freeze({ method: 'probe', invocation: direct }),
      ]),
    }),
  })
}
