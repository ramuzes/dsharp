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
