/**
 * Roster store: persistence for role templates over the host's domain data
 * form, with an in-memory fallback when the host exposes no storageDomain
 * service.
 *
 * storageDomain conformance (dsh source is the single source of truth,
 * AGENTS.md 2b): the form is @deepseek-ai/dsh-storage-domain — defineDomain/
 * domainTable declare the spec; the 'storageDomain' service (provided by the
 * storage-domain plugin) opens it with facility.open(spec) → domain, whose
 * tables expose get/keys/put/delete/update (KvTableImpl in its lib/index.js).
 * Every loaded record is validated with its table's zod valueSchema through
 * .parse (DomainFacility.open → parseRecord) — which is why the records below
 * are zod, NOT schemastery: schemastery schemas have no .parse and made every
 * stored feishu-gateway binding fail domain validation (recorded incident,
 * packages/feishu-gateway/index.js:52-78). The opened domain handle is
 * CALLER-owned (DomainFacility.open lifecycle note): this store exposes
 * dispose() for the apply() fiber disposer — an unclosed domain keeps its
 * name reserved and rejects a remount with DomainError 'already-open'.
 *
 * The optional service is resolved by name via scope.get('storageDomain'):
 * property access without inject throws in cordis ("cannot get property ...
 * without inject") while the name lookup returns undefined — the feishu-gateway
 * createDomainPersist pattern (packages/feishu-gateway/index.js:89-93).
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * ModelRef — the model a template spawns its member with. JSDoc restatement
 * of the shared shape (the spawn passes it on as AgentOptions):
 * @typedef {object} ModelRef
 * @property {string} provider
 * @property {string} model
 * @property {string} [reasoningEffort]
 */
export const ModelRef = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})

/**
 * One stored role-template record (zod — see the file header for why).
 * `highTierModel` pins a stronger model this template may dispatch through
 * (null = no high-tier path); `reuse` selects what a resident member is
 * reused across: 'role' (any task for the template) or 'task' (one task).
 */
export const RoleTemplate = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  description: z.string().max(200).default(''),
  prompt: z.string().min(1),
  defaultModel: ModelRef.nullable().default(null),
  highTierModel: ModelRef.nullable().default(null),
  reuse: z.enum(['role', 'task']).default('role'),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * One high-tier dispatch log entry: appended each time a template's pinned
 * high-tier model was actually used to spawn or reuse a member.
 */
export const HighTierUse = z.object({
  id: z.string().min(1),
  at: z.string(),
  sessionId: z.string(),
  templateId: z.string(),
  templateName: z.string(),
  memberName: z.string(),
  reason: z.string().min(1),
})

/** The roster storage domain (feishu-gateway bindingDomain pattern). */
export const rosterDomain = defineDomain({
  name: 'agent_roster',
  version: 1,
  tables: {
    templates: domainTable(RoleTemplate),
  },
})

/**
 * The high-tier dispatch log's own domain: separate name, version and table
 * set so the templates domain keeps its identity and stored records
 * untouched (an 'already-open'/version coupling between the two would make
 * the log a migration hazard for templates).
 */
export const rosterLogDomain = defineDomain({
  name: 'agent_roster_log',
  version: 1,
  tables: {
    // dsh-storage-domain's defineDomain enforces table names matching
    // /^[a-z][a-z0-9_]*$/ — camelCase 'highTierUse' is rejected at declare
    // time, so the table carries the snake_case name.
    high_tier_use: domainTable(HighTierUse),
  },
})

/**
 * Fresh template id: 10 hex chars from 5 random bytes — short, assigned once
 * at create and then stable for the record's lifetime.
 * @returns {string}
 */
export function freshId() {
  return randomBytes(5).toString('hex')
}

/**
 * Open the roster store.
 *
 * @param {object} scope - plugin ctx or inject scope; only its get() name
 *   lookup is touched (see file header).
 * @param {{ write(stage: string, detail?: unknown): void }} [status] - staged
 *   status writer (lib/status.js openStatus shape); records `storage-degraded`
 *   when the store falls back to memory.
 * @returns {{
 *   all(): Promise<import('zod').z.infer<typeof RoleTemplate>[]>,
 *   byId(id: string): Promise<import('zod').z.infer<typeof RoleTemplate> | undefined>,
 *   byName(name: string): Promise<import('zod').z.infer<typeof RoleTemplate> | undefined>,
 *   put(rec: import('zod').z.infer<typeof RoleTemplate>): Promise<void>,
 *   delete(id: string): Promise<boolean>,
 *   log: {
 *     add(record): Promise<void>,
 *     list(limit?: number): Promise<import('zod').z.infer<typeof HighTierUse>[]>,
 *   },
 *   dispose(): void,
 * }} the store handle. Every operation awaits its domain open, so a backend
 *   failure rejects the operations that need it — loud, never a silent second
 *   fallback below the memory mode (AGENTS.md: no silent degradation) — and
 *   an open() rejection is acknowledged at creation (never left dangling for
 *   Node's unhandledRejection to kill the host) while recording a
 *   `storage-open-failed` status entry.
 */
export function openRosterStore(scope, status) {
  const memory = { templates: new Map(), log: [] }
  const storageDomain = scope?.get?.('storageDomain')
  if (storageDomain === undefined) {
    status?.write('storage-degraded',
      'storageDomain service absent — roster keeps records in memory for this mount only (edits do not persist)')
  }
  // Undefined in memory mode; otherwise the opened domain handle once open()
  // settles. A rejected open() (DomainFacility failure codes: already-open,
  // backend-not-found, version-mismatch, malformed-medium, invalid-record)
  // rejects every subsequent operation as-is — operations await THIS promise.
  const ready = storageDomain === undefined
    ? Promise.resolve(undefined)
    : storageDomain.open(rosterDomain)
  // The log domain opens through the same facility and the same failure
  // semantics: its operations await logReady, so a rejected open fails them
  // loudly, never a silent second fallback below memory mode.
  const logReady = storageDomain === undefined
    ? Promise.resolve(undefined)
    : storageDomain.open(rosterLogDomain)
  // …but the rejections are ACKNOWLEDGED at creation, before anything awaits
  // them: between mount and the first operation nothing else holds a handler,
  // and a dangling rejected promise trips Node's unhandledRejection (default
  // throw policy), killing the host process post-mount — the exact fatal
  // path AGENTS.md forbids. These handlers only observe and record; awaiting
  // the original promises above keeps every operation failing loudly.
  const noteOpenFailure = (error) => {
    status?.write('storage-open-failed', String(error))
  }
  ready.catch(noteOpenFailure)
  logReady.catch(noteOpenFailure)

  /** Resolve both table handles, or undefined in memory mode. */
  const tables = async () => {
    const domain = await ready
    return domain === undefined ? undefined : { templates: domain.table('templates') }
  }

  /** Resolve the log domain's highTierUse table, or undefined in memory mode. */
  const logTable = async () => {
    const domain = await logReady
    return domain === undefined ? undefined : domain.table('high_tier_use')
  }

  /**
   * Sort log entries newest first (by `at` descending; ISO strings compare
   * lexicographically) and cut to the requested limit.
   */
  const newestFirst = (rows, limit) =>
    rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit)

  const all = async () => {
    const t = await tables()
    if (t === undefined) return [...memory.templates.values()]
    return [...t.templates.keys()].flatMap((key) => {
      const rec = t.templates.get(key)
      return rec === undefined ? [] : [rec]
    })
  }
  const byId = async (id) => {
    const t = await tables()
    return t === undefined ? memory.templates.get(id) : t.templates.get(id)
  }
  const byName = async (name) => (await all()).find((rec) => rec.name === name)
  const put = async (rec) => {
    const t = await tables()
    if (t === undefined) { memory.templates.set(rec.id, rec); return }
    await t.templates.put(rec.id, rec)
  }
  const remove = async (id) => {
    const t = await tables()
    return t === undefined ? memory.templates.delete(id) : t.templates.delete(id)
  }
  const add = async (record) => {
    const t = await logTable()
    if (t === undefined) { memory.log.push(record); return }
    await t.put(record.id, record)
  }
  const list = async (limit = 50) => {
    const t = await logTable()
    if (t === undefined) return newestFirst([...memory.log], limit)
    const rows = [...t.keys()].flatMap((key) => {
      const rec = t.get(key)
      return rec === undefined ? [] : [rec]
    })
    return newestFirst(rows, limit)
  }
  /**
   * Release the opened domains (caller-owns-handle contract, file header).
   * Best effort by contract — a disposal path must never throw; memory mode
   * has nothing to release and close() is idempotent in the real domain.
   *
   * Domain.close() is ASYNC in the real storage-domain (DomainFacility
   * close/runClose, storage-domain src/domain.ts:251-260) and rejects when
   * the unit fails to close: dispose() returns before that settles, so the
   * settlement must be observed HERE or the rejected promise dangles for
   * Node's unhandledRejection (fatal for the host). Every outcome records
   * `storage-close-failed` with the error text; the sync try only covers a
   * close() that throws before returning a promise.
   */
  const noteCloseFailure = (error) => {
    status?.write('storage-close-failed', String(error))
  }
  const closeObserved = (domain) => {
    let closing
    try {
      closing = domain?.close?.()
    } catch (error) {
      noteCloseFailure(error)
      return
    }
    // Promise.resolve adopts any thenable (a bare { then } has no .catch of
    // its own); the sync try above already handled a throw before return.
    Promise.resolve(closing).catch(noteCloseFailure)
  }
  const release = (p) => {
    p
      .then(closeObserved)
      .catch(() => { /* open() already failed: nothing was opened */ })
  }
  const dispose = () => {
    release(ready)
    release(logReady)
  }

  return { all, byId, byName, put, delete: remove, log: { add, list }, dispose }
}
