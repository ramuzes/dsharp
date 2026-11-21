/**
 * engram daemon stewardship (Task 3).
 *
 * Makes sure a local engram daemon is healthy and version-supported before
 * the rest of the plugin talks to it: probe /health, spawn `engram run -d`
 * via the dsh subprocess seam when allowed, retry the probe with a bounded
 * backoff, and classify every failure as a typed EngramError — never a raw
 * exception:
 *   unsupported daemon version      -> engram/unsupported-version
 *   cannot connect, spawn disabled  -> engram/daemon-unreachable
 *   spawn process itself failed     -> engram/daemon-spawn-failed
 *
 * Subprocess seam conformance (packages/subprocess/subprocess/src/types.ts):
 * `SubprocessOutcome` carries ONLY `{ exitCode, signal }` — there is no
 * success flag and no output field. Failure detection therefore checks
 * `exitCode !== 0`, and any diagnostic text is read after settlement through
 * `handle.collected.stderr.readFrom(0)` (present iff stderr was spawned in
 * collect mode, which is how we spawn).
 */
import { EngramError, probeHealth, isSupportedVersion } from './engram-api.js'

const DEFAULT_RETRY = { attempts: 5, delayMs: 300 }

/**
 * One bounded spawn attempt. Throws EngramError('engram/daemon-spawn-failed')
 * when the process exits nonzero or the provider rejects; the collected
 * stderr tail (when present) is quoted into the message.
 * @param {{ spawn(spec: object): { done: Promise<{exitCode: number|null, signal: unknown}>,
 *   collected?: { stderr?: { readFrom(fromByte: number): {text: string, nextOffset: number, lossy: boolean} } } } }} subprocess
 * @param {() => Record<string, string>} buildEnv
 */
async function spawnDaemon(subprocess, buildEnv, note) {
  try {
    // Spec members mirror SubprocessSpawnSpec exactly: argv, cwd, stdio
    // (all three streams explicit — the seam applies no defaults), env.
    // stderr is collected (bounded tail) so a port-collision message stays
    // readable after settlement via readFrom(0).
    const spec = {
      argv: ['engram', 'run', '-d'],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: { maxBytes: 8192 },
      },
      env: buildEnv(),
    }
    const handle = subprocess.spawn(spec)
    const outcome = await handle.done
    if (outcome.exitCode !== 0) {
      // SubprocessOutcome has no stderr; collected output stays readable
      // through the handle after settlement — read the retained tail from 0.
      const stderrText = handle.collected?.stderr?.readFrom(0)?.text ?? ''
      throw new EngramError('engram/daemon-spawn-failed',
        `engram/daemon-spawn-failed: 'engram run -d' exited with code ${outcome.exitCode}` +
        `${stderrText ? `: ${stderrText.trim()}` : ''}. If the port is already in use, ` +
        `point the plugin at the running daemon with the daemon.port config option, ` +
        `or set daemonMode to 'connect-only' to stop spawning entirely.`)
    }
  } catch (err) {
    if (err instanceof EngramError) {
      // Every stage lands in the status file (spec decision 3) — record the
      // spawn failure with its guidance before it propagates. `note` is the
      // contained sink; best-effort, never throws (see lib/status.js).
      if (note) note('daemon-spawn-failed', err.message)
      throw err
    }
    // Provider/spawn-level failure (e.g. done rejected) — classify, never rethrow raw.
    const failure = new EngramError('engram/daemon-spawn-failed',
      `engram/daemon-spawn-failed: could not start 'engram run -d' (${err?.message ?? err}). ` +
      `Check the daemon.port config option for a collision, or set daemonMode to ` +
      `'connect-only' to run without spawning.`)
    if (note) note('daemon-spawn-failed', failure.message)
    throw failure
  }
}

/**
 * Ensure a healthy, supported engram daemon; spawn one when allowed.
 * @param {{ client: object, probe?: typeof probeHealth, subprocess: object,
 *   spawnEnabled: boolean, buildEnv: () => Record<string, string>,
 *   note?: (stage: string, detail?: string) => void,
 *   retry?: { attempts: number, delayMs: number },
 *   signal?: AbortSignal }} deps
 * @returns {Promise<{ version: string, capabilities: object }>}
 */
export async function ensureDaemon({
  client,
  probe = probeHealth,
  subprocess,
  spawnEnabled,
  buildEnv,
  note,
  retry = DEFAULT_RETRY,
  signal,
}) {
  const attempts = retry?.attempts ?? DEFAULT_RETRY.attempts
  const delayMs = retry?.delayMs ?? DEFAULT_RETRY.delayMs
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let spawned = false

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let health
    try {
      health = await probe(client, signal)
    } catch (err) {
      // Non-EngramError probe crashes are still classified, never raw.
      const probeError = err instanceof EngramError
        ? err
        : new EngramError('engram/daemon-unreachable',
          `engram/daemon-unreachable: health probe failed (${err?.message ?? err})`)

      // Nothing spawning can fix — surface immediately (status file too).
      if (!spawnEnabled) {
        const unreachable = new EngramError('engram/daemon-unreachable',
          `engram/daemon-unreachable: cannot reach the engram daemon on the configured port ` +
          `(${probeError.message}). Start it yourself or set the daemon.port config option ` +
          `to match, or switch daemonMode to 'connect-only' to keep the plugin from spawning.`)
        if (note) note('daemon-unreachable', unreachable.message)
        throw unreachable
      }

      if (!spawned) {
        spawned = true
        await spawnDaemon(subprocess, buildEnv, note)
      }
      if (attempt < attempts) await sleep(delayMs)
      continue
    }

    if (!isSupportedVersion(health.version)) {
      // Spawning cannot fix a version mismatch — fail fast and loud.
      const unsupported = new EngramError('engram/unsupported-version',
        `engram/unsupported-version: daemon reports version ${health.version}; ` +
        `this plugin requires >=3.7.`)
      if (note) note('daemon-unsupported-version', unsupported.message)
      throw unsupported
    }

    // Capability gate (spec decision 3: validate version >= 3.7 AND
    // capability flags): /health must carry a non-empty `capabilities`
    // object; a missing/empty one is treated as unsupported.
    if (typeof health.capabilities !== 'object' || health.capabilities === null
      || Array.isArray(health.capabilities)
      || Object.keys(health.capabilities).length === 0) {
      const unsupported = new EngramError('engram/unsupported-version',
        `engram/unsupported-version: daemon reports version ${health.version} but no ` +
        `capability flags (missing or empty \`capabilities\` in /health); this plugin ` +
        `requires a >=3.7 daemon that advertises its capabilities.`)
      if (note) note('daemon-unsupported-version', unsupported.message)
      throw unsupported
    }

    if (spawned && note) note('daemon-spawned')
    return health
  }

  const terminal = new EngramError('engram/daemon-unreachable',
    `engram/daemon-unreachable: the engram daemon did not become reachable within ` +
    `${attempts} attempts after spawning. Check the daemon.port config option ` +
    `(is a daemon already listening on the configured port?) or switch daemonMode ` +
    `to 'connect-only' to stop spawning and probe only.`)
  if (note) note('daemon-unreachable', terminal.message)
  throw terminal
}
