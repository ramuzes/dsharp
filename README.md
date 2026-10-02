# dsh-plugins

A pnpm-workspace monorepo of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin bundles. Each directory under `packages/` is an independent, self-contained
dsh bundle you can install into a profile on any machine — plain JavaScript,
no build step, so no `allowBuilds` authorization is needed.

## Packages

| Package | Purpose |
|---|---|
| [`packages/workspace-env`](packages/workspace-env) | Keep uv / Go toolchain cache writes inside the `workspace-write` sandbox (workspace-local `.uv-cache/`, `.go-cache/`) |

## Install from this repo

Each package is a standalone bundle, so point `dsh plugin add` at the
subdirectory (not the repo root):

```sh
# from a local checkout
dsh plugin --profile <name> add /path/to/<this-repo>/packages/workspace-env

# from git
dsh plugin --profile <name> add github:<you>/<this-repo>/packages/workspace-env
```

Or pack a tarball locally (`pnpm pack` inside the package, or `pnpm -r pack`
at the root) and install that.

## Adding a new plugin

1. `mkdir packages/<name> && cd packages/<name>`
2. Copy the layout from `packages/workspace-env`: `package.json` (with the
   `dsh.bundle.patch` field), the plugin entry (`index.js`), its
   `cordis.patch.yml`, and a `README.md`.
3. Keep dependencies to dsh **peer** packages (`@deepseek-ai/*`); no runtime
   npm dependencies — configuration goes through ordinary environment layers.

## Development

```sh
pnpm install   # optional: local peer copies for editors / tests
pnpm -r pack   # produce installable tarballs
```
