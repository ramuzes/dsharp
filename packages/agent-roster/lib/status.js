/**
 * Staged status writer (engram lib/status.js pattern): every mount stage lands
 * as one JSON record so a dead mount names its stage — a surviving old fiber
 * must never mask a failed new one (AGENTS.md, live-mount pitfalls). Best
 * effort by contract: a failed write (unwritable path, missing directory)
 * never throws and never blocks the plugin; it is observability, not control
 * flow.
 *
 * Default target is ~/.dsh/agent-roster-status.json; tests and multi-instance
 * setups override it with AGENT_ROSTER_STATUS_FILE so they never touch the
 * real file (AGENTS.md: per-instance state — never assume a single host
 * instance owns ~/.dsh). The override is resolved inside write(), at WRITE
 * time, so a writer opened before the environment changes (tests,
 * multi-instance setups) still honors a later override.
 */
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Open the staged status writer.
 *
 * @param {object} scope - plugin context or inject scope; reserved so later
 *   tasks can resolve per-instance state from the context. Today the
 *   per-instance mechanism is the env override below (the engram precedent):
 *   the host exposes no per-profile home accessor a plugin may read, and the
 *   repo rule forbids guessing at one.
 * @returns {{ write(stage: string, detail?: unknown): void }}
 */
export function openStatus(scope) {
  void scope // intentionally unused for now — see JSDoc above
  return {
    /** Write one stage record; swallowed on failure (best effort). */
    write(stage, detail) {
      // Env override resolved at WRITE time (not construction) so overrides
      // that arrive after the writer exists still take effect.
      const target = process.env.AGENT_ROSTER_STATUS_FILE
        ?? join(homedir(), '.dsh', 'agent-roster-status.json')
      try {
        writeFileSync(target,
          `${JSON.stringify({ stage, detail: detail ?? null, at: new Date().toISOString() }, null, 2)}\n`)
      } catch { /* best effort — never fatal */ }
    },
  }
}
