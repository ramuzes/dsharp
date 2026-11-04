# dsh-plugins

A pnpm-workspace monorepo of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin bundles. Each directory under `packages/` is an independent, self-contained
dsh bundle you can install into a profile on any machine — plain JavaScript,
no build step, so no `allowBuilds` authorization is needed.

## Packages

| Package | Purpose |
|---|---|
| [`packages/workspace-env`](packages/workspace-env) | Keep uv / Go toolchain cache writes inside the `workspace-write` sandbox (workspace-local `.uv-cache/`, `.go-cache/`) |
| [`packages/airboard`](packages/airboard) | Read-only AirBoard viewer for the web GUI: a right-Sidebar tab over a host-side `/airboard` proxy (configurable service address + token) |
| [`packages/feishu-gateway`](packages/feishu-gateway) | Feishu (Lark) bot gateway: bind a p2p bot chat to a workspace session — messages run tasks, questions/approvals round-trip as interactive cards |

## Install from this repo

Each package is a standalone bundle, so point `dsh plugin add` at the
subdirectory (not the repo root) — the pnpm `#path:` fragment selects it:

```sh
# from a local checkout (run at the repo root)
dsh plugin --profile <name> add ./packages/workspace-env

# from git
dsh plugin --profile <name> add "github:ramuzes/dsharp#path:packages/workspace-env"
```

Swap the subdirectory (`packages/airboard`, `packages/feishu-gateway`,
`packages/chrome-cdp`) to install another package.

Or pack a tarball locally (`pnpm pack` inside the package, or `pnpm -r pack`
at the root) and install that.

## Install via the plugin market (Discover)

dsh's **Custom plugin indexes** feature can browse and install every plugin in
this repository from one URL. In the dsh Web GUI open
**Plugins → Discover → Add index source** and paste:

```
https://raw.githubusercontent.com/ramuzes/dsharp/master/market/index.json
```

Each entry is pinned to the last commit that touched its package, so installs
are reproducible; installation clones `github.com/ramuzes/dsharp` at that
commit. Requires a dsh with the *Custom plugin indexes* experimental bundle
turned on.

### Regenerating the index

`market/index.json` is generated with dsh's reference generator
(`apps/plugin-market-generator`) from the pushed state of this repository.
Regenerate after your plugin changes are on `master`, then commit the result
(paths must be absolute — the generator resolves them against the directory
where pnpm runs):

```sh
D=/path/to/dsharp        # this repository
H=/path/to/deepseek-harness
(cd "$H" && pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input "$D/market/plugins.txt" --output "$D/market/index.json" \
  --cache "$D/.scratch/market-cache" --title "dsharp plugins")
git -C "$D" add market/index.json && git -C "$D" commit -m "market: regenerate index"
```

Design notes: [ADR 0006](docs/adr/0006-plugin-market-index.md). Index format
and hosting rules (with dsh source citations):
[plugin-market research](docs/research/2026-11-03-dsh-plugin-market-index.md).

## Adding a new plugin

1. `mkdir packages/<name> && cd packages/<name>`
2. Copy the layout from `packages/workspace-env`: `package.json` (with the
   `dsh.bundle.patch` field), the plugin entry (`index.js`), its
   `cordis.patch.yml`, and a `README.md`. For a plugin with web-GUI UI, copy
   `packages/airboard` instead — it adds the browser half (`client.js`,
   `dsh.client`, `locale/`, `icon.svg`).
3. Keep dependencies to dsh **peer** packages (`@deepseek-ai/*`); no runtime
   npm dependencies — configuration goes through ordinary environment layers.

## Development

```sh
pnpm install   # optional: local peer copies for editors / tests
pnpm -r pack   # produce installable tarballs
```
