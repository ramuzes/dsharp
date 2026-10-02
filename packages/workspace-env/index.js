/**
 * Workspace-local toolchain state for every confined bash call.
 *
 * Replaces the stock dsh-bash-sandbox row as ctx.shell. resolve() stamps
 * toolchain cache directories relative to the already-resolved per-call
 * workdir (the session workspace root), so toolchain host-directory writes
 * (~/.cache/uv, ~/.cache/go-build, ~/go/pkg/mod, ~/.config/go/telemetry)
 * land inside the workspace-write sandbox boundary instead. spec.env beats
 * the executor's terminal overrides and is merged onto the credential-scrubbed
 * parent env by the subprocess service, so these values reach the toolchain
 * without opening any sandbox hole.
 *
 * Explicit caller entries win, matching the ${VAR:-default} semantics a
 * per-project override would expect.
 *
 * Configuration stays on the ordinary environment layers (~/.dsh/.env or the
 * invocation .env), read once at plugin load; see README.md.
 *
 * Mount: this package's cordis.patch.yml disables the stock bash-sandbox row
 * and inserts this module as ctx.shell.
 */
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

/**
 * Toolchain table. Each entry: the workspace-relative state directory
 * (default, overridable through its own env var) and the env vars stamped
 * under it (value: subdirectory relative to the state directory).
 * @satisfies {Record<string, ToolchainEntry>}
 */
const TOOLCHAINS = {
  uv: {
    dirnameEnv: 'DSH_UV_CACHE_DIRNAME',
    dirname: '.uv-cache',
    env: {
      UV_CACHE_DIR: 'cache',
      UV_PYTHON_INSTALL_DIR: 'python',
    },
  },
  go: {
    dirnameEnv: 'DSH_GO_CACHE_DIRNAME',
    dirname: '.go-cache',
    env: {
      GOCACHE: 'build',
      GOMODCACHE: 'mod',
      GOTELEMETRYDIR: 'telemetry',
    },
  },
}

/**
 * @typedef {object} ToolchainEntry
 * @property {string} dirnameEnv - env var overriding the state directory name.
 * @property {string} dirname - default state directory name under the workspace root.
 * @property {Record<string, string>} env - env var → subdirectory under the state directory.
 */

/** Comma-separated enabled toolchain list; default: all of them. */
const enabled = (process.env.DSH_WORKSPACE_ENV_TOOLS ?? Object.keys(TOOLCHAINS).join(','))
  .split(',')
  .map(tool => tool.trim())
  .filter(tool => tool !== '')

export class WorkspaceEnvBashExecutor extends SandboxBashExecutor {
  /** Same wiring as the stock sandboxing executor: confinement stays intact. */
  static inject = SandboxBashExecutor.inject

  resolve(request) {
    const spec = super.resolve(request)
    const root = spec.workdir
    if (root === undefined) return spec
    const env = { ...spec.env }
    for (const tool of enabled) {
      const chain = TOOLCHAINS[tool]
      if (chain === undefined) continue
      const state = `${root}/${process.env[chain.dirnameEnv] ?? chain.dirname}`
      for (const [name, subdir] of Object.entries(chain.env)) {
        if (env[name] === undefined) env[name] = `${state}/${subdir}`
      }
    }
    return { ...spec, env }
  }
}

export default WorkspaceEnvBashExecutor
