# Agent roster — reusable role templates for team members

## Requirement (the why & what)

### Problem statement

DSH's agent teamwork requires the user to specify subagents explicitly, in conversation, every time. Switching to a new session means re-explaining the same role's configuration and constraints to the agent from scratch. Users who repeatedly collaborate with the same roles (reviewer, tester, docs writer…) have no way to configure a role once and reuse it across sessions — unlike, e.g., CherryStudio assistants.

### Goal

A new plugin, **agent-roster** (package `dsh-agent-roster`), that provides a profile-wide **roster** of **role templates** and a fast in-session flow to spawn team members from them:

- configure role templates once (settings card, in-modal custom roles, or model-assisted drafting) — use them in every session;
- from the session composer's "+" menu, add an agent member through a picker dialog (pick a template, or define a custom role on the spot);
- choose the member's model per spawn, defaulting to the current session's configuration, following DSH's own model-selection rules;
- if agent teamwork is not enabled for the session, the dialog offers a one-click enable (explicit confirmation, never silent);
- the plugin UI is fully bilingual (Chinese and English); all docs and code comments are English.

### User stories

1. As a session user, I want to pick a pre-configured role from the "+" menu and get a working team member, so that I don't re-explain the role in every session.
2. As a session user, I want to define a one-off custom role in the same dialog, so that ad-hoc collaboration needs no prior setup.
3. As a session user, I want to save a custom role (edited or AI-drafted) as a roster template, so that next session it is one click away.
4. As a session user, I want the member to use the current session's model by default and to optionally choose another model for it, so that model policy follows DSH's design.
5. As a session user who has not enabled agent teamwork, I want the dialog to offer enabling it with one click (with a clear explanation), so that the shared task board is available without hunting for the toggle.
6. As a roster owner, I want to manage templates (list, edit, delete) on the plugin's settings card, so that the roster stays curated without touching YAML.
7. As a roster owner, I want AI assistance to turn a one-line brief into a full template draft that I review before saving, so that I never hand-write long standing prompts.
8. As a session user, I want to ask the root agent in conversation to draft and save a role template (e.g. distill the role it has just been using), so that templates capture real working context.
9. As a Chinese- or English-language user, I want every plugin surface in my language, so that the feature is usable without translation.

### Out of scope

- Model-facing template selection (surfacing templates as `agent_preset` choices to the `subagent` tool) — deferred; revisit as v2 (see ADR-0008).
- Member lifecycle UI (rename, interrupt, delete): the host's Subagents panel and agent tools already cover it.
- Team task-board UI of any kind (owned by the host's agent-team package).
- Template import/export and cross-profile synchronization.
- Drafting with tools or workspace file access beyond what the draft session's ordinary agent already has.

## Design (the how)

### Solution

The plugin has a host half and a client half. The host half owns the roster (a storage-domain table), exposes one Remote service for every operation, spawns members through the subagent runtime, and runs model-assisted drafting in a dedicated draft session. The client half adds one "+"-menu command that opens a picker modal (templates, custom role with AI draft, model choice, optional kickoff task, teamwork enable row), and one settings card for roster management. Members spawned this way are ordinary subagents: they show up in the existing Subagents panel and `list_agents` with no plugin-side rendering.

The flow for a user: click "+" → "Add agent member" → modal opens. If team mode is off for this session, the modal shows an explanation row with an Enable button (one click calls the host's existing agent-team remote; spawning itself remains possible without team mode — team mode adds the shared task board, and the dialog says so). The user picks a template or switches to "custom", optionally renames the member, optionally picks a model (default: current session's), optionally types a kickoff task, and confirms. The member appears under the current tree's root as a subagent and greets per its standing prompt.

### Implementation decisions

**Architecture** (grounded in ADR-0008/0009/0010):

- **Member spawn** resolves the current session tree's root agent and calls the subagent runtime's activation entry (`startActivation`) — the identical path the `subagent` tool uses. `label` = template display name; `name` = slugified, user-adjustable, validated by the same rules as the tool's name parameter (including the reserved `lead`), with plugin-owned suffixing for repeats; `prompt` = the standing prompt, with the optional kickoff task appended as a marked section; model overrides passed only when explicitly chosen, otherwise omitted so the child inherits the parent's current route.
- **Roster storage** is a plugin-owned storage-domain table of zod-validated records: `{ id, name, description, prompt, defaultModel?, createdAt, updatedAt }`. The storage service is optional; absence degrades to an in-memory store with a loud status record. The Config schema holds only behavior toggles (initially: whether model-facing roster tools are exposed, default on).
- **One operation, two callers**: every roster operation is a host service method consumed by both the client UI and the model-facing tools (`roster_template_save` upsert, `roster_template_list`), gated by the config toggle. No separate logic paths.
- **AI drafting** lazily creates one ordinary draft session per workspace (created via the session controller, pinned with a fixed recognizable title), delivers a structured meta-prompt through the sanctioned follow-up + flush path, awaits turn end on the global session event stream, and extracts the last assistant message text. The meta-prompt asks for name / description / standing prompt in the brief's language. A service-side timeout bounds the wait; the client shows a drafting state and can abort. Drafts are proposals only — nothing is saved without explicit user review.
- **Remote surface**: the host half is a typed remote service exposing at least: template CRUD, spawn, team-status probe, and draft. The client mounts the namespace itself (per-remote optional lookup), so absence never throws.

**Client integration**:

- The "+" item registers through the command UI contribution API (label, icon, availability). It appears among the menu's command entries; joining the curated "Add" section is not offered by the host and is accepted as a disclosed limitation.
- The picker modal uses the shared Modal primitive from the browser module table, styled with theme tokens and the repo's copied-control conventions (no new primitives invented). It contains: the template list (or custom-role form with the AI-draft brief field and its own model picker, prefilled with the current session's model), the member-name field, the model selector, and the optional kickoff-task field.
- The model selector lists the current session's selectable models from the session controller's model catalog; a template's optional `defaultModel` pre-fills it. Reasoning effort is offered only alongside an explicit model choice, mirroring the tool's parameter coupling.
- Teamwork gating has three handled states: team mode off (offer one-click enable via the host's agent-team remote — root sessions only; in non-root views the row degrades to explanation-only text pointing at the root session's model-menu toggle, since enabling is a root-only operation; the modal explains that spawning works regardless); the agent-team plugin rows disabled (detected via the plugin inventory remote; the modal offers to enable the row through the plugin-manager remote, or to open the Plugins page); no team-mode surface at all (the agent-team remote is absent — the row shows Plugins-page guidance only, as row-enable is impossible without the bundle loaded).
- Repeat spawns of the same template get numeric suffixes on the slug (`reviewer`, `reviewer-2`, `reviewer-3`), allocated by probing the root's existing child names.
- The settings card registers in the bundle-config slot keyed by package name: a list editor with add/edit/delete, the AI-draft entry, and per-template default-model editing.
- Localization: one client locale namespace with complete `zh` and `en` dictionaries (parity asserted by a test), metadata locales for the plugin catalog, bilingual detail document.

**Failure and containment posture** (repo rules): every entry point wrapped in containment helpers; config values read through wrapper-unwrap helpers in every code path; boot-stage status records written per profile instance; spawn, draft, and CRUD failures surface as explicit bilingual reasons, never silent drops.

### Testing decisions

- **Unit (node --test, strict fakes)** — the fakes mirror real strictness per repo rules: inject-list proxy scopes that throw on non-injected access; config fields as reactive wrappers; a storage-domain fake that validates with the same zod records and rejects what the real one rejects; a subagent-runtime fake with the real activation signature that records calls (parent, label, name, prompt, agentOptions) for assertion; a session-event fake reproducing the global dispatch; a module-loader stub whose `require` throws on unexpected specifiers and mirrors the real primitives export set. Locale tests assert zh/en key parity and parameter interpolation.
- **Client tests** render the modal and card against the fake React-hook harness used by existing packages, asserting: menu contribution shape, gating states (team off / rows disabled / healthy), spawn payload assembly (template render + task append + model omission default), draft review flow (nothing saved without confirmation).
- **Live-host verification** (mandatory per AGENTS.md): background host on a dedicated test profile, stage-record progression, served client boot graph containing the bundle, then exercising: spawn from the modal (member visible in the Subagents panel), default model inheritance, one-click team enable, template CRUD round-trip, and one AI draft round-trip with the draft session reused.
- **Prior art**: the engram and airboard suites (host/client spec shapes, strict fakes, status-file redirection via env), the engram live-verify runbook, the chrome-cdp client-mount pattern.

## Further notes

- Domain terms (role template, roster, member spawn, draft session) are defined in `CONTEXT.md`; decisions are recorded in ADR-0008 (spawn through the subagent runtime), ADR-0009 (storage-domain persistence), ADR-0010 (draft-session model assistance).
- The `subagent` runtime appends its own result-delivery guidance to the child's first message; the plugin must not duplicate that text.
- The plugin targets the current DSH release and declares its engine constraint per the repo's packaging conventions; no runtime npm dependencies.
