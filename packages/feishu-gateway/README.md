# dsh-feishu-gateway

Feishu (Lark) bot gateway: connects one Feishu custom-app bot's **p2p chat**
to dsh. Messages drive a bound workspace session; structured questions and
permission approvals round-trip as interactive cards; workspace / session /
model switching happens inside the chat with a status card echo.

- Design doc: `docs/specs/2026-10-09-feishu-gateway-design.md` (Chinese)
- Chinese README: `README.zh-CN.md`
- Uses the official Feishu Node SDK (`@larksuiteoapi/node-sdk`, plain JS,
  no build scripts)

## Install

```sh
dsh plugin --profile <name> add /path/to/dsharp/packages/feishu-gateway
```

> **Upgrade note**: the client module system caches "this Loader row is not
> a client package" until host restart. If you previously installed a
> version without the browser half, you must **restart the dsh host** and
> refresh the page after upgrading for the Plugins-page config card to
> appear; fresh installs (host started/reloaded after install) are not
> affected.

## Configuration

Configure on the Web GUI **Plugins page** (the bundle card's config form,
registered by the browser half):

| Field | Description |
|---|---|
| `appId` | Feishu custom-app App ID (`cli_`-prefixed) |
| App Secret (secret control) | Typed once, stored in the dsh **credential store** (`FEISHU_APP_SECRET` ref); shows 已配置/未配置, never echoed back |
| `domain` | `https://open.feishu.cn` (`https://open.larksuite.com` for the international version) |

**The secret never enters a patch layer**: the secret control writes
through `remote.credentials.set` into the credential store (same pattern as
the Models-page API keys); the host resolves it via `ctx.credentials` at
boot. Exporting `FEISHU_APP_SECRET=xxx` in the launch environment also
works (headless). When unresolved, the plugin stays silently inactive (one
log line naming the missing ref).

## Feishu developer-console checklist

1. Custom app → add capability → **Bot**; **create a version and publish**
   (capabilities take effect only after release).
2. Permissions (effective after release): `im:message`, `im:message.p2p_msg`,
   `im:chat:readonly`, `im:resource`.
3. Events & callbacks → event configuration: subscription mode **persistent
   connection (长连接)**, add event `im.message.receive_v1`.
4. Events & callbacks → callback configuration: choose **long connection**
   and configure `card.action.trigger`.
   (`card.action.trigger` belongs in the callback configuration, not event
   subscriptions; a 200340 error on button presses usually means this is
   misconfigured.)
5. Availability scope: add users to the app's availability range so they
   can chat with the bot.

## Chat commands

| Command | Effect |
|---|---|
| `/ws` | Workspace list (default behavior, same as `/ws list`; unknown subcommands also fall back to the list) |
| `/ws use <name>` | Switch the bound workspace (pointer switch only, not restricted while running) |
| `/ws new <path> [title]` | Register a workspace and bind it (session must be idle) |
| `/session` | Session list (default behavior, same as `/session list`; newest first, 10/page, resume by button) |
| `/session new` | New session in the current workspace (session must be idle) |
| `/session resume [index\|sessionId prefix]` | Resume a session (idle required; pointer switch + echo of the last turn's output) |
| `/stop` | Interrupt the active turn |
| `/model` | Single-card model catalog picker (**selectable while running**, effective next turn) |
| `/status` | Status card (model line reads the modelSelection projection; a pending switch is marked) |
| `/doctor` | Gateway self-check (boot stage / recent events / binding / write lease / default model) |
| `/help` | Help |

Plain text messages go to the active session (host `prompt()` with an
idempotent requestId); messages during a running turn are inserted as
steering. Each turn's end sends the final reply (markdown → Feishu rich
text, chunked when long) and a changes card (per-file unified diffs on
demand). Questions and approval requests are answered via card buttons;
late answers go through the continued-answer channel automatically.

## Development conventions (plugin-specific)

These rules come from pitfalls hit during this plugin's development.
Repository-generic rules live in the root `AGENTS.md`; only Feishu-side and
plugin-specific facts are recorded here.

### Architecture: gateway-as-browser

Session driving always goes through the host's `sessionController` Remote
surface (`prompt/create/cancel/selectModel/modelCatalog/projections/list`) —
the same entry the Web GUI uses. **Never** call `agents.create/resume`
directly, hand-mount preset setups, or hand-assemble agentOptions: that
re-invents semantics the host already guarantees (preset-faithful resume,
model resolution, idempotent request ids, the cross-process
`session/writer-held` error code) and historically caused three failure
classes: {{model}}-variable crashes, hollow agents (36 tool-removal events),
and lock conflicts. Note that Remote signatures may take a mandatory second
`signal` argument (`prompt(request, signal)` bare-calls
`signal.throwIfAborted()` on its first line) — in-process callers must pass
one.

### Feishu protocol facts

- **Events are flattened by the SDK**: `EventDispatcher.parse()` lifts
  schema-2.0 `message/sender/action/context/operator` to the top level,
  not under `data.event`. Parsing accepts both shapes (`lib/transport.js`).
- **Fields follow the SDK types**: `ApprovalRequestEvent` has only `reason`
  + `displayReason: {en, zh, …}` — there is no `prompt`; card text prefers
  `displayReason.zh`.
- **Log inbound before parsing**: every arriving event (including filtered
  ones) is written to `~/.dsh/feishu-gateway-events.json`
  (type/chatType/outcome). Start debugging "no reaction" there and at
  `~/.dsh/feishu-gateway-status.json`.
- **Outbound rate limits**: Feishu caps one bot at 5 QPS per chat;
  `lib/lark-client.js` serializes per chat with a 250ms gap. Send failures
  only log — they never propagate into host call stacks.

### Integration testing (the FGTEST loop)

1. Change → `node --test tests/*.spec.js` all green (fakes must replicate
   real-signature strictness).
2. Start a dsh host under a dedicated profile (managed background job,
   stop by exact pid — never `pkill -f`).
3. Drive with real Feishu messages; watch the host log plus the
   status/event files; confirm the host stayed healthy (`dsh: fatal load
   failure` = the plugin killed the host — top-severity incident).
4. `node scripts/doctor.mjs --profile <dir>` for credential and
   long-connection self-checks.
