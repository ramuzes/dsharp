# Model-assisted template drafting runs in a dedicated reusable draft session

Status: Accepted (2026-11-22)

## Context

Requiring users to hand-write full standing prompts is unreasonable; drafting needs a sanctioned model surface. The candidates: a direct `ctx.llm` one-shot call would hand-roll request assembly (AGENTS.md 2b stop signal — no high-level interface exists for it); injecting a drafting request into the current session hijacks the user's conversation; a drafter subagent would appear in the Subagents panel and count as a teammate under team mode (wrong semantics, no deletion API). Two in-repo precedents fix the mechanics: schedule creates ordinary sessions and delivers prompts via `agent.followup(createUserMessage(...))` + `ctx.sessions.flush` (`packages/schedule/schedule/src/runtime.ts:353-363`), and feishu-gateway awaits answers via the global `session/event` stream and `session.deriveMessages()` (`packages/feishu-gateway/lib/driver.js:42-60, 326-331`).

## Decision

The plugin lazily creates one ordinary draft session per workspace (`sessionController.create` + `sessionTitle.rename` to a fixed name), delivers a structured meta-prompt (asking for name / description / standing prompt in the brief's language), awaits `turn/end`, and extracts the last assistant text. The parsed draft returns to the modal for mandatory user review; nothing enters the roster until the user saves. The session is reused across drafts so iteration context accumulates, and the user can open it to inspect or correct the drafter at any time.

## Considered Options

- Reusable per-workspace draft session (chosen)
- Per-draft ephemeral session — clean isolation but accumulating list noise and no iteration context
- Drafter subagent under the current root — pollutes team mode and the Subagents panel; continuable clutter with no deletion API
- Direct one-shot LLM call from the plugin — no sanctioned high-level interface; hand-rolled assembly is a stop signal
- Current-session injection — pollutes and delays the user's conversation

## Consequences

- One extra, explicitly titled row in the session list per workspace; fully transparent and inspectable.
- The Remote draft call runs as long as a model turn: the client shows a drafting state with abort, and the service enforces its own timeout with a surfaced failure.
- Drafting can use a cheaper model chosen in the modal (the draft session is an ordinary session with its own model selection).
- Conversation flows and team mode never see drafting traffic.
