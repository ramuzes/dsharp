# The "+" dialog creates members through a host command, and members stand by

Status: Accepted (2026-11-25) · Revises the dialog half of ADR-0011

## Context

ADR-0011 made the "+" dialog inject an instruction into the conversation and let the lead agent call `roster_spawn`. Two problems surfaced in real use (one session, 2026-11-25):

1. The instruction is a `user/message` with `source.kind: "user"`, because the composer path (`session.prompt`) is by definition the user speaking. It rendered as a long user bubble and cost a turn of the lead.
2. The member misbehaved on arrival. Its standing prompt reached it as "Agent lead sent a message: …" plus the runtime's result-delivery guidance, so a role definition read as a first task; DSH also injects the creating session's timeline tree title into the child's context, which the member took as its topic. It produced an unsolicited report, and its settlement notice ("Background subagent X finished…") woke the lead for a turn that could only call that report irrelevant.

DSH facts that decide the shape (v0.2.3-alpha.2 source):

- A command is the host's act-without-a-model-message path: `commands.execute()` appends `command/run` before the handler and `command/done` at settlement, both log-only lifecycle events; `/compact` is the first-party reference (`packages/interaction/commands`, `packages/compaction/command-compact`). A plain `ctx.commands.register()` is global.
- `notifySettlement` returns before the settle notice when the activation's delivery is `caller`, and local caller-delivered children still enter the parent catalog (`packages/subagent/subagent/src/manager.ts`, `types.ts`). The notice can be neither customized nor suppressed any other way.
- There is no built-in standby member: `startActivation` requires a `prompt`, and the runtime frames it as a message from the lead.

## Decision

- The dialog stages what the user chose — template, per-spawn model, first task — through `agentRoster.stageSpawn` (a one-shot request bound to the session, expiring), then runs a **bare** `/roster` on the session (bare on purpose: a request lost in between — host remount, expiry — then answers the usage text instead of silently creating a member with the template defaults and none of the user's choices). The transcript shows a compact command node and its outcome; no user bubble is written and no lead turn is spent.
- `/roster` is a global host command. Typed as `/roster <template name or id>` it adds a standby member with the template's defaults; with a staged request of the invoking session it uses that request instead. A typed argument beside a pending request must name the same template; otherwise the command refuses and the request stays pending.
- The command and `roster_spawn` create members through the same `spawnFromTemplate`.
- A member's opening message frames the role as identity ("who you are for your whole residency — not a task to perform now"), then either an explicit stand-by order (no task: inherited context is not an assignment; do nothing but reply one line and end the turn) or the user's first task.
- Delivery: `parent` when the member is given a first task (it owes the lead a result), `caller` otherwise (a standby member settles silently and never wakes the lead).
- `roster_spawn` stays for the lead's own use in conversation, under the same opening and delivery rules. The instruction composer and the injection are removed.

## Considered options

- Keep the injection but render it as a notice-form context message: no user bubble, but still a lead turn per member and still task-shaped on arrival.
- A silent direct action through a Remote with nothing in the transcript: cleanest, but it leaves no record of when a member joined.
- A host-side staged intent with the agent passing a token (deferred when the per-spawn override was designed): superseded — the command path carries structured data without passing through a model at all.

## Consequences

- Creating a member costs no model call. The lead is not told that a member joined: it sees the member through `list_agents`, and the command node is the user's record.
- The dialog sees only the command's admission (`{ matched }`); the outcome text renders in the command node. Staging resolves the template first, so an unknown template fails in the dialog.
- A standby member spends one short turn acknowledging readiness; its reply is discarded (nobody awaits a caller-delivered result). Outside team mode the child's identity section still asks it to report through `send_message`; the opening explicitly forbids that for the acknowledgement turn.
- A member given a first task still wakes the lead with its result, as a delegation should.
