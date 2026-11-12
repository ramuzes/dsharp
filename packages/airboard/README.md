# dsh-airboard

An [AirBoard](http://ab.antaresy.cc/) integration for dsh with two surfaces:
an **AirBoard tab** in the right Sidebar (browse projects and ADR / PRD /
SPEC / PLAN / ISSUE resources, markdown-rendered) and **agent tools**
(`airboard_search` / `airboard_read_resource` / `airboard_list_projects` /
`airboard_create_resource` / `airboard_update_resource`). The token never
leaves the Host process.

## Config

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | *(must be set)* | AirBoard service origin (`AIRBOARD_BASE_URL` env or the Plugins-page form). |
| token (secret control) | — | Access token (`abt_…`); stored in the dsh credential store under `AIRBOARD_TOKEN`, shown only as Configured / Not set. `AIRBOARD_TOKEN` env works; a legacy plaintext `token` in the profile patch is honored read-only. |

Tip: mint a project-scoped, non-global token — least privilege. Anyone who
can open this GUI can read everything the configured token can read.

## Notes

- The browser talks to a same-origin `/airboard` Host proxy (whitelisted
  read-only GETs, token attached host-side); write endpoints answer 404 in
  this process. Agents use the same Host-side token resolution, so headless
  profiles get the tools too.
- Finalized assistant messages gain an **Open in AirBoard** action: it scans
  the turn for AirBoard ids (`ADR-7`, `issue-12`, …) and jumps to the
  document.
- No push channel: the tab loads on open and refreshes via its refresh
  command.

## Development

`node --test tests/` — see file-level comments for the host/client halves;
live-host verification per the root AGENTS.md loop.
