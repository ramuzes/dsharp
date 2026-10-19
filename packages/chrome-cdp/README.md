# dsh-chrome-cdp

Operate the user's real Chrome over CDP via chrome-devtools-mcp.

Status: scaffold — full documentation lands with the final task.

Connection modes: `auto` (Chrome >=144 approval mode via --auto-connect),
`url` (--browser-url, e.g. port-mapped endpoints), `ws` (--ws-endpoint).

Security baseline: CDP debug endpoints are unauthenticated; any local
process that can reach the endpoint has full browser control. This plugin's
mitigation is the per-action approval gate — it is NOT a sandbox.
