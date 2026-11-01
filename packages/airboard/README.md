# dsh-airboard

A [AirBoard](http://ab.antaresy.cc/) integration for dsh with two surfaces:

- an **AirBoard** tab in the right Sidebar (web GUI) — lists your AirBoard
  projects and their resources (ADR / PRD / SPEC / PLAN / ISSUE, grouped by
  kind, most recently updated first, dotted by lifecycle state) and renders
  the selected resource's markdown with the GUI's shared markdown renderer
  (GFM, KaTeX, code highlighting);
- **agent tools** — `airboard_search`, `airboard_read_resource`,
  `airboard_list_projects`, `airboard_create_resource`,
  `airboard_update_resource`, registered for every agent in the profile with
  a short system-prompt section explaining when to reach for them. Agents use
  the configured token through the same Host-side resolution as the viewer;
  the token itself never leaves the Host process or appears in a tool result.

Plain JavaScript, no build step: the Host half is an ordinary cordis plugin, the
browser half is one self-contained script in the client module system's factory
format.

## How it works

```
browser tab ──same-origin GET──▶ /airboard/api/… ──Host proxy──▶ AIRBOARD baseUrl/api/…
                                  (whitelisted read-only GETs,
                                   Bearer token attached host-side)
agent tools ──airboard_* tool calls──▶ Host JSON client ──────▶ AIRBOARD baseUrl/api/…
```

- AirBoard sends no CORS headers, so the browser never talks to it directly: the
  Host half (`index.js`) registers a `/airboard` prefix route on the web server
  and proxies a whitelist of read-only GET endpoints. Write and admin endpoints
  are refused with 404 in this process, before any upstream call.
- The agent tools (`lib/agent-tools.js` + `lib/agent-api.js`) speak the
  service's published read/write contract directly from the Host — search,
  full reads, create (draft), and update/transition — registered independently
  of the web server, so headless profiles get them too. Failures surface to the
  model as text naming the failure code (`airboard/unreachable`,
  `airboard/upstream-error`, …), never as raw stack traces.
- The access token lives only in the Host process. The Plugins page form never
  echoes it back (`role('secret')`), the browser half has no way to read it,
  and the tools attach it Host-side per request; a credential write re-resolves
  it live for both surfaces.
- AirBoard has no push channel, so the tab loads on open and re-navigation and
  refreshes through the tab's refresh command (the sidebar chrome's refresh
  control).

## Conversation linkage

Every finalized assistant message gains an **Open in AirBoard** action in its
hover action row. Clicking it scans that turn's text for AirBoard document ids
(`ADR-7`, `issue-12`, …): one id resolves through the service's search endpoint
and jumps straight to the document; several (or a hit in several projects) open
a small picker; none opens the plain board page. Jumps address
`dsh-resource://airboard/<project>/<id>`, which the tab claims — the tab
switches to the addressed project, selects the document, and scrolls to it.

## Configuration

The **Plugins** page shows the form directly on the AirBoard bundle's own page
(the same placement as the shipped Web Search plugin): click the AirBoard card
and edit the fields there; saves persist into the profile's `cordis.patch.yml`
and apply live. The form is the shared staged-form pattern (`SettingsFormModel`
from `ui-primitives`) — edits stage until you press Save.

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | *(none — must be set)* | AirBoard service origin; set `AIRBOARD_BASE_URL` in `~/.dsh/.env` or configure it on the Plugins page. No deployment address ships as a built-in default. |
| token (secret control) | — | AirBoard access token (`abt_…`); type once — stored in the dsh **credential store** under `AIRBOARD_TOKEN`, shown only as Configured / Not set |

The token never lands in a patch layer or a form response: the secret control
writes through `remote.credentials.set` (the Models-page API-key pattern), the
Host resolves it per boot via `ctx.credentials`, and a credential update
re-resolves live. `AIRBOARD_TOKEN` exported in the launch environment (e.g.
`~/.dsh/.env`) works unchanged, and a legacy plaintext `token` saved in the
profile patch is still honored as a read-only fallback.

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
