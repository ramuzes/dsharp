# chrome-cdp — Bring the user's real Chrome into DSH over CDP

## Requirement (the why & what)

### Problem statement

The user keeps login sessions and working context in their browser, while the agent can only view pages through the stateless web_fetch. The user wants the agent to operate the Chrome they are actually using, with sensitive actions gated by human approval — a Kimi WebBridge-like experience, but without depending on its closed-source components, and with per-action approval instead of WebBridge's connect-once authorization.

### Goal

After installing the chrome-cdp bundle: the agent gets the full chrome-devtools-mcp browser toolset, acting on the real browser instance the user designates (three connection modes, environment-agnostic); sensitive actions prompt Allow/Deny in the Web GUI one by one; connection and policy are configurable on the Plugins page with live effect; status is queryable. The B spike has proven every host mechanism is in place — this plugin is an assembly layer.

### User stories

1. As a user, I want the agent to operate the Chrome I am using (with my logins), so that browsing-based information and actions can be delegated to the agent.
2. As a user, I want to choose the connection mode (auto / url / ws), so that same-machine default profiles (Chrome ≥144 approval mode), port mappings (WSL→Windows and the like), or any reachable debug endpoint all work — the plugin makes no network-topology assumptions.
3. As a user, I want sensitive browser actions to prompt Allow/Deny by default while read-only actions pass silently, so that nothing touches my browser without consent, without being spammed.
4. As a user, I want to switch the approval policy between all / sensitive / none, so that I can tighten or loosen per scenario.
5. As a user, I want to edit the endpoint and policy on the Plugins page with immediate effect (from new sessions on), so that switching browsers never restarts the host.
6. As a user, I want to check connection health at any time (DevToolsActivePort probe result, mount ownership, upstream version), so that "the browser is not responding" is diagnosable.
7. As a user, I want a second session to never steal the browser connection already in use (exclusive attach with an explicit error), so two agents never operate the same browser at once.
8. As an agent, I want to take_snapshot / take_screenshot before acting, so that actions are grounded in what the page actually shows.

### Out of scope

- Bridging to the Kimi WebBridge daemon (feasible per the research note; left as a future provider option).
- A Web GUI sidebar browser panel (tab list / action feed view).
- The launch (disposable browser) mode — already covered by the in-tree browser-use-chrome-devtools-mcp.
- WSL↔Windows network plumbing (port mapping, mirrored networking are the environment's responsibility; the plugin only consumes endpoints).
- Desktop-level computer-use control.

## Design (the how)

### Solution

One dsharp bundle (host half + client half). The host half registers as a provider of the browser-use subsystem: it assembles chrome-devtools-mcp launch arguments per the connection mode and reuses the host's per-Session mounting semantics (exclusive attach, busy-session masking, discovery awaited during creation); it also registers the global approval gate and a status command. The client half provides a config card and connection status on the Plugins page.

### Implementation decisions

- **Connection modes** (Config, enum):
  - `auto`: pass through `--auto-connect` (Chrome ≥144 approval mode; `channel` defaults to stable, configurable). The plugin never reads the port file — the upstream resolves DevToolsActivePort itself. Note `auto` implicitly assumes the browser lives in the same environment as DSH (same-OS default profile directory); cross-environment setups (e.g. WSL→Windows) use `url` plus a port mapping.
  - `url`: pass through `--browser-url <endpoint>` (an HTTP endpoint; covers port-mapped setups).
  - `ws`: pass through `--ws-endpoint <endpoint>` (a browser-level WebSocket endpoint).
  - `--no-usage-statistics` is always appended.
- **Approval gate**: a global `tools/pre-execute` listener matching the `mcp__chrome-cdp__` prefix; per policy and read-only list it returns ask (bilingual displayReason, audited reason) or allow; anything not matching the prefix is passed through. The ask UI and audit trail are owned by the host approval service (fail-closed when no channel is composed).
  - Default read-only list (chrome-devtools-mcp 1.9.0 tool surface): list_pages, list_network_requests, list_console_messages, list_extensions, list_webmcp_tools, get_network_request, get_console_message, get_tab_id, get_os_app_state, take_snapshot, take_screenshot, wait_for, performance_start_trace, performance_stop_trace, performance_analyze_insight, take_heapsnapshot, close_heapsnapshot, compare_heapsnapshots, query_heapsnapshot_objects, get_heapsnapshot_* (9 tools).
  - Policies: `sensitive` (default; everything off the list is asked), `all` (ask for everything), `none` (allow everything).
  - The list and policy are Config fields; the read-only list replaces wholesale (a user-provided list fully supersedes the default).
- **Config** (schemastery; volatile marks live-editable fields): connection mode, endpoint, channel, approval policy, read-only list override, tool-call timeout. Volatile semantics follow the host: edits are written back to the profile patch and take effect for new mounts.
- **Dependencies**: all dsh packages as peer `*` (resolved with the host); `chrome-devtools-mcp` pinned exactly to 1.9.0 (a stable tool-name surface is the precondition for the approval lists).
- **Upstream verification (implementation step 0)**: confirm the published browser-use-runtime ships the `./mcp` export and `mountSessionMcp`; if missing, vendor the minimal mounting core (scope + agent/created + mcp-client plugin), citing provenance and differences in code comments, and record the decision back into this SPEC.
- **Status**: a `/cdc` slash command (dsh-commands) + a status area on the Plugins card: connection mode, endpoint/channel, upstream version, current mount-owning session; probing never connects to the browser (no extra approval popups) — it only composes diagnostic text from current config.
- **Containment**: every callback wrapped in safely; mount lifecycle owned by host effects; status files named per profile.
- **Per-Session exclusivity**: the host browser-use semantics apply (exclusive attach, busy-session tool masking).

### Testing decisions

- **Unit tests** (node --test, strict fakes): the approval-gate policy matrix (sensitive/all/none × read-only/sensitive/off-prefix tools → allow/ask), argument assembly (three connection modes + flags), config validation (illegal mode / missing endpoint). Fakes replicate the pre-execute payload shape and waterfall semantics strictly (including next() delegation) with no loosened fields.
- **Live-host verification loop** (required by AGENTS.md): reuse the B-spike rig (workspace .scratch test home + headless profile + local chromium debug port): (1) end-to-end with policy none (agent drives the real browser); (2) under policy sensitive a sensitive tool is gated (fail-closed error visible when no approval channel); (3) host stable throughout, no dangling rejections.
- **GUI manual check** (once): on an fgtest host with policy sensitive, a sensitive browser action prompts Allow/Deny in the Web GUI; Allow proceeds, Deny rejects (the model receives an explicit rejection reason).
- **Prior art**: feishu-gateway's strict-fake tests and live-host loop.

## Further notes

- Background and feasibility: docs/research/2026-10-19-dsh-cdp-browser-control.md (includes the B-spike record and the two practical pitfalls).
- Architecture decision record: docs/adr/0004-chrome-cdp-via-browser-use-mcp.md.
- Security baseline: debug endpoints are unauthenticated — any local process can connect. This plugin's mitigations are the approval gate plus explicit documentation; it must not claim sandbox isolation.
