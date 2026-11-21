/**
 * Staged status writer (airboard pattern): every mount stage lands as one
 * JSON record so a dead mount names its stage. Best-effort by contract —
 * a failed write (unwritable path, missing directory) never throws and never
 * blocks the plugin; it is observability, not control flow.
 *
 * Default target is ~/.dsh/engram-status.json; tests (and multi-instance
 * setups) override it with ENGRAM_STATUS_FILE so they never touch the real
 * file (AGENTS.md: per-instance state — never assume a single host instance
 * owns ~/.dsh). The override is resolved here, at write time, so a writer
 * created before test setup still honors it.
 */
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * @param {string} [file] explicit target path; defaults to ENGRAM_STATUS_FILE
 *   or ~/.dsh/engram-status.json.
 * @returns {{ note(stage: string, detail?: string): void }}
 */
export function makeStatusWriter(file) {
  const target = file
    ?? process.env.ENGRAM_STATUS_FILE
    ?? join(homedir(), '.dsh', 'engram-status.json')
  return {
    /** Write one stage record; swallowed on failure (best effort). */
    note(stage, detail) {
      try {
        writeFileSync(target,
          `${JSON.stringify({ stage, detail: detail ?? null, at: new Date().toISOString() }, null, 2)}\n`)
      } catch { /* best effort — never fatal */ }
    },
  }
}
