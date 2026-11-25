# Member creation is agent-driven through a plugin tool, not a direct client action

Status: Accepted (2026-11-23) · Amended (2026-11-25): the member model may be overridden per spawn through the injected instruction (see the last Consequence)

## Context

A role template is exactly the instruction a user would otherwise type to the lead agent ("create a member whose boundary is X and goal is Y, on model Z"). Two earlier shapes were built in sequence: a direct client action that spawned host-side (deterministic, invisible to the conversation), then a model-assisted drafting session that wrote the instruction for the user. Neither matches the user's mental model: the template is the message, and adding a member should let the agent loop do what it is good at — reading this conversation, filling in the task, and acting.

Two DSH facts constrain the shape. (1) The client must not call the model runtime directly, and injecting a drafting turn into the user's own conversation would pollute it; but the client CAN deliver a user message through the composer-equivalent path (`session.prompt`, `session-controller/src/client/contract/session.ts:98-104`). (2) Explicit child-model selection made through the model's own `subagent` tool is limited to the parent's current route unless the Host configures an allowlist policy (`tool-subagent/src/model-selection.ts:167-190`, `MODEL_ROUTE_NOT_ALLOWED`), so a per-template model cannot be delegated to the model's own tool call; and a model rewriting the standing prompt on every spawn would reintroduce the drift templates exist to prevent.

## Decision

"+" composes the template into a user message and injects it into the current session through `ctx.sessions.using(...).prompt(...)`. The lead agent runs its normal loop — reading the conversation, filling the one-off task — and calls the plugin's `roster_spawn({ template, task? })` tool. That tool performs the deterministic host-side subagent-runtime spawn with the template's standing prompt frozen and its `defaultModel` applied as child `agentOptions`. `roster_spawn` is always registered; the authoring tools `roster_template_save/list` stay behind the Config toggle. The Remote surface shrinks to template CRUD.

Removed with this decision: the `spawnMember` remote (client-side spawn), the team-status probe and its gating states (irrelevant — the lead agent creates members whether or not Team mode is on), the member-name field and per-spawn model selector (names follow the template, models come from the template), the in-dialog ad-hoc role, and all model-assisted drafting (see ADR-0010, superseded).

## Considered Options

- Agent-driven injection + plugin spawn tool (chosen) — agent loop contributes conversation awareness and task filling; model and standing prompt stay deterministic
- Client-side spawn through a Remote (the previous shape) — deterministic, but nothing is visible in the conversation and the template never reads as "what I would have said"
- Plain message injection, letting the agent call `subagent` itself — simplest, but the per-template model is rejected by the allowlist unless the deployment configures it, and the standing prompt can be rewritten per spawn
- Registering templates as Agent Presets and surfacing them through `agent_preset` — strongest prompt authority, but template CRUD is dynamic while the preset row list is static, and the preset registry belongs to the user

## Consequences

- Creation has two hops: the injected user message (a real conversation turn, costs the session's model) and the agent's tool call. Accepted: that turn is where session context enters the member's task.
- The injected instruction is visible in the session log — auditable by design, and the modal previews it before sending.
- `roster_spawn` availability is a deployment fact: a profile that restricts tools or mounts no subagent runtime surfaces its typed error instead of creating a member.
- Template editing affects only the next injection; already-created members keep the prompt they were spawned with.
- (2026-11-25) The member model is the one thing the user may override per spawn: the dialog's picker starts from the template default and the choice is written into the instruction as the exact `model` argument of `roster_spawn` (object, or `null` to inherit). It therefore reaches the host through the agent's tool call like `template` and `task`. The tool's precedence is explicit > template default > inherit, an omitted argument keeps the template default, and an invalid explicit model is refused rather than degraded. A host-side staged intent was considered and deferred until dropped arguments are observed.