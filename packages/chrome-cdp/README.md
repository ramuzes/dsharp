# dsh-chrome-cdp

Operate the user's **real Chrome** over the Chrome DevTools Protocol through
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp):
one exclusive per-Session mount, a per-action approval gate, and a
Plugins-page config card. Tools appear as `mcp__chrome-cdp__<tool>`.

## Config

| Field | Default | Notes |
|---|---|---|
| `mode` | — *(required)* | `auto` (attach same-OS Chrome ≥144 by channel) \| `url` (HTTP debug endpoint, incl. WSL→Windows) \| `ws` (browser-level WebSocket) |
| `endpoint` | — | Required for `url`/`ws`; must not be set for `auto`. |
| `channel` | `stable` | `auto` only; `canary \| dev \| beta \| stable`. |
| `approvalPolicy` | `sensitive` | `sensitive` (read-only tools pass, state-changing ask) \| `all` \| `none`. |
| `readOnlyTools` | built-in list | Tool names passed without asking under `sensitive`. |
| `toolCallTimeoutMs` | — | Per-call timeout. |

`mode`/`endpoint`/`channel`/`toolCallTimeoutMs` bind at activation (reload to
apply); `approvalPolicy`/`readOnlyTools` apply live. `/cdc` reports the mounted
status as JSON. Activation requires the `browserUse` service row in the
profile; without it the row stays pending.

## Security

A CDP debug endpoint is **unauthenticated**: any local process that reaches it
controls the browser fully. The gate is consent, not a sandbox. Run the debug
port on loopback only, prefer a dedicated `--user-data-dir`, never forward it
to a network. Headless hosts compose no approval channel — asks fail closed.

## Development

`node --test tests/*.spec.js`; live-host verification per the root AGENTS.md
loop (last verified 2026-10-19, see git history for the record).
