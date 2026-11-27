# dsh-chrome-cdp

Operate the user's **real Chrome** over the Chrome DevTools Protocol: one
exclusive per-Session mount, a per-action approval gate, and a Plugins-page
config card. Tools appear in Sessions as `mcp__chrome-cdp__<tool>`.

Two MCP engines are selectable via `server`:

| server | npm package (pinned) | modes | notes |
|---|---|---|---|
| playwright *(default)* | `@playwright/mcp` 0.0.86 | launch / url / ws / extension | extension attaches to the **running daily browser** (Chrome/Edge) via the "Playwright Extension" - no debug port, works on any Chrome version |
| chrome-devtools | `chrome-devtools-mcp` 1.9.0 | auto / url / ws | auto attaches to the same-OS **default profile** (Chrome >=144, enable once via chrome://inspect#remote-debugging; every connection asks in-browser) |

No `browserUse` service or other dsh subsystem is required - the per-Session
mount is self-contained, so the plugin works identically on CLI, web, and
desktop distributions.

## Config

| Field | Default | Notes |
|---|---|---|
| `server` | playwright | MCP engine; see table above. |
| `mode` | extension | Per engine, see table. url/ws need `endpoint`; launch uses Playwright's own browser (`headless`, `browser` apply); extension attaches to the running browser via the Playwright Extension. |
| `endpoint` | - | http(s) or ws(s) debug address; must not be set for auto/launch/extension. |
| `channel` | stable | chrome-devtools + auto only: canary/dev/beta/stable. |
| `headless` | false | playwright + launch only. |
| `browser` | chrome | playwright + launch only: chrome/chromium/firefox/webkit/msedge. |
| `approvalPolicy` | sensitive | sensitive (read-only tools pass, state-changing ask) / all / none. |
| `readOnlyTools` | *(engine list)* | Empty = the engine's defaults; a non-empty list replaces them wholesale. |
| `toolCallTimeoutMs` | - | Per-call timeout. |

Playwright read-only defaults: browser_snapshot, browser_console,
browser_network_requests, browser_take_screenshot, browser_wait_for.
chrome-devtools read-only defaults: the 28-name list in lib/servers.js
(matched against chrome-devtools-mcp 1.9.0 - upgrading requires refreshing
the list, see lib/servers.js).

server/mode/endpoint/channel/headless/browser/toolCallTimeoutMs bind at
activation (plugin reload - a Plugins-page toggle - to apply);
approvalPolicy/readOnlyTools apply live. `/cdc` reports the mounted status
as JSON. The status section on the card shows the **mounted** state and a
"pending reload" badge when staged structural values differ.

## Security

A CDP debug endpoint is **unauthenticated**: any process that reaches it
controls the browser fully. The gate is consent, not a sandbox. Run debug
ports on loopback only, prefer a dedicated --user-data-dir, never forward
the port to a network. Headless hosts compose no approval channel - asks fail
closed.

## Development

node --test test/servers.test.js test/mount.test.js test/gate.test.js
test/wire.test.js test/client.test.js; live-host verification per the root
AGENTS.md loop (2026-11-20: playwright attach over CDP verified against a
real chromium; see git history).
