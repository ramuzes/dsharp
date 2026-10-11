/**
 * Gateway status reporting: the boot path writes its stage to a small JSON
 * file under ~/.dsh so `scripts/doctor.mjs` (and any human) can see exactly
 * where the gateway stands without host-terminal logs, which print nothing
 * at info level and are easy to miss.
 *
 * Stages: waiting-services → resolving-credential → inactive |
 * boot-storage → boot-transport → connected | boot-failed.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

/** Resolve the status file at call time: env-overridable so tests (which set
 * the env after module load, thanks to ESM import hoisting) never touch the
 * real file. */
export function statusFile() {
  return process.env.FEISHU_GATEWAY_STATUS_FILE
    ?? join(homedir(), '.dsh', 'feishu-gateway-status.json')
}

/**
 * Best-effort staged status writer; never throws into the boot path.
 * @param {string} [file] - override for tests.
 * @returns {{ write: (stage: string, detail?: unknown) => void }} the writer.
 */
export function createStatusWriter(file = statusFile()) {
  return {
    write(stage, detail) {
      try {
        writeFileSync(file, `${JSON.stringify({ stage, detail: detail === undefined ? null : detail, at: new Date().toISOString() }, null, 2)}\n`)
      } catch { /* best effort: diagnostics must never break the gateway */ }
    },
  }
}

/** Event-log location, env-overridable for tests (same rule as statusFile). */
export function eventLogFile() {
  return process.env.FEISHU_GATEWAY_EVENT_LOG
    ?? join(homedir(), '.dsh', 'feishu-gateway-events.json')
}

/**
 * Best-effort inbound-event log: keeps the last `limit` events (type,
 * chat_type, outcome) so "the bot ignores my messages" splits into
 * "events never arrive" (console subscription/permission) versus
 * "arrived but filtered/handled here".
 * @param {number} [limit]
 * @param {string} [file]
 * @returns {{ log: (entry: Record<string, unknown>) => void }} the logger.
 */
export function createEventLog(limit = 20, file = eventLogFile()) {
  let entries = []
  return {
    log(entry) {
      try {
        entries.push({ at: new Date().toISOString(), ...entry })
        if (entries.length > limit) entries = entries.slice(-limit)
        writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`)
      } catch { /* best effort */ }
    },
  }
}

/** Best-effort read of the last status write. */
export function readStatus(file = statusFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

/** Best-effort read of the inbound-event log. */
export function readEvents(file = eventLogFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
}
