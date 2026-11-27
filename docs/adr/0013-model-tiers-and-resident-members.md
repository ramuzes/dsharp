# Members choose between two model tiers on a stated basis, and a role's member is reused

Status: Accepted (2026-11-27) · Revises the `roster_spawn` half of ADR-0011 and the per-spawn override of 2026-11-25

## Context

One implementation session (2026-11-26) ran six tasks through the roster with a developer template whose default model was a small, cheap one. The session logs show three deviations from how the user wanted the roster used:

1. **The lead chose the model.** `roster_spawn` exposed the per-spawn `model` argument to the agent (0.2.1). After the first two tasks, the lead listed the available models and passed a large model at high reasoning effort on five of its eight spawns, and never returned to the template's model — including for a routine task. The one defect found by an audit in that session had been fixed by the base model itself a minute later.
2. **A new member per task.** Six task dispatches produced six developer members (plus one code reviewer). Nothing in the tool said a member could be reused, so the lead followed the host's `subagent` idiom of a fresh context per task.
3. **Waiting online.** The lead held one turn for 5 h 20 min with 28 `wait_agent` calls, 11 of them at the 10-minute cap (about 3.2 h waiting in total). The other 17 returned on 12 settle notices and 7 member messages — the very events the runtime already delivers to an idle lead as its next turn (`packages/subagent/subagent/src/manager.ts:1151`: `queue` when the parent is idle, `steer` when it works). The host's team guidance says the lead "must wait for required teammates before giving the final answer" (`packages/team/tool-agent-team/src/index.ts:31`), which the lead read as a literal wait.

DSH facts that decide the shape (v0.2.3-alpha.2 source):

- `listDescendants` returns each member's session id with `activity: 'running' | 'inactive'` (`packages/subagent/subagent/lib/types/control-types.d.ts`), which is enough to tell an idle resident member from a busy one.
- `sendMessage(root, childId, content, { signal })` delivers a model-authored message to a continuable member from the tree's root (`packages/subagent/subagent/src/manager.ts:568`); an idle member starts a turn on it. No activation is needed to give a standing member its next task.
- A member's model is fixed for its residency, so "the same role on another model" is necessarily another member.

## Decision

- **Tiers, not models.** A template carries a base model (the existing default) and an optional high-tier model. `roster_spawn` takes `tier: 'base' | 'high'` and a `reason` that is required with `high`; the plugin resolves the tier from the template. The agent-side `model` argument is removed. The user's per-spawn choice in the "+" dialog is unchanged: it is staged with the request and never passes through a model.
- **A stated basis.** The tool description carries the same three rules on every call: every new task starts on the base model; a rework moves to the high tier only after one rework on the base model failed to pass; a task brief that names the high tier may start there. The tier follows the task, never the role. The plugin does not judge the basis; it records every high-tier dispatch with its reason and lists the records in Settings.
- **Resident reuse by template policy.** A template's reuse policy is `role` (default) or `task`. Under `role`, `roster_spawn` gives the task to an idle member of the same template and the same resolved model route and creates one otherwise — a busy resident never queues work behind itself. The rule is the same for every model: a high-tier member of a role is a separate member the lead manages alongside the base one. The plugin keeps the member registry in memory.
- **Yield after dispatch.** The tool description tells the lead to end its turn once nothing is left but waiting, because the runtime queues a member's completion as the lead's next turn.

## Considered options

- Keep `model` on the tool and add a template switch that refuses agent overrides: it keeps the lead choosing models when the switch is on, and it does not address reuse or waiting.
- Let the lead escalate on its own prediction of difficulty, with a reason: models over-estimate difficulty, and the session shows a single escalation becoming permanent. Evidence-based rules plus per-task reset were chosen instead.
- Escalate automatically when an audit fails: the plugin cannot see review outcomes; the lead states the basis and the record makes it auditable.
- Change the host's "must wait" wording: the right long-term fix, but it belongs to the dsh repository; the tool description counters the polling without contradicting the obligation.
- Persist the member registry so reuse survives a host restart: deferred. A restart costs one extra member per role, which does not justify a persisted table.

## Consequences

- Cost is predictable: routine work runs on the base model, and every use of the high-tier model has a written reason the user can review against the plan.
- The lead can no longer give one member an arbitrary model or inherit its own model. A user who wants a different model for one member uses the dialog or edits the template.
- A resident member's context grows with each task and relies on the host's compaction; a template whose tasks should stay isolated sets its reuse policy to `task`.
- After a host restart the plugin no longer knows which member came from which template; the first request for a role then creates a new member.
- The host's "wait for required teammates" sentence remains. If the lead still polls, the remaining fix is in dsh's team guidance.
