# dsh-airboard

A read-only [AirBoard](http://ab.antaresy.cc/) viewer for the dsh web GUI. Adds
an **AirBoard** tab to the right Sidebar — the surface where workspace files
preview — that lists your AirBoard projects and their resources (ADR / PRD /
SPEC / PLAN / ISSUE, grouped by kind, dotted by lifecycle state) and renders the
selected resource's markdown with the GUI's shared markdown renderer (GFM,
KaTeX, code highlighting).

Plain JavaScript, no build step: the Host half is an ordinary cordis plugin, the
browser half is one self-contained script in the client module system's factory
format.

## How it works

```
browser tab ──same-origin GET──▶ /airboard/api/… ──Host proxy──▶ AIRBOARD baseUrl/api/…
                                  (whitelisted read-only GETs,
                                   Bearer token attached host-side)
```

- AirBoard sends no CORS headers, so the browser never talks to it directly: the
  Host half (`index.js`) registers a `/airboard` prefix route on the web server
  and proxies a whitelist of read-only GET endpoints. Write and admin endpoints
  are refused with 404 in this process, before any upstream call.
- The access token lives only in the Host process. The Plugins page form never
  echoes it back (`role('secret')`), and the browser half has no way to read it.
- AirBoard has no push channel, so the tab loads on open and re-navigation and
  refreshes through the tab's refresh command (the sidebar chrome's refresh
  control).

## Configuration

Two fields on the `airboard` row, editable live on the **Plugins** page
(saves persist into the profile's `cordis.patch.yml`):

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://ab.antaresy.cc` | AirBoard service origin |
| `token` | (empty) | AirBoard access token (`abt_…`) — shown as a secret |

Environment fallbacks seed the row's defaults through the bundle patch layer:
`AIRBOARD_BASE_URL`, `AIRBOARD_TOKEN` (e.g. in `~/.dsh/.env`). A value saved
through the Plugins page wins, per the usual layer order.

Tip: mint a **project-scoped, non-global** token on AirBoard's `/tokens` page
for the viewer — least privilege (AirBoard tokens are not read-only; this plugin
simply never calls a write endpoint, and neither does its proxy). Trust posture:
anyone who can open this GUI can read everything the configured token can read.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsharp/packages/airboard
dsh --profile <name> web
```

Open the GUI, pick the AirBoard entry in the right Sidebar's add-tab menu (or
the guide page), configure the token on the Plugins page if you have not set
`AIRBOARD_TOKEN`.

## Development

```sh
pnpm test     # node --test: proxy whitelist/handler, client plugin contract
```

- `index.js` — Host half: row `Config` (schemastery) + the `/airboard` proxy.
- `client.js` — browser half: `__ModuleLoader__.load` factory registering the
  tab type (`ctx.sidebarRightTabs`), the keyed `sidebar.right.pane.tab` body,
  and the `airboard` locale namespace; styles are one attribute-scoped sheet.
- `tests/` — `host.spec.js` covers the whitelist and handler against a stubbed
  fetch; `client.spec.js` boots the script against a stub loader and drives the
  tab body through a tiny hook harness.

`@deepseek-ai/schemastery` is a peer at runtime (the host provides it); for
tests, `node_modules/@deepseek-ai/schemastery` is a symlink into a dsh checkout
(the same arrangement `workspace-env` uses).
