# Agent roster implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `dsh-agent-roster` plugin — a profile-wide roster of role templates with a "+"-menu member spawn flow, AI-assisted template drafting, model-facing save/list tools, and a settings card.

**Architecture:** Host half owns a storageDomain-backed template store and one TypertRemoteService (`agentRoster`) exposing CRUD, spawn (via the subagent runtime's `startActivation`), team-status probe, and draft (via a reusable per-workspace draft session). Client half adds one `commandUi` contribution opening a picker Modal, plus a `plugins.bundle.config` settings card. Members are ordinary subagents — no plugin-side rendering of member lists.

**Tech Stack:** Plain ESM JavaScript host/client halves (repo convention — no build tool), schemastery Config, zod storage records via `@deepseek-ai/dsh-storage-domain`, `TypertRemoteService` from `@deepseek-ai/dsh-tools`, React from the browser module table.

**Spec:** `docs/specs/2026-11-22-agent-roster-design.md` (ADR-0008/0009/0010, glossary in `CONTEXT.md`).

## Global Constraints

- Package `dsh-agent-roster` at `packages/agent-roster/`; plugin row id `agent-roster`; client module id `dsh-agent-roster`.
- All docs, code comments, and locale keys English; runtime UI copy bilingual via complete `zh`/`en` dictionaries (parity asserted by test). No runtime npm dependencies: peers `"*"` (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-storage-domain`), devDeps pinned `0.0.1-rc.1` for tests (airboard precedent).
- `engines.dsh`: `"^0.2.2-rc.5"` (installed checkout version).
- Every config read goes through `readString`/`readBoolean` unwrap helpers in every code path, including boot-only paths.
- Every service a callback touches is in THAT callback's `inject` list; optional host services resolved via `ctx.get(...)` with loud degradation (status record + typed `roster/` RemoteError), never a mount crash.
- DSH interfaces cited by file path in code comments (repo convention, AGENTS.md 2b).
- Containment wrappers on all entry points; no silent drops — every failure path surfaces a bilingual reason.
- Status file per profile instance, env-overridable via `AGENT_ROSTER_STATUS_FILE`.
- Tests: `node --test tests/*.spec.js`; fakes mirror real strictness (inject-only proxy scopes, config wrapper `.get()`, zod-validating storage fake).
- Live-host verification on a dedicated test profile is mandatory before done (AGENTS.md §1).

## Review Focus

1. Reactive config wrappers crash plugins at mount (`x.replace is not a function`) — pinned by `host.spec.js` "apply reads config through wrappers" (Task 1) and tool-gating test (Task 5).
2. Optional service absence (storageDomain, agentTeams, sessionController, client remote namespaces) must degrade loudly, not crash — pinned by "degrades to memory store" (Task 2), "spawn fails typed without sessionController" (Task 3), and client optional-lookup tests (Task 6).
3. Team enable attempted from a non-root session must be impossible by construction — pinned by "teamStatus reports canEnable false for non-root" (Task 3) and the client non-root gating test (Task 7).
4. A draft turn that never ends must surface a timeout and drop its listener — pinned by "draft times out" (Task 4).
5. Client bundle absent from the served boot graph after install (dsh-gitlab 0.1.1 incident) — pinned by the live task's boot-graph check before any browser step (Task 9).

---

### Task 1: Package scaffold, Config, status writer, wire helpers

**Files:**
- Create: `packages/agent-roster/package.json`, `packages/agent-roster/cordis.patch.yml`, `packages/agent-roster/index.js`, `packages/agent-roster/lib/wire.js`, `packages/agent-roster/lib/status.js`, `packages/agent-roster/README.md`
- Test: `packages/agent-roster/tests/host.spec.js`

**Interfaces:**
- Produces: `readString(value): string` and `readBoolean(value): boolean` in `lib/wire.js` (unwrap `value?.get?.()`); `openStatus(scope)` in `lib/status.js` returning `{ write(stage, detail?) }` writing to `process.env.AGENT_ROSTER_STATUS_FILE ?? <per-profile default under the DSH home, mirroring engram's lib/status.js>`; `index.js` exporting `export const Config = Schema.object({ exposeAgentTools: Schema.boolean().default(true).description('Expose roster_template_save and roster_template_list tools to the model') })` (non-volatile: structural) and `export function apply(ctx, config)` writing stages `apply → wire-ready → done`, reading `exposeAgentTools` only through `readBoolean`. `package.json` mirrors airboard's shape: `dsh.bundle.patch`, `dsh.client` (`platform: "web"`, airboard's exact `inject` list), `exports` (`.`, `./client`, `./locale/*.json`, `./icon`), `files`, `engines.dsh`, peers/devDeps per Global Constraints. `cordis.patch.yml`: one insert row `id: agent-roster`, `name: dsh-agent-roster`, `config: {}`.

- [ ] **Step 1: Write failing tests** in `tests/host.spec.js`: (a) "apply reads config through wrappers" — fake config `{ exposeAgentTools: { get: () => true } }`, fake ctx proxy exposing only injected names (throws `cannot get property X without inject` otherwise — engram `tests/host.spec.js:151-188` pattern), `AGENT_ROSTER_STATUS_FILE` pointed at a temp file; apply resolves and the status file ends with a `done` stage record; (b) `readString`/`readBoolean` unwrap `{get:()=>v}` and pass through plain values; (c) `Config` parses `{}` to `exposeAgentTools: true`.
- [ ] **Step 2: Run** `node --test tests/host.spec.js` — expect FAIL (modules missing).
- [ ] **Step 3: Implement** the five files. `apply` registers nothing yet; it opens status, writes stages inside `ctx.effect` cleanup-safe wrappers, and stores nothing.
- [ ] **Step 4: Run** `node --test tests/host.spec.js` — expect PASS.
- [ ] **Step 5: Commit** `git add packages/agent-roster && git commit -m "feat(agent-roster): scaffold package, config, status writer"`.

### Task 2: Roster store and CRUD remote

**Files:**
- Create: `packages/agent-roster/lib/store.js`, `packages/agent-roster/lib/roster-service.js`
- Modify: `packages/agent-roster/index.js` (open store, register service)
- Test: `packages/agent-roster/tests/host.spec.js` (extend)

**Interfaces:**
- Consumes: `openStatus`, `readString` (Task 1).
- Produces: zod record `RoleTemplate = z.object({ id: z.string().min(1), name: z.string().min(1).max(64), description: z.string().max(200).default(''), prompt: z.string().min(1), defaultModel: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }).nullable().default(null), createdAt: z.string(), updatedAt: z.string() })`; `ModelRef = { provider: string; model: string; reasoningEffort?: string }` (shared shape, restated in JSDoc); storage domain `{ name: 'agent_roster', version: 1, tables: { templates: domainTable(RoleTemplate), draftSessions: domainTable(z.object({ cwd: z.string(), sessionId: z.string(), createdAt: z.string() })) } }` (feishu-gateway `index.js:72-107` pattern — zod, NOT schemastery, per its recorded incident); `openRosterStore(scope, status)` → `{ all(): Promise<RoleTemplate[]>, byId(id), byName(name), put(rec), delete(id) }` with memory fallback + status record `storage-degraded` when `ctx.get('storageDomain')` is absent; `class AgentRosterService extends TypertRemoteService` (import and decorator style copied from chrome-cdp `lib/status.js:19-40`) with remote methods `listTemplates(): Promise<RoleTemplate[]>`, `saveTemplate(input: { id?: string, name: string, description?: string, prompt: string, defaultModel?: ModelRef | null }): Promise<RoleTemplate>` (creates with fresh id when `id` absent; rejects duplicate `name` across different ids with `roster/name-taken`; updates `updatedAt`), `deleteTemplate(id): Promise<{ deleted: true }>` (`roster/not-found` otherwise).

- [ ] **Step 1: Write failing tests**: strict-fake storageDomain whose table validates with the real zod records and rejects bad ones (mirror feishu fake); "save assigns id and timestamps", "duplicate name rejected with roster/name-taken", "update keeps id bumps updatedAt", "delete missing throws roster/not-found", "degrades to memory store with storage-degraded status" (fake scope without the service).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** store + service; wire into `apply` (stage `service-registered`). Cite dsh file paths in comments for `storageDomain` and `TypertRemoteService`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(agent-roster): storageDomain template store and CRUD remote"`.

### Task 3: Member spawn and team status

**Files:**
- Create: `packages/agent-roster/lib/spawn.js`
- Modify: `packages/agent-roster/lib/roster-service.js` (+`spawnMember`, `teamStatus`)
- Test: `packages/agent-roster/tests/spawn.spec.js`

**Interfaces:**
- Consumes: store (Task 2), `readString` (Task 1).
- Produces: pure helpers `slugify(name): string` (lowercase, `[a-z0-9-]`, ≤32, must start with a letter; empty/invalid result falls back to `member`), `allocateName(base, taken: string[]): string` (`base`, `base-2`, `base-3`…; `lead` reserved — a base that slugs to `lead` becomes `lead-member`), `assembleSpawnPrompt(standing: string, task?: string): string` — exact contract: `standing` alone, or `` `${standing}\n\n---\n\nInitial task (assigned by the user at spawn time):\n${task}` ``; orchestrator `spawnFromRoster(scope, { store, sessionController, subagents, agentTeams }, input)`; remote `spawnMember(input: { sessionId: string, templateId?: string, custom?: { name: string, description: string, prompt: string }, memberName?: string, model?: ModelRef | null, task?: string }): Promise<{ name: string, childSessionId?: string }>`; remote `teamStatus(input: { sessionId: string }): Promise<{ teamMode: boolean, isRoot: boolean, canEnable: boolean }>` (`canEnable = agentTeams present && isRoot`).
- Spawn semantics (ADR-0008): resolve agent via `sessionController.resolveAgent(sessionId)` (schedule precedent, cite `packages/schedule/schedule/src/index.ts:250-257`); determine tree root via the subagents runtime (`rootOf`/equivalent — verify exact member in `packages/subagent/subagent/src/index.ts:300-343` and cite); call `subagents.startActivation({ parent: rootAgent, label: templateOrCustom name, name: allocatedName, prompt: assembled, ...(model ? { agentOptions: model } : {}), delivery: 'parent' })` — verify the exact `agentOptions` field names against `packages/subagent/subagent/src/child-agent.ts:98-119` before wiring and cite; omit `agentOptions` entirely when no model chosen. `custom` xor `templateId` required (`roster/bad-request`). Missing optional services → typed `roster/no-session-controller` / `roster/no-subagents` errors.
- [ ] **Step 1: Write failing tests** with fakes that record `startActivation` args and mirror its real signature: happy path asserts parent = root agent, label/name/prompt exact, no `agentOptions` key when model omitted; model override passes `{ provider, model, reasoningEffort? }`; name suffixing against taken names `['reviewer','reviewer-2']`; `lead` base becomes `lead-member`; team mode on/off × root/non-root matrix for `teamStatus` (fake `agentTeams.isEnabled`); typed errors when services absent; prompt assembly exact string.
- [ ] **Step 2: Run** `node --test tests/spawn.spec.js` — FAIL.
- [ ] **Step 3: Implement**; extend `apply` wiring (no new stage needed beyond existing).
- [ ] **Step 4: Run** — PASS; also rerun `tests/host.spec.js`.
- [ ] **Step 5: Commit** `git commit -m "feat(agent-roster): member spawn via subagent runtime and team status"`.

### Task 4: Draft session (AI-assisted authoring, host path)

**Files:**
- Create: `packages/agent-roster/lib/drafter.js`
- Modify: `packages/agent-roster/lib/roster-service.js` (+`draft`)
- Test: `packages/agent-roster/tests/drafter.spec.js`

**Interfaces:**
- Consumes: `draftSessions` table (Task 2), store.
- Produces: `buildMetaPrompt(brief: string): string` — exact copy: instructions telling the model to return ONLY a JSON object with string fields `name` (2–4 words), `description` (one line), `prompt` (full standing prompt: duties, working rules, constraints, output expectations, written as instructions to the agent itself), all values in the language of the brief, no markdown fences, no commentary; `parseDraft(text: string): { name: string, description: string, prompt: string, parsed: boolean }` (first `{...}` block JSON.parse; failure → whole text as `prompt`, empty `name`/`description`, `parsed: false`); `lastAssistantText(session): string` (port of feishu `lib/driver.js:42-60` over `session.deriveMessages()`); `runDraft(scope, { sessionController, sessions, sessionTitle, storageDomain-store }, input: { sessionId: string, brief: string, model?: ModelRef | null }, timeoutMs = 180_000): Promise<draft result>`; remote `draft(input): Promise<{ name, description, prompt, parsed: boolean }>`.
- Lifecycle (ADR-0010): resolve cwd from the requesting session; look up `draftSessions` by cwd — create once via `sessionController.create({ sessionId: freshId, cwd })` and pin title via `sessionTitle.rename(session, 'Agent roster drafter')` only when untitled (schedule `nameSession` pattern, cite `runtime.ts` lines); deliver meta-prompt via `agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind } }))` (import from `@deepseek-ai/dsh-llm`, cite schedule `runtime.ts:3, 353-363`; first verify the legal `source.kind` values against `createUserMessage`'s type — if the kind is a closed union, use the closest legal user-message kind and note the choice in a comment) then `await sessions.flush(agent.session)`; await `turn/end` for that session on `scope.on('session/event', (session, event) => …, { global: true })` (feishu `index.js:326-331` pattern — global stream, NOT a scoped waterfall) with a timeout that rejects `roster/draft-timeout` and always removes the listener (effect cleanup).
- [ ] **Step 1: Write failing tests** with a fake event emitter: "creates draft session once and reuses across two drafts" (assert single `create` call, title set once); "extracts and parses draft" (emit `turn/end` after fake `deriveMessages` returns an assistant text containing JSON); "parse failure returns raw text with parsed false"; "times out with roster/draft-timeout and unsubscribes" (advance fake timer / immediate-resolve never path; assert listener removed); "flush failure surfaces roster error".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; wire `draft` into the service.
- [ ] **Step 4: Run** — PASS; rerun all spec files.
- [ ] **Step 5: Commit** `git commit -m "feat(agent-roster): model-assisted drafting via reusable draft session"`.

### Task 5: Model-facing roster tools

**Files:**
- Create: `packages/agent-roster/lib/agent-tools.js`
- Modify: `packages/agent-roster/index.js` (register when enabled)
- Test: `packages/agent-roster/tests/tools.spec.js`

**Interfaces:**
- Consumes: `AgentRosterService.saveTemplate/listTemplates` (Task 2), `readBoolean` (Task 1).
- Produces: `registerRosterTools(scope, service)` registering two agent tools (registration API per engram `lib/agent-tools.js`; cite its file): `roster_template_save({ name, description?, prompt, default_model?: { provider, model, reasoning_effort? } | null })` — upsert by exact `name` match (name match reuses the existing record's id; otherwise create); returns a short bilingual-safe summary (`id`, `name`, `updatedAt`); `roster_template_list({})` → records as `{ id, name, description, defaultModel, updatedAt }` — `prompt` deliberately omitted to keep context light; both call the same service methods (one operation, two callers).
- [ ] **Step 1: Write failing tests**: registration happens only when `readBoolean(config.exposeAgentTools)` is true (wrapper config both ways); "save upserts by name" (second save with same name reuses id); "tool calls service method and returns its value"; "list omits prompt".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; `apply` writes stage `tools-registered` or `tools-skipped` accordingly.
- [ ] **Step 4: Run** — PASS; full suite.
- [ ] **Step 5: Commit** `git commit -m "feat(agent-roster): roster_template_save/list agent tools"`.

### Task 6: Client scaffold, locale, "+" command, modal happy path

**Files:**
- Create: `packages/agent-roster/client.js`
- Test: `packages/agent-roster/tests/client.spec.js`

**Interfaces:**
- Consumes: remote methods of Tasks 2–4; `commandUi` contract (`ctx.commandUi.register({ name, label?(), description?(), icon?, available(session), ui })` — cite `packages/client/ui-commands/src/client/contract.ts:96-109`, service name `'commandUi'` at `service.ts:95`); `Modal` from `@deepseek-ai/dsh-client-ui-primitives`.
- Produces: one `window.__ModuleLoader__.load({ id: 'dsh-agent-roster', factory })` script (airboard `client.js:18-27` shape); `zh`/`en` dictionaries + `ctx.locale.register('agent-roster', { zh, en })` + `t = ctx.locale.bind('agent-roster')`; `mountAgentRosterRemote(ctx)` performing `ctx.remote.$mount` with descriptors for all six service methods (chrome-cdp `client.js:385-399` pattern) and reading them via sanctioned `ctx.get('remote.agentRoster')`; contribution `name: 'add-agent-member'`, `ui: { kind: 'action', run(session) }` opening the modal; `RosterModal` component (props: `sessionId`, `close()`) rendering, in order: team-status banner area, template list (from `listTemplates`), member-name input, model selector (stub in this task), optional task input, custom-role toggle + form, footer confirm/cancel; happy path: pick template → confirm → `spawnMember({ sessionId, templateId, memberName?, model: null, task? })` → success banner with member name (or bilingual error line).
- [ ] **Step 1: Write failing tests** (airboard `tests/client.spec.js` pattern: stub `window.__ModuleLoader__`, strict `require` throwing on unexpected specifiers and mirroring the real primitives export set): "boots and applies with inject-only scope"; "registers one commandUi contribution with kind action"; "locale dictionaries have zh/en key parity and interpolate {param}"; "happy-path spawn payload" (fake remote returns templates; render modal; select first; type task; confirm; assert exact `spawnMember` input incl. `model: null`); "spawn failure renders bilingual error".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `client.js` (styles scoped under `data-agent-roster*` attributes, `--dsw-alias-*` tokens only).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(agent-roster): client scaffold, + menu command, modal spawn happy path"`.

### Task 7: Modal completeness — custom role, AI draft, model selector, team gating

**Files:**
- Modify: `packages/agent-roster/client.js`
- Test: `packages/agent-roster/tests/client.spec.js` (extend)

**Interfaces:**
- Consumes: `draft` (Task 4), `teamStatus` (Task 3), `remote.session.modelCatalog()` (host `@Remote('modelCatalog')` at `packages/api/session-controller/src/index.ts:317-318`), `remote.agentTeams.setEnabled(sessionId, enabled)` (generated face, one method), `remote.pluginInventory.list()` and `remote.pluginManager.setPluginEnabled(entryId, enabled)` (cite `packages/host/plugin-inventory/src/index.ts:68-80`, `packages/boot/plugin-manager/src/index.ts:935-961`) — all via optional `ctx.get(...)` lookups.
- Produces: completed modal behaviors — custom-role form (name/description/prompt + "save as template" checkbox calling `saveTemplate`); AI-draft area (brief textarea + model picker prefilled with current session's model + Draft button calling `draft({ sessionId, brief, model })` with drafting state and abort; result fills the form fields only — nothing saved without explicit confirm); model selector populated from `modelCatalog` with "current session model" default entry and optional reasoning-effort input shown only beside an explicit choice; team banner states: healthy (no banner), `canEnable && !teamMode` → explanation + Enable button → `setEnabled(sessionId, true)` → refresh status, `!isRoot` → explanation-only text pointing at the root session's model-menu toggle, agent-teams rows disabled (detected from `pluginInventory`) → confirm-then-enable both rows `agent-team` and `tool-agent-team` via `setPluginEnabled`, remote surface absent → guidance text only.
- [ ] **Step 1: Write failing tests**: "custom spawn payload (custom xor templateId)"; "draft fills form, save happens only on confirm" (assert no `saveTemplate` until Save clicked); "model selector lists catalog with current-model default; explicit choice sends ModelRef, default sends null"; "enable button appears only when canEnable && !teamMode, calls setEnabled then refreshes"; "non-root shows explanation and no button"; "rows-disabled offers enable for both rows after confirm"; "absent remote shows guidance without throwing".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; full suite.
- [ ] **Step 5: Commit** `git commit -m "feat(agent-roster): modal completeness - custom roles, AI draft, model selection, team gating"`.

### Task 8: Settings card (roster manager)

**Files:**
- Modify: `packages/agent-roster/client.js`
- Test: `packages/agent-roster/tests/client.spec.js` (extend)

**Interfaces:**
- Consumes: `saveTemplate`/`deleteTemplate`/`listTemplates`/`draft`.
- Produces: `ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'agent-roster-card', key: 'dsh-agent-roster', locale: 'agent-roster' }, RosterCard))` (airboard `client.js:1055-1058` pattern); `RosterCard` — list editor rows (name, description, default-model chip, updatedAt), add/edit forms reusing the modal's field components, delete with confirm, and an AI-draft entry (brief → drafting state → review → save). All writes through the service; failures render bilingual reasons.
- [ ] **Step 1: Write failing tests**: "card registers in plugins.bundle.config keyed by package name"; "renders records from listTemplates"; "edit saves through saveTemplate with id"; "delete confirms then calls deleteTemplate"; "draft entry saves only after review confirm".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (extract shared field components from Task 6/7 rather than duplicating).
- [ ] **Step 4: Run** — PASS; full suite.
- [ ] **Step 5: Commit** `git commit -m "feat(agent-roster): plugins-page roster manager card"`.

### Task 9: Metadata, packaging, live-host verification

**Files:**
- Create: `packages/agent-roster/locale/zh.json`, `packages/agent-roster/locale/en.json`, `packages/agent-roster/docs/DETAIL.md`, `packages/agent-roster/docs/DETAIL.zh.md`, `packages/agent-roster/icon.svg`, `packages/agent-roster/scripts/live-verify.md`
- Modify: `packages/agent-roster/package.json` (`files` completeness), `README.md`
- Test: manual/ scripted verification (this task's "tests" are the runbook checks)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write metadata** — `meta.title`/`meta.description`/`meta.detail` in both locales (sentence case for English, e.g. title "Agent roster"; description states only verified behavior); one-paragraph DETAIL docs (en + zh); original 64×64 `icon.svg`; verify `files` covers every runtime file; `npm pack` and inspect the tarball list.
- [ ] **Step 2: Write the runbook** `scripts/live-verify.md` modeled on engram's (`packages/engram/scripts/live-verify.md`): relocate `DSH_HOME` into `.scratch`, `node <dsh-bin> plugin --profile agent-roster-test add <repo>/dsh-agent-roster-<version>.tgz`, boot host `--port 17891 --no-open` as a managed background job, then the checks below.
- [ ] **Step 3: Execute live verification**: (a) status-file stage progression ends `done` and host log shows no fatal path; (b) served client boot graph contains `dsh-agent-roster` with its combo URL (`plugins/??dsh-agent-roster/client.js&rev=…`) — check the graph itself, not the page (Review Focus 5); (c) browser-drive the test host (chrome-cdp tools, fresh tab): Plugins page shows title/description/icon in zh and en; settings card CRUD round-trip; "+" menu → modal → team-off banner → one-click enable → spawn from a template → member appears in the Subagents panel; default spawn inherits the session model; one AI-draft round-trip with the draft session reused (second draft does not create another session); (d) stop the host by exact job id; restore any touched user state; close the tab.
- [ ] **Step 4: Fix any observed defect in-tree, repack, re-verify** until green.
- [ ] **Step 5: Commit** `git commit -m "feat(agent-roster): metadata, packaging, live-host verification"` and update the runbook with the actual evidence.
