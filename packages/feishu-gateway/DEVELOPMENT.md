# dsh-feishu-gateway — development notes

Plugin-specific rules distilled from the development cycle. Repository-generic
rules live in the root AGENTS.md. This file stays in the repo and is NOT part
of the shipped package.

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
