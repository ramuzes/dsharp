# Agent-roster members spawn through the subagent runtime, not a parallel mechanism

Status: Accepted (2026-11-22) · Amended (2026-11-23): the caller is now the `roster_spawn` agent tool, not a client Remote (see ADR-0011)

## Context

Users need to add team members from persisted role templates via the Web GUI's "+" menu, deterministically and in any session. Since DSH v0.2.1-rc.2 a teammate is just an ordinary subagent (team mode is a per-session flag plus a shared task board; `packages/team/agent-team`, docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents). The only creation path is `ctx.subagents.startActivation(...)` — host-side, not `@Remote` (`packages/subagent/subagent/src/index.ts:274-299`), which is what the `subagent` tool calls (`packages/subagent/tool-subagent/src/index.ts:320-336`). There is no client-callable create API.

## Decision

The plugin's host half exposes the spawn as an **agent tool** (`roster_spawn`) that resolves the current tree's root agent and calls `ctx.subagents.startActivation` with the rendered template (originally a client Remote; the mechanism below is unchanged — only who calls it, per ADR-0011): `label` = template display name, `name` = slugified unique name (user-adjustable), `prompt` = standing prompt plus an optional kickoff task, and `agentOptions` only when the user explicitly picked a model (omission inherits the parent's current route — `child-agent.ts:98-119`). Role constraints ride as the child's first user message, the same semantics a model-driven spawn would produce.

## Considered Options

- Subagent-runtime spawn via `startActivation` (chosen) — deterministic, invisible to the conversation flow, members are continuable subagents
- Prompt injection (send the template as a user message and let the root agent call `subagent`) — non-deterministic, leaks template text into the session log, delayed until the next turn
- Preset-native (register templates as Agent Presets, surface via `allowedAgentPresets` on the `tool-subagent` row) — that config is a static row list while template CRUD is dynamic; overriding base-bundle rows from a plugin patch is layer-fragile; pollutes the user-managed preset registry; main benefit (model-facing selection) deferred by decision
- Dedicated sessions via `sessionController.create` — members would not be continuable subagents: invisible to `list_agents`, the Subagents panel, and the team task board

## Consequences

- Spawned members appear in the existing Subagents session panel and `list_agents` rows with zero plugin-side rendering.
- Explicit model override stays limited to the parent's current route unless the host allowlist widens it — the same rule the `subagent` tool follows (`model-selection.ts:164-180`); "default = current session's model" falls out of omission.
- The plugin owns suffixing for repeated spawns of the same template (name uniqueness among one creator's children).
