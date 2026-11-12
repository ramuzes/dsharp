# dsh-workspace-env

Keeps toolchain cache writes inside the `workspace-write` sandbox — no
allow-listed host directories, no sandbox holes. Replaces the stock confined
bash executor with a subclass that stamps toolchain cache env vars relative
to each call's workdir (the session workspace root); interactive PTY
terminals get the same stamping. Not covered: harness-spawned LSP servers.

## Toolchains

| Toolchain | State dir | Env vars stamped |
|---|---|---|
| uv | `.uv-cache/` | `UV_CACHE_DIR=cache`, `UV_PYTHON_INSTALL_DIR=python` |
| Go | `.go-cache/` | `GOCACHE=build`, `GOMODCACHE=mod`, `GOTELEMETRYDIR=telemetry` |

`GOPATH`/`GOBIN` are deliberately not stamped; explicit caller env wins. Add
the state directories to the project `.gitignore`.

## Config

Read from the environment layers (`~/.dsh/.env` or the invocation `.env`),
per call:

| Env var | Default | Meaning |
|---|---|---|
| `DSH_WORKSPACE_ENV_TOOLS` | `uv,go` | Enabled toolchains, comma-separated; empty disables all. |
| `DSH_UV_CACHE_DIRNAME` | `.uv-cache` | uv state directory name under the workspace root. |
| `DSH_GO_CACHE_DIRNAME` | `.go-cache` | Go state directory name. |

A profile can disable or override the row (`- id: bash-workspace-env`) in its
own `cordis.patch.yml` without touching this package.

## Tests

`node --test tests/` — imports the peer `@deepseek-ai/dsh-bash-sandbox`; link
a local copy from a dsh checkout for tests only.
