# Agent roster — reusable role templates for team members

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
- from the composer's "+" menu, picking a template (plus an optional one-off task) **injects that instruction into the current session**, so the lead agent runs its normal agent loop and creates the member through the plugin's `roster_spawn` tool;
- the template's model preference is applied **reliably** at creation (it cannot be left to prompt interpretation — see the design note);
- templates are managed once in Settings and are reusable in every session;
- the plugin UI is fully bilingual (Chinese and English); all docs and code comments are English.

### User stories

1. As a session user, I want to pick a role template from the "+" menu and have the lead agent create that member, so that I never re-describe the role's boundary, goal, and model again.
2. As a session user, I want to attach a one-off task to the pick ("review the payments module"), so that the same role can be pointed at this session's work.
3. As a session user, I want to see the exact instruction that will be injected before it is sent, so that the template never surprises me.
4. As a roster owner, I want each template to carry a model preference that is actually used, so that cheap work runs on a cheap model without prompt-stuffing.
5. As a roster owner, I want to create, edit, and delete templates on the plugin's Settings page, so that the roster stays curated without touching YAML.
6. As a session user, I want to ask the lead agent in conversation to save the role we just used as a template, so that templates capture real working context.
7. As a Chinese- or English-language user, I want every plugin surface in my language.

### Out of scope

- AI-assisted template drafting of any kind (removed — the user writes the instruction, or distills it in conversation).
- An in-dialog ad-hoc role: a one-off that is not worth a template goes through ordinary conversation instead.
- Model-facing `agent_preset` selection (surfacing templates as presets to the `subagent` tool) — still deferred.
- Member lifecycle UI (rename, interrupt, delete): the host's Subagents panel and agent tools cover it.
- Team task-board UI (owned by the host's agent-team package); template import/export; cross-profile sync.

## Design (the how)

### Solution

The plugin has a small host half and a client half. The host half owns the roster (a storage-domain table), exposes template CRUD as a Remote for the Settings page, registers `roster_spawn` as an agent tool (the single creation path), and keeps the authoring tools `roster_template_save/list`. The client half adds one "+"-menu command whose modal lists templates, previews the exact instruction, takes an optional task, and injects that instruction into the current session as a user message. The lead agent then calls `roster_spawn`; members appear in the standard Subagents panel.

The user flow: click "+" → "Add agent member" → pick a template → optionally type the task → confirm. The conversation shows the injected instruction, the lead agent calls `roster_spawn`, the member starts under the current tree's root with the template's standing prompt and model.

### Implementation decisions

**Why a plugin tool instead of letting the agent call `subagent` directly.** Two facts force it: (1) DSH limits explicit child-model selection on the `subagent` tool to the parent's current route unless the Host sets an allowlist policy (`packages/subagent/tool-subagent/src/model-selection.ts:167-190`, `MODEL_ROUTE_NOT_ALLOWED`), so "this member runs on model X" cannot be reliably honored through the model's own tool call; (2) the template's standing prompt must stay frozen — letting the lead rewrite it on every spawn reintroduces the drift templates exist to prevent. `roster_spawn` therefore does the deterministic host-side spawn (`subagents.startActivation` with `agentOptions`), while the agent loop still contributes what it is good at: reading the conversation and filling in the one-off task.

**Instruction injection (client).** The message is composed from the template record and sent through the sanctioned composer-equivalent path — `ctx.sessions.using(sessionId, { source: 'agent-roster' }, ref => ref.binding.session.prompt([{ type: 'text', text }], 'queue'))` (`packages/api/session-controller/src/client/contract/session.ts:98-104`; in-tree precedent `ui-commands/src/client/service.ts:105-113`). Shared session semantics apply for free: queueing while busy, visible in the log, cancellable. Failure to reach `prompt()` surfaces a bilingual error in the modal, never a silent no-op. The exact message shape:

```
Use the agent-roster template «<name>» to create a team member for me.
Template description: <description | (none)>
Standing instruction the member must run with (do not rewrite it):
---
<prompt>
---
Current task for this member: <task>          ← this line only when a task was given
Call the roster_spawn tool with template: "<id>" (omit task).   ← or: and the current task text above as task.
Do not describe the member in chat instead of creating it, and do not pass the standing instruction yourself.
```

**`roster_spawn` (host tool).** Parameters `{ template: string, task?: string }` — `template` accepts the record id or its exact name. It resolves the template, then calls `subagents.startActivation` with `label` = template name, `name` = slugified template name (then `-2`, `-3`… among the root's existing children; `lead` yields `lead-member`), `prompt` = the standing prompt plus the optional task as a marked section, and `agentOptions` from the template's `defaultModel` (omitted → the child inherits the parent's route). Returns `{ name }`. Typed errors: `roster/bad-request`, `roster/not-found`, `roster/ambiguous-name`, `roster/no-subagents` (defense in depth — the tool only registers when the runtime is injected, see below).

**Registration and availability.** The tools callback injects `['tools', 'subagents']` — `roster_spawn` resolves the caller's tree root and the subagent runtime through that second service, and cordis throws when a callback touches a service it did not inject. The mount therefore records `tools-pending` after `done` and lets the callback overwrite it with `tools-registered` / `tools-failed`; a host that never provides those services (a deployment without the subagent runtime) stops at `tools-pending` rather than claiming a terminal success. In that deployment the plugin can do nothing useful anyway: member creation is its core capability.

**Roster storage** stays a plugin-owned storage-domain table of zod records `{ id, name, description, prompt, defaultModel?, createdAt, updatedAt }`, with an in-memory fallback plus a loud status record when the service is absent. Config holds only `exposeAgentTools` (the authoring tools); `roster_spawn` is always registered because the "+" flow depends on it.

**Remote surface**: template CRUD only (`listTemplates`, `saveTemplate`, `deleteTemplate`). No spawn, no team-status probe, no draft.

**Settings section** (`settings.section`, id `agent-roster`): the roster manager — list, add, edit, delete, per-template default model. No AI-draft block.

**Shared UI**: the model chooser is the host model-picker dropdown pattern (CSS anchor positioning + portaled `MenuSurface` + provider-grouped rows, copied and renamed per the practices rule); role fields and row rendering are shared between the modal preview and the Settings editor.

### Testing decisions

- **Unit (node --test)** — strict fakes as before (inject-only proxy scopes, wrapper-typed config, zod-validating storage fake, a subagent-runtime fake with the real activation signature, a session-store fake with the real `prompt()` contract). New coverage: the injected message text is exactly the pinned shape; `roster_spawn` resolves by id and by exact name, rejects unknown/ambiguous templates, applies the template model (and omits `agentOptions` otherwise), appends the task section, and allocates names.
- **Client tests** render against real React (`react-test-renderer`): command contribution, template list and instruction preview, task field, exact `prompt()` call, failure line. The removed surfaces (draft, team gating, model selector, name field) must leave no dead references.
- **Live-host verification**: background host, stage records, served boot graph, then: template CRUD round-trip; "+" → template → confirm injects the message into the session (visible in its log); the lead agent's `roster_spawn` tool call creates a member with the template model (verified in the child session's `modelSelection`); a template's edit is reflected in the next injection.

## Further notes

- Decisions: ADR-0008 (spawn through the subagent runtime — the mechanism is unchanged; the caller is now the tool), ADR-0009 (storage-domain persistence), ADR-0011 (member creation is agent-driven through a plugin tool), ADR-0010 (draft session — superseded).
- The `subagent` runtime appends its own result-delivery guidance to the child's first message; the plugin does not duplicate it.
- The plugin declares its engine constraint per repo packaging conventions and carries no runtime npm dependencies.