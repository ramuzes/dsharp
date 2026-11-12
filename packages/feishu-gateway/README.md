# dsh-feishu-gateway

Feishu (Lark) bot gateway: connects one Feishu custom-app bot's **p2p chat**
to dsh. Messages drive a bound workspace session; structured questions and
permission approvals round-trip as interactive cards; workspace / session /
model switching happens inside the chat with a status card echo.

Chinese README: `README.zh-CN.md`. Development rules: `DEVELOPMENT.md` and the
root `AGENTS.md`.

## Config

| Field | Description |
|---|---|
| `appId` | Feishu custom-app App ID (`cli_`-prefixed) |
| App Secret (secret control) | Typed once, stored in the dsh **credential store** (`FEISHU_APP_SECRET` ref); never echoed back. Exporting `FEISHU_APP_SECRET` also works (headless). |
| `domain` | `https://open.feishu.cn` (`https://open.larksuite.com` international) |

Unresolved credentials leave the plugin silently inactive (one log line).

## Feishu console checklist

1. Custom app → add capability **Bot**; **create a version and publish**.
2. Permissions (after release): `im:message`, `im:message.p2p_msg`,
   `im:chat:readonly`, `im:resource`.
3. Events: subscription mode **persistent connection**, event
   `im.message.receive_v1`.
4. Callbacks: **long connection**, configure `card.action.trigger` (a 200340
   error on button presses usually means this is misconfigured).
5. Availability scope: add users so they can chat with the bot.

## Chat commands

| Command | Effect |
|---|---|
| `/ws [list]` / `/ws use <name>` / `/ws new <path> [title]` | Workspace list / switch pointer / register+bind |
| `/session [list]` / `/session new` / `/session resume [idx\|prefix]` | Session list / new / resume (idle required) |
| `/stop` / `/release` | Interrupt the turn / detach IM delivery (binding kept) |
| `/model` | Model picker (selectable while running, effective next turn) |
| `/status` / `/doctor` / `/help` | Status card / self-check / help |

Plain text goes to the active session (steering while running); each turn ends
with the final reply (markdown→rich text, chunked) and a changes card.
Questions and approvals are answered via card buttons.
