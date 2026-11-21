/**
 * dsh-engram — Host half (scaffold; Task 1).
 *
 * A host plugin embedding engram memory: on mount (Task 8) it stewards the
 * local engram daemon, registers six curated memory tools, bridges DSH↔engram
 * session lifecycles, and optionally injects a memory summary into the prompt.
 * THIS FILE exports only the Config schema and the reactive config-read
 * helpers — apply() lands in Task 8, so the package stays installable-but-inert
 * until then.
 *
 * Configuration lives on the Loader row (`engram`), edited on the Plugins
 * page or defaulted through the bundle's patch layer; see README.md.
 */
import Schema from '@deepseek-ai/schemastery'

/**
 * Read a config field that the Loader may hand over as a volatile wrapper or
 * as a plain value (tests, plain mounts). The Loader hands plugin config
 * fields as schemastery reactive wrappers — objects with `.get()` — never as
 * plain strings; raw use dies with `TypeError: x.replace is not a function`
 * (see AGENTS.md, "Config values arrive wrapped"). EVERY config read in this
 * package goes through readString/readNumber.
 */
export function readString(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'string' ? raw : ''
}

/** Read a volatile number field (same reactive-wrapper rule). */
export function readNumber(value) {
  const raw = typeof value?.get === 'function' ? value.get() : value
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : NaN
}

/**
 * Row configuration. Per ADR-0005: defaults are empty or protocol-generic —
 * no deployment addresses or credentials baked in. Secrets appear only as
 * credential-ref NAMES (httpTokenRef / cloudServerRef / cloudTokenRef),
 * resolved through ctx.credentials at mount time (Task 8) — never as values.
 *
 * Volatile fields are the ones Plugins-page edits apply live (settings.mutate
 * persists accepted edits into the profile patch — it is not a persistence
 * switch; an entry with no volatile field is dropped from the settings
 * document). daemonMode stays non-volatile: it changes mount-time stewardship
 * structure, so edits there take effect on reload.
 */
export const Config = Schema.object({
  daemonMode: Schema.union(['auto-spawn', 'connect-only']).default('auto-spawn'),
  // '' = engram's documented protocol default (7437); the client treats
  // empty as 7437 — the port number is never baked into the schema.
  port: Schema.string().default('').volatile(),
  httpTokenRef: Schema.string().role('credential-ref').default('').volatile(),
  cloudServerRef: Schema.string().role('credential-ref').default('').volatile(),
  cloudTokenRef: Schema.string().role('credential-ref').default('').volatile(),
  autosync: Schema.boolean().default(false).volatile(),
  contextInjection: Schema.union(['off', 'on']).default('off').volatile(),
  contextMaxBytes: Schema.number().min(0).default(2048).volatile(),
  projectMode: Schema.union(['auto', 'fixed', 'map']).default('auto').volatile(),
  fixedProject: Schema.string().default('').volatile(),
  projectMap: Schema.dict(String).default({}).volatile(),
  toolProfile: Schema.union(['core', 'extended']).default('core').volatile(),
})
