# Agent roster: model tiers, resident members, yield after dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `roster_spawn` lets the lead choose a model *tier* on a stated basis instead of a model, reuses a role's idle member instead of creating one per task, and tells the lead to end its turn while members work.

**Architecture:** Host half only for behavior: the template record gains two optional fields (high-tier model, reuse policy) and a second storage domain records every high-tier dispatch; one spawn function (`spawnFromTemplate`) resolves the model and, under the reuse policy, hands a task to an idle registered member through the subagent runtime's `sendMessage` before creating one. The client half extends the Settings editor and adds the dispatch-record list.

**Tech Stack:** Plain Node ESM, zod, `@deepseek-ai/dsh-tools` (`defineTool`), `@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-typert-protocol`, React through `react-test-renderer` (client tests), `node --test`.

**Spec:** `docs/specs/2026-11-22-agent-roster-design.md` (change 2026-11-27), decision record `docs/adr/0013-model-tiers-and-resident-members.md`.

## Global Constraints

- Package `packages/agent-roster`, version becomes `0.3.0` (Task 8). No new runtime npm dependencies.
- The agent-facing `roster_spawn` accepts no model: parameters are exactly `{ template, task?, tier?: 'base' | 'high', reason? }`.
- `tier: 'high'` requires a non-empty `reason` (`roster/bad-request`) and a template with a high-tier model (`roster/no-high-tier-model`).
- Reuse policy `role` is the default; reuse matches an **idle** member of the same template and the same resolved model route; a busy member never queues work — a sibling is created.
- The rule is identical for base, high-tier and dialog-chosen models.
- Records written before this change load unchanged (new fields are optional with defaults; the templates domain is not re-versioned).
- Docs, comments and tool descriptions in English; UI strings bilingual (`locale/en.json`, `locale/zh.json`, key parity).
- No private details in any committed document: no session ids, local absolute paths, the user's model or template names.
- Every dsh interface consumed is located in the dsh checkout and cited (`file:line`) in a comment. Already located: `packages/subagent/subagent/src/manager.ts:568` (`sendMessage(sender, targetId, content, { signal })`), `packages/subagent/subagent/lib/types/control-types.d.ts` (`SubagentCatalogRow.activity: 'running' | 'inactive'`).
- Tests: `node --test "tests/*.spec.js"` from the package directory; strict fakes (inject-only scopes, real activation signature).

## Review Focus

1. A stored high-tier model with an empty provider or model (record predates validation): `high` must refuse with `roster/no-high-tier-model`, never start a member on a broken route. — Task 2.
2. A member the plugin created but whose session id the runtime did not expose: it cannot be reused; the next request creates a sibling and nothing throws. — Task 3.
3. `listDescendants` returns `kind: 'diagnostic'` entries or omits a registered member (disposed): both are skipped; if the chosen member's `sendMessage` still fails, the failure is reported as text and no second member is created. — Task 3.
4. The dialog stages `model: null` ("inherit") for a template without a base model: that member is reusable by a later `tier: 'base'` request (same route key `inherit`). — Task 2.
5. `roster_template_save` with `reuse` misspelled or `high_tier_model` on a template that has no base model: both refused with model-facing text, nothing stored. — Tasks 4, 5.

---

### Task 1: Template fields and the high-tier dispatch log (store)

**Files:**
- Modify: `packages/agent-roster/lib/store.js`
- Test: `packages/agent-roster/tests/host.spec.js` (storage section, helpers `makeFakeStorageDomain`, `makeFakeTable`, `scopeWithStorage`)

**Interfaces:**
- Produces: `RoleTemplate` gains `highTierModel: ModelRef.nullable().default(null)` and `reuse: z.enum(['role', 'task']).default('role')`.
- Produces: `export const HighTierUse = z.object({ id: z.string().min(1), at: z.string(), sessionId: z.string(), templateId: z.string(), templateName: z.string(), memberName: z.string(), reason: z.string().min(1) })`.
- Produces: `export const rosterLogDomain = defineDomain({ name: 'agent_roster_log', version: 1, tables: { highTierUse: domainTable(HighTierUse) } })` — a **separate** domain, so the templates domain keeps its name, version and stored records untouched.
- Produces on the store handle: `log: { add(record): Promise<void>, list(limit = 50): Promise<HighTierUse[]> }` — `list` returns newest first (by `at` descending).

- [ ] **Step 1: Write the failing tests** in `tests/host.spec.js`:
  - `openRosterStore loads records written before the tiers change with role reuse and no high-tier model`: put through the fake domain a template without the two fields; `byId` returns `highTierModel === null` and `reuse === 'role'`.
  - `the store keeps high-tier use in its own domain, newest first`: `log.add` three records with increasing `at`, `log.list()` returns them in reverse order and `log.list(2)` returns two.
  - `makeFakeStorageDomain` opens each domain by its `name`; the test asserts both `agent_roster` and `agent_roster_log` were opened (update the fake to record names — it must mirror the real `open(spec)` signature).
- [ ] **Step 2: Run** `node --test tests/host.spec.js` — the three cases fail (`highTierModel` undefined, `log` not a function).
- [ ] **Step 3: Implement** the schema additions, the log domain, and `log` on the handle. In memory mode `log.add` pushes to an array and `list` sorts by `at` descending. Keep the `ready.catch` acknowledgement pattern for the second domain's open promise (same unhandledRejection reason as the file header documents).
- [ ] **Step 4: Run** the package suite — all pass.
- [ ] **Step 5: Commit** `feat(agent-roster): template high-tier model and reuse policy, high-tier dispatch log`.

### Task 2: Tier resolution

**Files:**
- Create: `packages/agent-roster/lib/tiers.js`
- Modify: `packages/agent-roster/lib/spawn.js` (`spawnFromTemplate` model block, lines ~231–249; result)
- Test: `packages/agent-roster/tests/spawn.spec.js`

**Interfaces:**
- Consumes: Task 1 fields.
- Produces: `export const TIERS = Object.freeze(['base', 'high'])`.
- Produces: `export function usableModel(value)` → the parsed `{ provider, model, reasoningEffort? }` or `null` when absent or with an empty provider/model (the defensive rule `spawnFromTemplate` applies to `defaultModel` today, extracted).
- Produces: `export function sameModel(a, b)` → boolean, exact on provider, model and effort (`undefined` equals `''`).
- Produces: `export function resolveMemberModel(template, { tier, model })` → `{ model: ModelRef | null, tier: 'base' | 'high' | 'custom' }`. An explicit `model` (`null` or object, the dialog path) wins and its tier is `base`/`high` when it equals that stored model, else `custom`; otherwise `tier` (default `base`) selects the stored model. Throws `RemoteError('roster/bad-request', …)` for a tier outside `TIERS` and `RemoteError('roster/no-high-tier-model', 'Template "<name>" has no high-tier model; add one in Settings or use the base tier / 模板未配置高阶模型…', { template: id })` for `high` without a usable stored high-tier model.
- Produces: `export function requireReason(reason)` → the trimmed string, or throws `RemoteError('roster/bad-request', 'reason is required with tier "high" — state the escalation basis / 使用 high 档位必须填写理由', { field: 'reason' })`.
- `spawnFromTemplate(scope, deps, input)`: `input` gains `tier?: 'base' | 'high'`; result gains `tier` and `reused: false`.

- [ ] **Step 1: Write the failing tests** in `tests/spawn.spec.js` (existing `fakeSubagents`, `RESEARCHER`, `ROUTED` fixtures; a `TIERED` fixture = `ROUTED` plus `highTierModel: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'max' }`):
  - `tier high runs the member on the template's high-tier model` — activation `agentOptions` is the high-tier model; result `{ tier: 'high', reused: false }`.
  - `tier high without a high-tier model rejects typed and spawns nothing` — code `roster/no-high-tier-model`, `activations.length === 0`.
  - Review Focus 1: `a malformed stored high-tier model refuses high and degrades base to inherit` — `highTierModel: { provider: '', model: 'x' }`: `high` → `roster/no-high-tier-model`; `base` on a template with the same malformed `defaultModel` spawns without `agentOptions`.
  - Review Focus 4: `inherit is one route: a dialog member and a base member of a model-less template resolve to the same tier and route` — `resolveMemberModel(RESEARCHER, { model: null })` and `{ tier: 'base' }` both return `{ model: null, tier: 'base' }`.
  - `requireReason trims and refuses blank` — `'  concurrency  '` → `'concurrency'`; `'  '` rejects with `roster/bad-request`.
- [ ] **Step 2: Run** `node --test tests/spawn.spec.js` — new cases fail (no `lib/tiers.js`).
- [ ] **Step 3: Implement** `lib/tiers.js` and replace the model block in `spawnFromTemplate` with `const { model, tier } = resolveMemberModel(template, { tier: input?.tier, model: input?.model })` — the existing per-spawn override tests must keep passing unchanged.
- [ ] **Step 4: Run** the package suite — all pass.
- [ ] **Step 5: Commit** `feat(agent-roster): resolve a member model from a tier instead of an agent-chosen model`.

### Task 3: Resident reuse

**Files:**
- Create: `packages/agent-roster/lib/members.js`
- Modify: `packages/agent-roster/lib/spawn.js`, `packages/agent-roster/lib/roster-command.js` (`successText`), `packages/agent-roster/index.js` (registry wiring)
- Test: `packages/agent-roster/tests/spawn.spec.js`, `packages/agent-roster/tests/command.spec.js`

**Interfaces:**
- Consumes: Task 2 (`model`, `tier`).
- Produces: `export function modelKeyOf(model)` → `'inherit'` or `` `${provider}/${model}@${effort}` ``.
- Produces: `export function createMemberRegistry()` → `{ remember(rootId: string, childId: string, entry: { templateId: string, modelKey: string, name: string, tier: string }): void, candidates(rootId: string, templateId: string, modelKey: string): string[] }` (in-memory `Map`s; child ids in insertion order).
- Produces: `export async function findIdleMember({ subagents, registry, rootId, templateId, modelKey })` → `{ childId: string, name: string } | null` — the first registered candidate that `listDescendants(rootId)` lists as `kind: 'child'` with `activity: 'inactive'`.
- Produces: `export function assembleTaskMessage(task)` → `'A new task from the lead of your team. Your standing role is unchanged; this task is what to do now:\n\n' + task` (the reuse counterpart of `assembleMemberOpening`; the task verbatim and trimmed).
- `spawnFromTemplate`: deps gains `registry?`; when `template.reuse === 'role'` and a registry is present, it first looks for an idle member and, with a task, calls `subagents.sendMessage(root, childId, [{ type: 'text', text: assembleTaskMessage(task) }], { signal })`, returning `{ name, childSessionId: childId, model, tier, reused: true }`; without a task it returns the same without messaging. Otherwise it creates as today, then `registry.remember(root.id, activation.childId, …)` when `activation.childId` is a string.
- `index.js`: `const registry = createMemberRegistry()` in `apply`; passed as `registry` to `registerRosterTools` deps and `registerRosterCommand` deps; the command's `spawn` wrapper passes `{ subagents, registry }`.

- [ ] **Step 1: Write the failing tests** in `tests/spawn.spec.js` (extend `fakeSubagents` with `messages: []` and a recording `sendMessage(sender, targetId, content, options)` that returns `'m1'`; let it take a `activityOf(childId)` function defaulting to `'inactive'` for known children — mirror the real signature exactly):
  - `role reuse hands a second task to the idle member and starts no activation` — two spawns of `RESEARCHER` with tasks: one activation, one message whose text starts with the fixed sentence and ends with the second task; second result `{ reused: true, name: <first name> }`.
  - `a busy member is not reused: a sibling is created` — `activityOf` returns `'running'` for the first child: two activations.
  - `reuse policy task creates a member every time` — `reuse: 'task'`: two activations, no message.
  - `another model route is another member` — base then `tier: 'high'` on `TIERED`: two activations.
  - `a standby request for a role that already stands by returns the member and wakes nobody` — no task on the second call: no activation, no message, `reused: true`.
  - `a model-less template inherits one route and is reused` — `RESEARCHER` twice reuses.
  - Review Focus 2: `a member without an exposed session id is never reused and nothing throws`.
  - Review Focus 3: `diagnostic entries are skipped and a failing delivery is reported, not retried with a second member` — `sendMessage` throws: the call rejects with that error and `activations.length` stays 1.
  - `the registry is scoped to the caller's tree root` — two roots, same template: two activations.
  - In `tests/command.spec.js`: `the command reports a reused standby member without "created"` — text `Member "<name>" (<template>) is already in the team and standing by. Model: <route>.`; with a task: `… is already in the team and was given its first task. Model: <route>.`
- [ ] **Step 2: Run** `node --test tests/spawn.spec.js tests/command.spec.js` — new cases fail.
- [ ] **Step 3: Implement** `lib/members.js`, the reuse branch in `spawnFromTemplate` (before name allocation; the `root` is already computed there), the `successText` variant, and the `index.js` wiring. Cite `manager.ts:568` at the `sendMessage` call.
- [ ] **Step 4: Run** the package suite — all pass.
- [ ] **Step 5: Commit** `feat(agent-roster): reuse a role's idle member before creating one`.

### Task 4: `roster_spawn` takes a tier, the authoring tools carry the new fields

**Files:**
- Modify: `packages/agent-roster/lib/agent-tools.js`
- Test: `packages/agent-roster/tests/tools.spec.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- `roster_spawn` parameters: exactly `template` (unchanged), `task` (unchanged), `tier: { type: 'string', enum: ['base', 'high'], description: 'Model tier for this task. Default base. high requires reason.' }`, `reason: { type: 'string', description: 'One line stating the escalation basis (required with tier high).' }`. The `model` parameter is removed.
- Description (exact copy): `Give a task to a team member of a configured role template, creating the member when the role has no idle one. The template carries the member's standing instruction and its models; pass the template id from the instruction that asked for this member, or its exact display name. Model tier — every new task starts on the base model; move to high only after one rework on the base model failed to pass, or when the task brief itself names the high tier. The tier follows the task, never the role. Do not restate the template yourself — the template text is used verbatim. Once nothing is left but waiting for members, end your turn: a member's completion notice starts your next turn, so do not poll with wait_agent.`
- Result text: `{ member, template, tier, reused, model, reason? }` (`reason` only for `high`).
- `roster_template_save` gains `high_tier_model` (same `oneOf` shape as `default_model`) and `reuse: { type: 'string', enum: ['role', 'task'] }`; `roster_template_list` rows gain `highTierModel` and `reuse`.

- [ ] **Step 1: Write the failing tests** in `tests/tools.spec.js`:
  - `roster_spawn has no model parameter; tier and reason are the only model inputs` — `Object.keys(tool.parameters).sort()` equals `['reason', 'task', 'template', 'tier']`.
  - `roster_spawn tier high passes the reason-checked tier and reports it`.
  - `roster_spawn tier high without a reason is refused and spawns nothing` — text contains `roster/bad-request`.
  - `roster_spawn high on a template without a high-tier model reports roster/no-high-tier-model`.
  - Replace the three existing `model`-argument cases with: `a tier outside the enum is rejected by the real tools library before the tool runs` (the `INVALID_ARGS` case, now for `tier: 'ultra'`).
  - `roster_template_save passes high_tier_model and reuse; list rows carry highTierModel and reuse`.
  - Review Focus 5 (tool half): `roster_template_save with a misspelled reuse is rejected by the tools library`.
- [ ] **Step 2: Run** `node --test tests/tools.spec.js` — new cases fail, the removed `model` cases fail.
- [ ] **Step 3: Implement**: delete the `model` parameter and its `toModelRef` use in `roster_spawn`; call `requireReason` when `tier === 'high'`; pass `tier`; extend the two authoring tools. The dispatch record is written in Task 6.
- [ ] **Step 4: Run** the package suite — all pass.
- [ ] **Step 5: Commit** `feat(agent-roster): roster_spawn takes a model tier and states the escalation basis`.

### Task 5: Service — template write rules and `listHighTierUse`

**Files:**
- Modify: `packages/agent-roster/lib/roster-service.js`
- Test: `packages/agent-roster/tests/host.spec.js`

**Interfaces:**
- Consumes: Task 1 store (`log`), Task 2 (`usableModel`).
- `saveTemplate(input)`: `input` gains `highTierModel?: ModelRef | null` and `reuse?: 'role' | 'task'` with the same patch semantics as `defaultModel`. Refuses (`roster/bad-request`, field named) a high-tier model with an empty provider or model, and a high-tier model on a template whose effective `defaultModel` is `null` (`a high-tier model requires a base model / 配置高阶模型前请先配置基础模型`).
- `listHighTierUse()` → `this.store.log.list(50)`. Registered as the fifth Remote method (`Object.freeze({ method: 'listHighTierUse', invocation: direct })`).

- [ ] **Step 1: Write the failing tests** in `tests/host.spec.js`:
  - `saveTemplate stores highTierModel and reuse, patch-semantics on update`.
  - Review Focus 5 (service half): `saveTemplate refuses a high-tier model without a base model and one with empty parts`.
  - `AgentRosterService carries Remote markers for template CRUD, stageSpawn and listHighTierUse` — update the existing marker test's expected list to `['deleteTemplate', 'listHighTierUse', 'listTemplates', 'saveTemplate', 'stageSpawn']`.
  - `listHighTierUse returns the newest records from the store log`.
- [ ] **Step 2: Run** `node --test tests/host.spec.js` — new cases fail.
- [ ] **Step 3: Implement** the input handling and the method. Update the `RoleTemplateInput` parse call to carry both new fields.
- [ ] **Step 4: Run** the package suite — all pass.
- [ ] **Step 5: Commit** `feat(agent-roster): template write rules for tiers and the listHighTierUse remote`.

### Task 6: High-tier dispatch records from the tool

**Files:**
- Modify: `packages/agent-roster/lib/agent-tools.js` (deps), `packages/agent-roster/index.js` (pass `store` already present)
- Test: `packages/agent-roster/tests/tools.spec.js`

**Interfaces:**
- Consumes: Task 1 `store.log.add`, Task 4 result.
- After a successful `roster_spawn` with `tier === 'high'`, the tool calls `store.log.add({ id: freshId(), at: new Date().toISOString(), sessionId: String(exec?.agent?.session?.id ?? ''), templateId: template.id, templateName: template.name, memberName: result.name, reason })`. A log write failure does not fail the dispatch: it returns the result plus `warning: 'high-tier use was not recorded'` (a record loss must never undo a started member, but it is reported, not swallowed).

- [ ] **Step 1: Write the failing tests** in `tests/tools.spec.js`:
  - `a high-tier dispatch writes a record with the reason and session`.
  - `a base dispatch writes no record`.
  - `a failed record write reports a warning and keeps the result`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the package suite — all pass.
- [ ] **Step 5: Commit** `feat(agent-roster): record every high-tier dispatch with its reason`.

### Task 7: Settings editor and record list (client)

**Files:**
- Modify: `packages/agent-roster/client.js` (`RosterCardForm`, `RosterCardPage` row, remote method list), `packages/agent-roster/locale/en.json`, `packages/agent-roster/locale/zh.json`
- Test: `packages/agent-roster/tests/client.spec.js`

**Interfaces:**
- Consumes: Task 5 remotes (`saveTemplate` new fields, `listHighTierUse`).
- Remote namespace mounts **five** method descriptors (the existing test `apply mounts the agentRoster remote namespace with exactly four method descriptors` becomes five).
- Form: a second `ModelRefEditor` for the high-tier model (`marker: 'data-agent-roster-high-model'`, `noneMarker: 'none'`, none label `High tier not enabled / 未启用高阶`) and a `<select>` `data-agent-roster-reuse` with options `role` / `task`. Saving sends `highTierModel` and `reuse`.
- Row chip: base model text, plus ` → high` when `highTierModel` is set (`data-agent-roster-row-model`).
- Below the manager: `data-agent-roster-use` block — heading, `data-agent-roster-use-empty` when there are no records, else rows `data-agent-roster-use-row` with `data-agent-roster-use-reason`.

- [ ] **Step 1: Write the failing tests** in `tests/client.spec.js` (helpers `applyPlugin`, `healthyRoster`, `find`, `texts`, `modelTrigger`):
  - `the remote namespace mounts five method descriptors`.
  - `the form saves a high-tier model and the reuse policy`.
  - `a template row shows the base model and names the high tier when set`.
  - `the high-tier use block lists records with their reason, or the empty note`.
- [ ] **Step 2: Run** `node --test tests/client.spec.js` — fail.
- [ ] **Step 3: Implement** plus the locale keys (both files; the parity test must stay green).
- [ ] **Step 4: Run** the package suite — all pass.
- [ ] **Step 5: Commit** `feat(agent-roster): Settings editor for tiers and reuse, high-tier use records`.

### Task 8: Docs, version, live verification

**Files:**
- Modify: `packages/agent-roster/package.json`, `package-lock.json` (root `version` fields), `packages/agent-roster/README.md`, `packages/agent-roster/docs/DETAIL.md`, `packages/agent-roster/docs/DETAIL.zh.md`, `packages/agent-roster/scripts/live-verify.md`, `CONTEXT.md` (roster paragraph)
- Test: the package suite

- [ ] **Step 1: Version** to `0.3.0`; update the READMEs and DETAIL pages (tiers, escalation basis, reuse, yield, records; bilingual), and the `roster_spawn`/standby paragraphs in `CONTEXT.md`. No private details.
- [ ] **Step 2: Run** the package suite and the workspace suite — all pass.
- [ ] **Step 3: Commit** `chore(agent-roster): 0.3.0 docs and version`.
- [ ] **Step 4: Live verification** on the live profile (reinstall through `plugin_manager`; approval prompts): stage record `tools-registered { authoring, command }`; then from the lead's own session — save a template with a high-tier model; `roster_spawn` base with a task, wait for the member to settle, `roster_spawn` base again with another task → same member name, a new turn in the member's session log and no new session directory; `roster_spawn` `high` with a reason → member on the high-tier model and a record in Settings; `high` without a reason → refused; end the turn after a dispatch and confirm the settle notice starts the next lead turn (`turn/start` preceded by a `subagent-settled` message in the session log). Evidence method and a redaction rule for the record file as in the existing `live-verify.md`.
- [ ] **Step 5: Record the evidence** in `scripts/live-verify.md` and commit `docs(agent-roster): 0.3.0 live verification`.
