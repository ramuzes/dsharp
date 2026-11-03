# dsh-chrome-cdp

Operate the user's **real Chrome** over the Chrome DevTools Protocol through
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp): one
exclusive per-Session mount, a per-action approval gate, and a Plugins-page
config card. The host half (`index.js`) mounts the MCP server per live Session
via the browser-use runtime; the browser half (`client.js`) renders the config
card on the Plugins page.

- Tools appear in Sessions as `mcp__chrome-cdp__<tool>` (navigate, snapshot,
  click, evaluate, … — the full chrome-devtools-mcp surface).
- One Session owns the browser at a time (`exclusive: true`); a second Session
  sees the tools masked while the first holds the mount.

## Install

```bash
# into the profile you use (omit --profile for the default):
dsh plugin --profile <name> add dsh-chrome-cdp        # from the registry
dsh plugin --profile <name> add ./dsh-chrome-cdp-0.1.0.tgz   # from a tarball
```

The plugin activates only when the `browserUse` service exists in the profile.
Base/headless profiles do not provide it, so add the service row to the
profile's `cordis.patch.yml` (the same shape dsh's own browser-use session
snapshots use):

```yaml
- insert:
    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'
```

Without it the row stays `pending (waiting for service: browserUse)` and no
`mcp__chrome-cdp__*` tools are registered.

## Connection modes

All config lives on the `chrome-cdp` loader row (patch the row's `config` in
your profile's `cordis.patch.yml`, or use the Plugins-page card). `mode` is
required.

### `auto` — same-OS Chrome ≥ 144

Connects to a locally running Chrome through its user-data directory. In the
Chrome instance, enable the remote debugging server once via
`chrome://inspect/#remote-debugging`, keep Chrome running, then:

```yaml
- id: chrome-cdp
  config:
    mode: auto
    channel: stable   # canary | dev | beta | stable — which install to find
```

`channel` is meaningful (and legal) **only** in `auto` mode — it selects which
Chrome channel's profile to attach to. `endpoint` must not be set.

### `url` — HTTP debug endpoint (incl. WSL → Windows)

Attach to a Chrome already listening on a debugging port. Start it with
`--remote-debugging-port=9222` (a dedicated profile is safer:
`--user-data-dir=...`), then:

```yaml
- id: chrome-cdp
  config:
    mode: url
    endpoint: http://127.0.0.1:9222
```

WSL note: Chrome on Windows binds its debug port to the Windows loopback. From
WSL2, reach it via the Windows host (mirrored networking: `127.0.0.1` works;
NAT networking: the host IP from `/etc/resolv.conf`, or forward with
`netsh interface portproxy add v4tov4 listenport=9222 connectaddress=127.0.0.1
connectport=9222` on Windows) and set `endpoint` accordingly, e.g.
`http://<windows-host>:9222`.

### `ws` — WebSocket endpoint

Same as `url` but through the browser-level WebSocket. Take the exact URL from
`http://<host>:9222/json/version` → `webSocketDebuggerUrl`:

```yaml
- id: chrome-cdp
  config:
    mode: ws
    endpoint: ws://127.0.0.1:9222/devtools/browser/<uuid>
```

## Approval policies and the default read-only list

Every `mcp__chrome-cdp__*` call passes a per-action gate before it reaches the
browser:

| `approvalPolicy` | Behavior |
|---|---|
| `sensitive` *(default)* | read-only tools run silently; every state-changing tool asks Allow/Deny |
| `all` | every tool asks Allow/Deny |
| `none` | no prompts; all tools run |

In the Web GUI the ask renders as Allow/Deny on the streamed tool-call card. In
headless/one-shot runs **no approval channel is composed**, so any ask resolves
fail-closed: the call fails with `requires approval, but no approval channel is
available` instead of running. That is by design — consent cannot be bypassed by
picking a channel-less host.

Default read-only list (`sensitive` passes these without asking; override via
`readOnlyTools`):

```
list_pages, list_network_requests, list_console_messages, list_extensions,
list_webmcp_tools, get_network_request, get_console_message, get_tab_id,
get_os_app_state, take_snapshot, take_screenshot, wait_for,
performance_start_trace, performance_stop_trace, performance_analyze_insight,
take_heapsnapshot, close_heapsnapshot, compare_heapsnapshots,
query_heapsnapshot_objects, get_heapsnapshot_class_nodes,
get_heapsnapshot_details, get_heapsnapshot_dominators,
get_heapsnapshot_duplicate_strings, get_heapsnapshot_edges,
get_heapsnapshot_object_details, get_heapsnapshot_retainers,
get_heapsnapshot_retaining_paths, get_heapsnapshot_summary
```

## Config reference

| Field | Default | Notes |
|---|---|---|
| `mode` | — *(required)* | `auto` \| `url` \| `ws` |
| `endpoint` | — | required for `url`/`ws`; must not be set for `auto` |
| `channel` | `stable` | `auto` mode only; `[a-z][a-z0-9-]*` |
| `approvalPolicy` | `sensitive` | `sensitive` \| `all` \| `none` |
| `readOnlyTools` | list above | tool names without the `mcp__chrome-cdp__` prefix |
| `toolCallTimeoutMs` | — | per-call timeout handed to the runtime |

### Reload semantics

The mount binds structural fields at activation, so **`mode`, `endpoint`,
`channel`, and `toolCallTimeoutMs` take effect after a plugin reload** (host
restart, or toggle the plugin on the Plugins page) — not on the next Session.
The behavioral fields **`approvalPolicy` and `readOnlyTools` are volatile and
apply live**, including edits made on the Plugins-page card, with no reload.
The `/cdc` status below reports the *mounted* structural truth, so it can lag a
just-edited endpoint until the reload happens — that lag is the honest view.

## `/cdc` and the Plugins card

`/cdc` in any Session (or the Plugins-page card) reports the config-derived
status as JSON: `mode`, `endpoint`, `channel`, `approvalPolicy`,
`readOnlyToolCount`, `serverEntry`, `exclusive`. The Plugins-page card edits all
volatile fields with spec-level validation of legal values.

## Security baseline

A CDP debug endpoint is **unauthenticated**: any local process that can reach
it has full control of the browser — every cookie, every logged-in session,
every page. This plugin's gate is **consent, not a sandbox**: it decides whether
an action may *be asked about*, it does not isolate what an approved action (or
a rogue neighbor process) can do. Run Chrome's debug port on loopback only,
prefer a dedicated `--user-data-dir`, never forward `9222` to a network, and
stop the debug port when you are done.

## Live-host verification (AGENTS.md loop)

Verified 2026-10-19 on a real dsh host (hermetic `DSH_HOME` rig, `headless`
profile, local Chromium 129 on `--remote-debugging-port=9224`, glm-5.3):

- `--dump-config` exit 0; the composed tree carries the `chrome-cdp` row from
  this bundle's own `cordis.patch.yml`.
- `approvalPolicy: none` E2E: the agent opened `https://example.com` through
  `mcp__chrome-cdp__new_page` and answered from the real browser — title
  `"Example Domain"`, `2` tabs — confirmed against the live browser's own
  page list (`1: about:blank`, `2: Example Domain`).
- `approvalPolicy: sensitive` E2E: `new_page`/`evaluate_script` were gated, the
  ask resolved `outcome: "unavailable"` (no approval channel composed), and
  the tools returned `requires approval, but no approval channel is available`;
  read-only `list_pages` still worked. Fail-closed by design.
- Both runs exited 0 with no `dsh: fatal` lines; the host stayed stable.
- This live loop caught a real defect the unit suite missed: chrome-devtools-mcp
  1.9.0 declares `channel` mutually exclusive with `browserUrl`/`wsEndpoint`
  (`build/src/config/browser-options.js`), so `--channel` is now emitted in
  `auto` mode only (fixed TDD, 29/29 unit tests green).
