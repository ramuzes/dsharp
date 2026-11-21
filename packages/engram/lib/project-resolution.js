/**
 * Per-session project resolution (Task 4).
 *
 * Maps a session's working directory to an engram project. Precedence,
 * per the task brief:
 *   1. explicit argument given by the caller
 *   2. fixed mode — a configured fixed project (empty value there is a
 *      misconfiguration, surfaced as EngramError('engram/project-misconfigured'))
 *   3. longest-prefix match over the configured project map against the
 *      session's working directory
 *   4. server probe: GET /project/current?cwd=<dir>
 *
 * Probe results are cached in a Map keyed `${session.id}:${cwd}`. Because the
 * key embeds the cwd, a working-directory change naturally misses and triggers
 * a fresh probe — no event wiring needed (self-invalidating cache).
 *
 * Typed failures (never raw errors escape):
 *   - probe answers "ambiguous" (200 with project_source 'ambiguous')
 *       -> ProjectAmbiguousError with `.available`
 *   - daemon answers 409 explicit_project_required
 *       -> ProjectExplicitRequiredError
 *   - anything else from the client
 *       -> rethrown as-is; the client already wraps every failure in a typed
 *          EngramError (engram/unreachable, engram/http, engram/bad-response).
 */

import { EngramError } from './engram-api.js'

/** Server said the cwd is ambiguous between several projects. */
export class ProjectAmbiguousError extends Error {
  /**
   * @param {string[]} available project names the daemon offered
   */
  constructor(available) {
    super(`engram/project-ambiguous: working directory matches multiple engram projects (${available.join(', ')})`)
    this.name = 'ProjectAmbiguousError'
    this.available = available
  }
}

/** Daemon refuses to guess (unsafe HOME); an explicit project is required. */
export class ProjectExplicitRequiredError extends Error {
  constructor() {
    super('engram/project-explicit-required: engram requires an explicit project for this working directory')
    this.name = 'ProjectExplicitRequiredError'
  }
}

/** Longest-prefix match: pick the map key that prefixes cwd and is longest. */
function longestPrefixMatch(map, cwd) {
  let best = null
  let bestLength = -1
  for (const [prefix, project] of Object.entries(map ?? {})) {
    if (cwd.startsWith(prefix) && prefix.length > bestLength) {
      best = project
      bestLength = prefix.length
    }
  }
  return best
}

/**
 * @param {{ client: { get(path: string, query?: object): Promise<any> },
 *           getMode(): string,
 *           getFixedProject(): string,
 *           getProjectMap(): Record<string, string>,
 *           getWorkingDir(session): string }} deps
 * @returns {{ resolve(session: object, explicit?: string):
 *              Promise<{ project: string, source: 'explicit'|'fixed'|'map'|string }> }}
 */
export function createProjectResolver({ client, getMode, getFixedProject, getProjectMap, getWorkingDir }) {
  /** @type {Map<string, { project: string, source: string }>} */
  const cache = new Map()

  /**
   * Probe the daemon for the project of a cwd, narrowing typed failure paths.
   * @param {string} cwd
   */
  async function probe(cwd) {
    let body
    try {
      body = await client.get('/project/current', { cwd })
    } catch (err) {
      // Real client surfaces the daemon's 409 as EngramError('engram/http',
      // ..., { status: 409, info }) — narrow that one case to the typed error.
      if (err instanceof EngramError && err.code === 'engram/http' && err.status === 409) {
        throw new ProjectExplicitRequiredError()
      }
      throw err
    }
    if (body?.project_source === 'ambiguous' || body?.project === null) {
      throw new ProjectAmbiguousError(Array.isArray(body.available_projects) ? body.available_projects : [])
    }
    if (typeof body?.project !== 'string' || body.project === '') {
      throw new EngramError('engram/bad-response',
        `engram/bad-response: /project/current returned no project for cwd ${cwd}`,
        { status: 200, info: body })
    }
    return { project: body.project, source: typeof body.project_source === 'string' ? body.project_source : 'server' }
  }

  return {
    /**
     * Resolve the engram project for a session.
     * @param {object} session host session (id + working dir via deps)
     * @param {string} [explicit] caller-forced project name
     */
    async resolve(session, explicit) {
      // 1. explicit argument beats everything, bypasses the cache too.
      if (explicit) return { project: explicit, source: 'explicit' }

      // 2. fixed mode.
      if (getMode() === 'fixed') {
        const fixed = typeof getFixedProject() === 'string' ? getFixedProject().trim() : ''
        if (!fixed) {
          throw new EngramError('engram/project-misconfigured',
            'engram/project-misconfigured: mode is fixed but no project name is configured')
        }
        return { project: fixed, source: 'fixed' }
      }

      // 3. longest-prefix match over the configured map.
      const cwd = getWorkingDir(session)
      const mapped = longestPrefixMatch(getProjectMap(), cwd)
      if (mapped) return { project: mapped, source: 'map' }

      // 4. server probe, cached per session+cwd.
      const key = `${session.id}:${cwd}`
      const hit = cache.get(key)
      if (hit) return hit
      const result = await probe(cwd)
      cache.set(key, result)
      return result
    },
  }
}
