# Agent roster — reusable role templates for team members

## Change 2026-11-25 (b) — command-driven creation and standby members

- REMOVED: the injected member instruction. The composer path is the user speaking by definition, so it rendered as a user bubble and cost a lead turn.
- ADDED: the dialog stages its request (`agentRoster.stageSpawn`, one-shot per session, expiring) and runs `/roster <template name>` — the `/compact` path: two log-only lifecycle events in the transcript, no model message, no lead turn.
- ADDED: standby semantics. A member's opening frames the role as identity and, without a task, orders it to stand by; delivery is `caller` without a task (no settle notice, the lead is never woken) and `parent` with one.
- KEPT: `roster_spawn` for the lead's own use in conversation, under the same opening and delivery rules. Decision record: ADR-0012.

## Change 2026-11-25 — per-spawn model override

- ADDED: the "+" dialog carries a **member model** picker (model and reasoning effort) that starts from the template's default and may override it for this one spawn — including "inherit the session model", which clears a template default. The template itself is never edited by it.
- MODIFIED: `roster_spawn` gains an optional nullable `model` argument. (The dialog stated the choice in the injected instruction at the time; change (b) above stages it with the request instead, so from the dialog it never passes through a model.) Precedence: an explicit object or `null` beats the template default, which beats inheriting the session route; an omitted argument keeps the pre-change behavior.

## Change 2026-11-23 — agent-driven member creation (form 2)

- REMOVED: AI-assisted drafting in every form — the draft session, the `draft` remote, the Settings toggle/draft-model block, the four draft Config fields, ADR-0010's mechanism. A template IS the instruction the user would otherwise type; nothing must write it for them.
- MODIFIED: creating a member is now **agent-driven**. "+" → pick a template (+ optional task) → the plugin injects that instruction into the current session as a user message (the composer-equivalent path) → the lead agent runs its normal loop and calls the plugin's `roster_spawn` tool → the host performs the deterministic subagent-runtime spawn with the template's model.
- REMOVED: the client-side spawn (`spawnMember` remote), the team-mode gating states, the member-name field and the per-spawn model selector — names follow the template, models come from the template.
- REMOVED: the in-dialog ad-hoc custom role (templates replace the repeated natural-language description; a one-off still goes through conversation or a saved template).
- ADDED: `roster_spawn` agent tool — the single creation path, always registered; `roster_template_save/list` stay behind the `exposeAgentTools` toggle.

## Change 2026-11-23 — settings-owned AI draft + Settings page manager

- MODIFIED: the roster manager moved from a Plugins-page config card to a **Settings page section** (`settings.section`, id `agent-roster`): part one is the AI-draft configuration (enable toggle + draft model — enabling requires picking a model), part two the template manager. The Plugins row links the section (no card of our own).
- MODIFIED: AI-draft model selection is **Settings-owned** (volatile Config fields `draftEnabled` default false, `draftModelProvider/Id/ReasoningEffort`), replacing the in-modal per-draft picker and its live-session prefill. The modal states which model will be used and points at Settings while off or unconfigured; the host resolves `input.model > configured > refuse` (`roster/draft-disabled`, `roster/draft-model-unset`).
- MODIFIED: the Settings add-form carries no drafting surface (drafting needs a session context); a hint points at the in-session "+" flow.
- SUPERSEDED by the change above (form 2) — that block and its mechanism are gone.

## Requirement (the why & what)

### Problem statement

DSH's agent teamwork requires users to specify subagents explicitly, in conversation, every time. Switching to a new session means re-describing the same role's responsibility boundary and main goal to the lead agent from scratch, and re-stating which model that member should run on. Users who repeatedly collaborate with the same roles (reviewer, tester, docs writer…) have no way to configure that description once and reuse it across sessions.

### Goal

A new plugin, **agent-roster** (package `dsh-agent-roster`), that turns a profile-wide **roster of role templates** into one-click member creation:

- a **role template is exactly what the user would otherwise say to the lead agent**: a name, a one-line description, the standing instruction (responsibility boundary and main goal), and an optional model preference;
- from the composer's "+" menu, picking a template (plus an optional one-off task) **creates the member through the `/roster` command** — recorded in the transcript like `/compact`, with no message from the user and no turn of the lead — and the member **stands by** until it is given work;
- the template's model preference is applied **reliably** at creation (it cannot be left to prompt interpretation — see the design note);
- from the session, the member's model and reasoning effort can be **overridden for that one spawn** — including back to "inherit the session model" — without editing the template;
- templates are managed once in Settings and are reusable in every session;
- the plugin UI is fully bilingual (Chinese and English); all docs and code comments are English.

### User stories

1. As a session user, I want to pick a role template from the "+" menu and get a member that stands by, so that I never re-describe the role's boundary, goal, and model again — and without a long message appearing in my conversation or a turn of the lead spent on it.
2. As a session user, I want to attach a one-off task to the pick ("review the payments module"), so that the same role can be pointed at this session's work.
3. As a session user, I want the transcript to record the creation as a compact command entry, like `/compact`, so that I can see later when a member joined.
4. As a session user, I want a freshly added member to wait for work instead of inventing some, so that adding a member never costs me an unsolicited report or a turn of the lead.
5. As a roster owner, I want each template to carry a model preference that is actually used, so that cheap work runs on a cheap model without prompt-stuffing.
6. As a session user, I want to give one member a different model or reasoning effort than its template default, just for this spawn, so that the template stays a sane default and this one member gets what the task needs.
7. As a roster owner, I want to create, edit, and delete templates on the plugin's Settings page, so that the roster stays curated without touching YAML.
8. As a session user, I want to ask the lead agent in conversation to save the role we just used as a template, so that templates capture real working context.
9. As a Chinese- or English-language user, I want every plugin surface in my language.

### Out of scope

- AI-assisted template drafting of any kind (removed — the user writes the instruction, or distills it in conversation).
- An in-dialog ad-hoc role: a one-off that is not worth a template goes through ordinary conversation instead.
- Model-facing `agent_preset` selection (surfacing templates as presets to the `subagent` tool) — still deferred.
- Member lifecycle UI (rename, interrupt, delete): the host's Subagents panel and agent tools cover it.
- Team task-board UI (owned by the host's agent-team package); template import/export; cross-profile sync.

## Design (the how)

### Solution

The plugin has a small host half and a client half. The host half owns the roster (a storage-domain table), exposes template CRUD and `stageSpawn` as a Remote for the Settings page and the dialog, registers the `/roster` command and the `roster_spawn` agent tool over one spawn, and keeps the authoring tools `roster_template_save/list`. The client half adds one "+"-menu command whose modal lists templates, takes an optional per-spawn model and first task, and on confirm stages the request and runs `/roster` on the session. Members appear in the standard Subagents panel.

The user flow: click "+" → "Add agent member" → pick a template → optionally pick the member model and reasoning effort (it starts from the template's default) → optionally type the task → confirm. The transcript gains a compact command entry naming the member; the member starts under the current tree's root with the template's standing prompt as its role and **stands by** — or starts on the first task when one was given.

### Implementation decisions

**Why a plugin tool instead of letting the agent call `subagent` directly.** Two facts force it: (1) DSH limits explicit child-model selection on the `subagent` tool to the parent's current route unless the Host sets an allowlist policy (`packages/subagent/tool-subagent/src/model-selection.ts:167-190`, `MODEL_ROUTE_NOT_ALLOWED`), so "this member runs on model X" cannot be reliably honored through the model's own tool call; (2) the template's standing prompt must stay frozen — letting the lead rewrite it on every spawn reintroduces the drift templates exist to prevent. `roster_spawn` therefore does the deterministic host-side spawn (`subagents.startActivation` with `agentOptions`), while the agent loop still contributes what it is good at when the lead itself creates a member from the conversation. The dialog does not need that contribution: the user supplies the task, so it creates the member through `/roster` without a model call at all (ADR-0012).

**Creation through a command (client).** Confirming stages the request — template, per-spawn model, first task — through `agentRoster.stageSpawn` (a one-shot request bound to the session that expires; the template is resolved at staging, so an unknown one fails in the dialog), then admits one command line on the session: `ctx.sessions.using(sessionId, { source: 'agent-roster' }, ref => ref.binding.session.command('/roster <template name>'))` (`packages/api/session-controller/src/client/sessions/session.ts` `command()`: "the full command line, leading slash included… the host executor durably logs the lifecycle; outcomes render as flow nodes, never as a response echo"). A command is the host's act-without-a-model-message path: `execute()` appends `command/run` before the handler and `command/done` at settlement, both log-only (`packages/interaction/commands`; `/compact` is the first-party reference). The dialog therefore sees only the admission `{ matched }`; `matched: false` means the host has no `/roster` and is reported. A refused staging or admission renders a bilingual error and runs nothing.

**`/roster` (host command) and the member opening.** `/roster` is a global command. With a staged request of the invoking session it uses that request (the staged request wins over the typed argument); typed as `/roster <template name or id>` it adds that template's member with the template's default model and no task; with neither it answers its usage. It resolves the template, calls the same `spawnFromTemplate` as `roster_spawn`, and reports `Member "<name>" (<template>) created and standing by. Model: …` or `… created and given its first task. …`; every failure becomes model-safe text. The member's opening message — its first user message, never its system prompt — frames the template's standing prompt as identity ("who you are for your whole residency — not a task to perform now"). Without a task it orders the member to stand by: nothing inherited from the creating session (timeline trees, plans, titles, repository state) is an assignment; do not explore or produce work; do not send a message; reply with one short line and end the turn. With a task it states the first task. Delivery follows the same split: `parent` with a task (the member owes the lead its result), `caller` without one (`notifySettlement` returns before the settle notice, so a standby member never wakes the lead, and it still enters the parent catalog). The 2026-11-25 incident — a bare role prompt read as a task, the inherited tree title taken as its topic, the settle notice waking the lead — is what these rules exist to prevent.

**`roster_spawn` (host tool).** Parameters `{ template: string, task?: string, model?: ModelRef | null }` — `template` accepts the record id or its exact name; `model` is the per-spawn override in the tool-facing spelling (`{ provider, model, reasoning_effort? }` or `null`). It resolves the template, then calls `subagents.startActivation` with `label` = template name, `name` = slugified template name (then `-2`, `-3`… among the root's existing children; `lead` yields `lead-member`), `prompt` = the member opening described above, and `agentOptions` from the per-spawn `model` when the call carries one, else from the template's `defaultModel` (omitted → the child inherits the parent's route). Returns `{ name }`. Typed errors: `roster/bad-request`, `roster/not-found`, `roster/ambiguous-name`, `roster/no-subagents` (defense in depth — the tool only registers when the runtime is injected, see below).

**Per-spawn model override.** The dialog's picker starts from the template's default (a default the session catalog does not list stays selectable through a lossless synthetic row, so a degraded catalog never blocks the choice); switching templates resets it to the new template's default (a pick is remembered per template while the dialog stays open, so switching back restores it); changing only the effort keeps the model in effect; choosing another model starts that model on its own default effort, and re-picking the template's model restores its stored effort. From the dialog the choice is staged with the request and never passes through a model. Through `roster_spawn` it travels in the agent's tool call: an agent that drops `model` gets the template default, and the tool's result reports the model actually applied so the mismatch is visible.

**Registration and availability.** The tools callback injects `['tools', 'subagents']` — `roster_spawn` resolves the caller's tree root and the subagent runtime through that second service, and cordis throws when a callback touches a service it did not inject. The mount therefore records `tools-pending` after `done` and lets the callback overwrite it with `tools-registered` / `tools-failed`; a host that never provides those services (a deployment without the subagent runtime) stops at `tools-pending` rather than claiming a terminal success. In that deployment the plugin can do nothing useful anyway: member creation is its core capability. `/roster` registers on its own callback (`commands`, `subagents`) so a host without the commands service keeps `roster_spawn`; whichever callback lands last writes one terminal record naming both mounts (`tools-registered { authoring, command }`, or `command-registered` when only the command has mounted; failures write `tools-failed` / `command-failed`).

**Roster storage** stays a plugin-owned storage-domain table of zod records `{ id, name, description, prompt, defaultModel?, createdAt, updatedAt }`, with an in-memory fallback plus a loud status record when the service is absent. Config holds only `exposeAgentTools` (the authoring tools); `roster_spawn` is always registered because the "+" flow depends on it.

**Remote surface**: template CRUD only (`listTemplates`, `saveTemplate`, `deleteTemplate`). No spawn, no team-status probe, no draft.

**Settings section** (`settings.section`, id `agent-roster`): the roster manager — list, add, edit, delete, per-template default model. No AI-draft block.

**Shared UI**: the model chooser is the host model-picker dropdown pattern (CSS anchor positioning + portaled `MenuSurface` + provider-grouped rows, copied and renamed per the practices rule); the same `ModelRefEditor` (model plus reasoning effort) serves the Settings template editor and the dialog's per-spawn override.

### Testing decisions

- **Unit (node --test)** — strict fakes as before (inject-only proxy scopes, wrapper-typed config, zod-validating storage fake, a subagent-runtime fake with the real activation signature, a session-store fake with the real `prompt()` contract). New coverage: the injected message text is exactly the pinned shape; `roster_spawn` resolves by id and by exact name, rejects unknown/ambiguous templates, applies the per-spawn model precedence (explicit object or `null` > template default > inherit; an invalid explicit model — wrong shape, empty provider or model, or an empty effort — rejects with `roster/bad-request`), writes the member opening (identity framing, a stand-by order or the first task), applies the delivery rule (`caller` without a task, `parent` with one), and allocates names; `/roster` consumes the staged request of its session or a typed template, answers its usage otherwise, and reports every failure as text; `stageSpawn` validates, resolves the template immediately, and stages one request per session. `saveTemplate` refuses a default model with an empty provider or model through a write-time schema stricter than the read schema, so one stored record written before the rule still loads and cannot take the listing down.
- **Client tests** render against real React (`react-test-renderer`): command contribution, template list, task field, the staged request and the `/roster <name>` command line (never a `prompt()` call), failure lines (refused staging, unmatched or refused admission), and the per-spawn model picker (prefill from the template default, override, inherit, effort coupling, reset on template switch, an effort-only change keeping the template model, an override remembered per template). A wrong-typed `model` argument is rejected by the real `@deepseek-ai/dsh-tools` execute wrapper with `INVALID_ARGS` before the plugin runs (`tests/tools.spec.js` pins it). The removed surfaces (draft, team gating, name field) must leave no dead references.
- **Live-host verification**: background host, stage records, served boot graph, then: template CRUD round-trip; "+" → template → confirm leaves `command/run` + `command/done` for `/roster` in the session log and **no** `user/message` from the dialog, with the command node naming the member; a member added without a task settles **without** a settle notice reaching the lead; a member given a first task reports its result back; a typed `/roster <template>` adds a standby member with that template's defaults; the per-spawn model override reaches the child session's `modelSelection`.

## Further notes

- Decisions: ADR-0008 (spawn through the subagent runtime — the mechanism is unchanged; the caller is now the tool), ADR-0009 (storage-domain persistence), ADR-0011 (member creation through a plugin tool), ADR-0012 (the dialog creates members through `/roster`; members stand by), ADR-0010 (draft session — superseded).
- The `subagent` runtime appends its own result-delivery guidance to the child's first message; the plugin does not duplicate it.
- The plugin declares its engine constraint per repo packaging conventions and carries no runtime npm dependencies.