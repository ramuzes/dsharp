# dsh-engram

A dsh plugin that embeds [engram](https://github.com/) memory for agents: it
stewards the local engram daemon (health probe, auto-spawn or connect-only),
registers curated memory tools (`engram_search`, `engram_save`,
`engram_context`, `engram_timeline`, `engram_stats`, `engram_projects`, plus
`engram_cloud_status`), bridges DSH↔engram session lifecycles, and optionally
injects a memory summary into the prompt. Secrets (daemon HTTP token, cloud
sync credentials) live only in the dsh credential store; configuration follows
ADR-0005 — no deployment values baked into source.

Design and full spec: see `docs/specs/2026-11-20-engram-memory-plugin-design.md`
and `docs/plan/2026-11-21-engram-memory-plugin.md` in the repository root.

## Install

Plugins → **Add plugin** → point it at this package's local directory
(`packages/engram`). The bundle layer (`cordis.patch.yml`) mounts the host
half on one row (`engram`); enabling the bundle starts it. The Plugins page
shows the configuration card documented below on the bundle's detail page.

## Configuration reference

All fields live on the Loader row `engram` and are edited on the Plugins
page (the bundle's config card) or defaulted through the bundle's patch
layer. Secrets appear only as credential-ref **names**, resolved through
`ctx.credentials` at mount time — never as values.

| Field | Type | Default | Volatile | Meaning |
| --- | --- | --- | --- | --- |
| `daemonMode` | `auto-spawn` \| `connect-only` | `auto-spawn` | no | Daemon stewardship (see below). Structural: edits take effect after plugin reload. |
| `port` | string | `''` | yes | Daemon port. Empty uses engram's documented protocol default (7437). |
| `httpTokenRef` | credential-ref name | `''` | yes | Credential-store reference naming the daemon HTTP token. Empty = the daemon takes no auth. |
| `projectMode` | `auto` \| `fixed` \| `map` | `auto` | yes | How a session resolves its engram project: from the working directory (`auto`), one fixed project (`fixed`), or the `projectMap` table (`map`). |
| `fixedProject` | string | `''` | yes | The engram project used when `projectMode=fixed`. |
| `projectMap` | dict (string → string) | `{}` | yes | Working-directory name → engram project mapping for `projectMode=map`. |
| `contextInjection` | `off` \| `on` | `off` | yes | When `on`, injects a memory summary into every prompt (fail-open: injection failure never blocks the turn). |
| `contextMaxBytes` | number ≥ 0 | `2048` | yes | Byte cap for the injected summary. |
| `cloudServerRef` | credential-ref name | `''` | yes | Credential-store reference naming the engram cloud service address. Empty = cloud sync not configured. |
| `cloudTokenRef` | credential-ref name | `''` | yes | Credential-store reference naming the cloud sync token. |
| `autosync` | boolean | `false` | yes | Sync memory changes to the cloud automatically (requires the cloud references). |
| `toolProfile` | `core` \| `extended` | `core` | yes | Tool surface. v1 registers the core set only; `extended` is reserved. Not shown on the config card (advanced). |

"Volatile" fields apply live: a Plugins-page save is picked up by the running
plugin without a reload (config is re-read per call). `daemonMode` is the one
exception — it changes mount-time stewardship structure, so saving it prints
a reload hint in its field hint.

## Daemon stewardship

- **`auto-spawn`** (default): on mount the host half probes the configured
  daemon endpoint; if unreachable, it spawns a local engram daemon as a
  managed subprocess (credential refs are resolved into env for the child).
  The stewardship is memoized: a daemon dying mid-session is detected on the
  next use and re-spawned with recovery, instead of leaving dead tools.
- **`connect-only`**: the plugin never spawns anything; it connects to an
  already-running daemon and reports tools degraded/unavailable when it
  cannot reach it. Choose this when you run engram yourself (systemd,
  container, another machine via `port`).

## Save-worthiness (what the host keeps)

Edits staged on the config card become durable only through the form's
**Save** (one revision-fenced document mutation per save; discard-on-unmount
otherwise). Accepted saves persist into the profile patch layer — volatile
fields take effect immediately AND survive restarts; leaving the page or the
bundle drops staged drafts. Per-field "overridden" badges preview what a
save would store, and the per-field **Reset** stages a clear that re-inherits
the composition layer. See the prompt section of the design spec for the
full layered-config model.

## Limitations (v1)

- **Core memory surface only**: no update, delete, pin, review, conflict
  resolution, or decay tooling — v1 registers search / save / context /
  timeline / stats / projects (plus the cloud status tool). Those flows stay
  in the engram CLI for now.
- **Enrollment is a CLI action**: joining a project or device to engram is
  done with engram's own CLI, not from DSH.
- **Cloud sync is configure-only**: the plugin reports sync status
  (`engram_cloud_status`) and flips `autosync`; it adds no sync protocol of
  its own.
- **Per-session MCP mode** (attaching engram's own MCP server per session
  instead of the built-in tools) is future work, not in v1.
- **No live status card**: the Plugins-page card is configuration only; a
  live daemon status section would need a Remote namespace (chrome-cdp's
  status card is the precedent) — deferred to v2.
