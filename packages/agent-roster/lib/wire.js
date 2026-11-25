/**
 * Wire helpers: the config-unwrap discipline every code path in this package
 * follows (AGENTS.md, "Config values arrive wrapped").
 *
 * The dsh Loader hands plugin config fields as schemastery reactive wrappers —
 * objects with `.get()` — never as plain strings/booleans. Raw use dies with
 * `TypeError: x.replace is not a function` at mount. EVERY config read in
 * dsh-agent-roster goes through readString/readBoolean, including boot-only
 * paths. Tests may hand plain values; the helpers accept both shapes.
 */

import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Unwrap a config field and coerce to string.
 * @param {unknown} value - wrapper (`{ get(): unknown }`) or plain value.
 * @returns {string} the unwrapped string, or '' for any non-string.
 */
export function readString(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'string' ? raw : ''
}

/**
 * Unwrap a config field and coerce to boolean (strict: only `true` is true,
 * so a wrongly-typed field can never silently enable a toggle).
 * @param {unknown} value - wrapper (`{ get(): unknown }`) or plain value.
 * @returns {boolean}
 */
export function readBoolean(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return raw === true
}

/**
 * Map one roster failure to model-safe text; never rethrow into the host.
 * Shared by the agent tools and the `/roster` command (one wording for both).
 * Typed roster/ failures discriminate by code, never instanceof (the
 * protocol's rule — @deepseek-ai/dsh-typert-protocol RemoteError); their
 * messages are already bilingual for the UI, usable verbatim.
 * @param {unknown} error
 * @returns {string}
 */
export function failureText(error) {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) {
    return `roster call failed (${remote.code}): ${remote.message}`
  }
  return `roster call failed: ${error?.message ?? String(error)}`
}
