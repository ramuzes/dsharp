# dsh-workspace-env

Part of the [dsh-plugins](../README.md) monorepo.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle
that keeps toolchain cache writes inside the `workspace-write` sandbox — no
allow-listed host directories, no sandbox holes.

It replaces the stock confined bash executor (`dsh-bash-sandbox` row) with a
subclass that stamps toolchain cache env vars relative to each call's workdir
(the session workspace root), so the toolchains write under the workspace
instead of `~/.cache/uv`, `~/.cache/go-build`, `~/go/pkg/mod`, or
`~/.config/go/telemetry`.

Two execution surfaces are covered:

- **Agent bash tool** — through the executor subclass's `resolve()`.
- **Interactive PTY terminals** (terminal-bash/pwsh) — they bypass `ctx.shell`
  and build their own child env, so the plugin also wraps
  `ctx.subprocess.spawnTerminal` for its lifetime and stamps the same entries
  from the PTY's cwd. Registering a wrapping backend is not possible
  (`DUPLICATE_BACKEND`), so the wrap is installed in the plugin constructor
  and removed on dispose.

Not covered: LSP servers (e.g. gopls) spawned by the harness run unconfined
and keep using host toolchain caches.

## Toolchains and layout

| Toolchain | State dir | Env vars stamped |
|---|---|---|
| uv | `.uv-cache/` | `UV_CACHE_DIR=cache`, `UV_PYTHON_INSTALL_DIR=python` |
| Go | `.go-cache/` | `GOCACHE=build`, `GOMODCACHE=mod`, `GOTELEMETRYDIR=telemetry` |

Explicit caller env entries always win over the stamped defaults.

`GOPATH`/`GOBIN` are deliberately not stamped: `go install` targets stay
caller-owned, and `GOMODCACHE` alone covers the module-cache writes.

## Install into a profile

From a local checkout:

```sh
dsh plugin --profile <name> add /path/to/dsh-workspace-env
```

From git (plain JavaScript, no build step, so no `allowBuilds` authorization
is needed):

```sh
dsh plugin --profile <name> add github:<you>/dsh-plugins/packages/workspace-env
```

Or as a tarball (`pnpm pack`, then):

```sh
dsh plugin --profile <name> add ./dsh-workspace-env-0.1.0.tgz
```

Verify the layer with `dsh --profile <name> --dump-config` (look for the
`# == dsh-workspace-env` layer), then start the profile.

## Configuration

All knobs ride the ordinary environment layers (`~/.dsh/.env` or the
invocation `.env`), read at each call:

| Env var | Default | Meaning |
|---|---|---|
| `DSH_WORKSPACE_ENV_TOOLS` | `uv,go` | Comma-separated enabled toolchains; empty disables all. |
| `DSH_UV_CACHE_DIRNAME` | `.uv-cache` | uv state directory name under the workspace root. |
| `DSH_GO_CACHE_DIRNAME` | `.go-cache` | Go state directory name under the workspace root. |

Example: reuse an existing project-local `.gocache` directory by putting
`DSH_GO_CACHE_DIRNAME=.gocache` in that project's `.env`.

Add the state directories to the project `.gitignore` (`.uv-cache/`,
`.go-cache/`) if they are not ignored already.

## Overriding or disabling

The user profile's own `cordis.patch.yml` applies after every bundle layer,
so a profile can disable this row (`- id: bash-workspace-env` /
`disabled: true`) or override it without touching this package.

## Tests

```sh
node --test tests/
```

The tests import the peer `@deepseek-ai/dsh-bash-sandbox`; link a local copy
from a DeepSeek Harness checkout first (`node_modules/@deepseek-ai/dsh-bash-sandbox`
→ the checkout's `packages/shell/bash-sandbox`). It is gitignored and only
needed for tests; the dsh runtime resolves the peer itself.
