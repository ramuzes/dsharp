# Engram Memory Plugin (dsh-engram) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `packages/engram` — a DSH host bundle giving every session curated engram memory tools over a locally stewarded `engram run -d` daemon, with per-request project resolution, a session bridge, optional prompt injection, and cloud-sync orchestration.

**Architecture:** Host plugin = HTTP client of the local engram daemon (per ADR-0007). Tool bodies run host-side (outside the session sandbox — DSH's trusted-code model); project comes from `GET /project/current?cwd=<session working dir>`; DSH↔engram session lifecycles bridge via `agent/created` listeners registering on `agent.ctx`; proactive injection registers a per-agent systemPrompt section whose provider closes over the agent's session (`AssembleContext` carries no session identity — the closure is the only correct channel).

**Tech Stack:** Node ESM, no new runtime deps (`fetch` global; peer: `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`). Tests: `node --test`. UI card copies the chrome-cdp `plugins.bundle.config` pattern.

**Spec:** `docs/specs/2026-11-20-engram-memory-plugin-design.md` (argues from it; read it first). Research with evidence: `docs/research/2026-11-20-engram-memory-plugin.md`.

## Global Constraints

- All code comments, docs, README, and locale values in this package: **English**.
- ADR-0005: no deployment addresses/credentials as schema defaults or patch-layer fallbacks — defaults empty or protocol-generic; secrets only as credential-ref names.
- Every config read goes through `readString`/`readNumber` (Loader hands schemastery reactive wrappers — raw string methods die). Hot-editable fields declared `.volatile()`.
- Every callback's `ctx.inject([...])` lists exactly the services it touches; accessing an uninjected service throws (fakes must model this strictness).
- Staged status file `~/.dsh/engram-status.json`, env-overridable via `ENGRAM_STATUS_FILE`; every mount stage recorded; never fatal.
- No unhandled rejections into the host: all entry points contained; tool errors become model-readable text, never rethrown.
- `engines.dsh`: `^0.2.2-rc.5` (exact running version incl. prerelease; engines alone decides).
- HTTP contract shapes (fakes mirror exactly — from the research doc's live probes): `POST /observations` 400 `{"error":"session_id and content are required"}`; 409 bodies carry `error` + conflict codes; `GET /project/current` ambiguous → 200 `{project: null, project_source: "ambiguous", available_projects: [...]}`; unsafe HOME → 409 `explicit_project_required`; `/health` → `{status, version, capabilities}`.
- Run focused tests from `packages/engram`: `node --test tests/<name>.spec.js`; full: `pnpm -F dsh-engram test` (deps installed once via `pnpm install` at repo root).
- Commit per task on branch `engram-plugin`: `git add packages/engram && git commit -m "feat(engram): ..."`.

## Review Focus

Five input classes the task tests below do not all exercise — each pinned to its owning task:

1. **Wrong process on the daemon port** (any HTTP server answering non-engram JSON): tools fail with `engram/bad-response`, never crash → Task 2 test `rejects non-JSON daemon responses`.
2. **Daemon dies after a healthy first use**: the memoized ensure is invalidated on `engram/unreachable`, the next tool call re-ensures once (respawn or clean instructive error) → Task 8 test `re-ensures daemon after a mid-session death`.
3. **Oversized payloads** (search/context): output truncated at 8000 chars with a trailing `…[truncated]` marker, never dumped whole → Task 5 test `truncates oversized tool output`.
4. **Blank credential refs with autosync on** (cloud refs empty): daemon spawns without cloud env, `engram_cloud_status` still answers; no crash → Task 8 test `buildDaemonEnv omits blank cloud refs`.
5. **Save when session registration failed earlier**: `engram_save` retries registration (self-healing) and only then surfaces the instructive error → Task 5 test `save retries session registration once`.

---

### Task 1: Package scaffold, Config schema, status writer

**Files:**
- Create: `packages/engram/package.json`, `packages/engram/cordis.patch.yml`, `packages/engram/index.js`, `packages/engram/lib/status.js`, `packages/engram/locale/en.json`, `packages/engram/locale/zh.json`, `packages/engram/icon.svg`, `packages/engram/README.md`
- Test: `packages/engram/tests/host.spec.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `export const Config` and `readString`/`readNumber` (index.js, exported for tests); `makeStatusWriter(file?) → { note(stage, detail?) }` (lib/status.js); installable-but-inert package (apply added in Task 8; `index.js` for now exports Config + helpers only).

- [ ] **Step 1: Write the failing test**

```js
// tests/host.spec.js — node:test + assert/strict, house style of packages/gitlab/tests
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { Config } from '../index.js'
import { makeStatusWriter } from '../lib/status.js'

test('Config defaults are empty/generic and volatile (ADR-0005)', () => {
  const parsed = Config({})
  assert.equal(parsed.daemonMode, 'auto-spawn')          // protocol-generic default ok
  assert.equal(parsed.port, '')                           // empty, never 7437 baked as deployment value? (7437 is engram's protocol default — allowed as documented default)
  assert.equal(parsed.autosync, false)
  assert.equal(parsed.contextInjection, 'off')
  assert.equal(parsed.contextMaxBytes, 2048)
  assert.equal(parsed.projectMode, 'auto')
  assert.equal(parsed.fixedProject, '')
  assert.equal(parsed.toolProfile, 'core')
  // volatile fields: assert via Config behavior used by index (spot-check presence in schema)
})
```
Note: `port` default `''` with the *client* treating empty as 7437 (documented protocol default, not a deployment value) — assert `parsed.port === ''`.
Plus a `makeStatusWriter` test: writes `{stage, detail, at}` JSON to a tmpdir file; `note` on an unwritable path does not throw.

- [ ] **Step 2: Run test to verify it fails** — `node --test tests/host.spec.js` → FAIL (module not found).

- [ ] **Step 3: Implement.** `package.json` mirrors `packages/gitlab/package.json`: name `dsh-engram`, version `0.1.0`, `"type": "module"`, `main: "index.js"`, exports `[".", "./client", "./locale/*.json", "./icon"]` (client.js lands in Task 9 — keep the export from Task 1 pointing at the file and add it in Task 9), `files: [index.js, client.js, cordis.patch.yml, lib, locale, icon.svg, README.md]`, `scripts.test: node --test "tests/*.spec.js"`, `dsh.bundle.patch: ./cordis.patch.yml`, `dsh.client: { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-plugin-manager", "@deepseek-ai/dsh-client-ui-settings"] }`, `peerDependencies` (schemastery `*`, dsh-tools `*`), `devDependencies` (same trio as gitlab incl. cordis `4.0.4`), `engines: { dsh: "^0.2.2-rc.5" }`.
`Config = Schema.object({...})` with every field from spec decision 2, all hot-editable ones `.volatile()`; `projectMap: Schema.dict(String).default({})`. `cordis.patch.yml`: one insert row `id: engram, name: dsh-engram`, config `{ port: !!js "process.env.DSH_ENGRAM_PORT ?? ''" }` (env fallback only for the non-secret generic field). `readString`/`readNumber` copied from `packages/gitlab/index.js:40-48`. `lib/status.js` per the interface above. Locale files: `meta.title`/`meta.description` (en + zh), no `meta.detail` in v1. `icon.svg`: simple original 24×24 glyph (memory/engram motif; no third-party artwork). README stub: one-paragraph purpose + "see docs/specs".

- [ ] **Step 4: Run test to verify it passes** — `node --test tests/host.spec.js` → PASS.
- [ ] **Step 5: Commit** — `git add packages/engram && git commit -m "feat(engram): scaffold package, config schema, staged status writer"`

### Task 2: engram HTTP client

**Files:**
- Create: `packages/engram/lib/engram-api.js`
- Test: `packages/engram/tests/api.spec.js`

**Interfaces:**
- Consumes: none.
- Produces:
  - `export class EngramError extends Error { constructor(code, message, { status?, info? } = {}) }`
  - `export function createEngramClient({ baseUrlProvider, tokenProvider, timeoutMsProvider, fetchImpl = fetch })` → `{ get(path, query?, signal?), post(path, body?, signal?), del(path, query?, signal?) }` — JSON bodies; `Authorization: Bearer <token>` only when token non-empty; `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs())])`.
  - `export async function probeHealth(client, signal?)` → `{ version, capabilities }`; `export function isSupportedVersion(version)` → `true` iff major/minor ≥ 3.7.

- [ ] **Step 1: Write the failing tests** — strict `fetchImpl` fake (mirrors real shapes from Global Constraints): happy path GET `/search?q=x&project=p` returns JSON; POST `/observations` 400 body passthrough → `EngramError` with `code 'engram/http'`, `status 400`, `info.error === 'session_id and content are required'`; network `TypeError: fetch failed` → `engram/unreachable`; **non-JSON 200 body** → `engram/bad-response`; Bearer header present only when tokenProvider returns non-empty; query serialization (`all_projects: true` → `all_projects=true`).
- [ ] **Step 2: Verify fail** → module not found.
- [ ] **Step 3: Implement** per interface; error text includes code + server `error` field.
- [ ] **Step 4: Verify pass**; **Step 5: Commit** `feat(engram): HTTP client with strict engram contract errors`.

### Task 3: Daemon stewardship

**Files:**
- Create: `packages/engram/lib/daemon.js`
- Test: `packages/engram/tests/daemon.spec.js`

**Interfaces:**
- Consumes: `createEngramClient`, `probeHealth`, `isSupportedVersion` (Task 2).
- Produces: `export function ensureDaemon({ client, probe = probeHealth, subprocess, spawnEnabled, buildEnv, note, retry = { attempts: 5, delayMs: 300 }, signal })` → `Promise<{ version, capabilities }>`; throws `EngramError` codes: `engram/unsupported-version`, `engram/daemon-unreachable` (connect-only instructive text: name the configured port and the `daemonMode` switch), `engram/daemon-spawn-failed`.

- [ ] **Step 0 (discovery, no code):** read `SubprocessOutcome` fields in `/home/ramuz/deepseek-harness/packages/subprocess/subprocess/src/types.ts` (~line 156+) and mirror exactly what the failure check uses (e.g. `success`/`code`/`stderr` accessors — use only members that exist).
- [ ] **Step 1: Write the failing tests** with a strict subprocess fake: `{ spawn(spec) }` capturing spec, returning `{ done: Promise<SubprocessOutcome-shaped object> }`. Cases: (a) healthy+supported → returns, no spawn; (b) healthy but version 3.6.1 → `engram/unsupported-version` mentioning `>=3.7`; (c) unreachable + `spawnEnabled: false` → `engram/daemon-unreachable` with instructive text; (d) unreachable + spawn → asserts `spec.argv === ['engram', 'run', '-d']`, `spec.env` equals `buildEnv()` output, probe then succeeds on retry (delay 0 in tests); (e) spawn whose `done` resolves failed with lock/port text in stderr → `engram/daemon-spawn-failed` advising `port` config or `connect-only`; (f) probe never succeeds within attempts → `engram/daemon-unreachable`; (g) success path calls `note('daemon-spawned')`.
- [ ] **Step 2: Verify fail.** **Step 3: Implement** — bounded retry loop, never throws raw.
- [ ] **Step 4: Verify pass**; **Step 5: Commit** `feat(engram): daemon stewardship with spawn/retry/port-collision paths`.

### Task 4: Project resolution

**Files:**
- Create: `packages/engram/lib/project-resolution.js`
- Test: `packages/engram/tests/project-resolution.spec.js`

**Interfaces:**
- Consumes: client (Task 2).
- Produces: `export class ProjectAmbiguousError extends Error { available }`; `export class ProjectExplicitRequiredError extends Error {}`; `export function createProjectResolver({ client, getMode, getFixedProject, getProjectMap, getWorkingDir })` → `{ async resolve(session, explicit?) → { project, source } }`. Precedence: `explicit` → `fixed` (mode `fixed`; empty value → `EngramError('engram/project-misconfigured')`) → longest-prefix match over `getProjectMap()` against `getWorkingDir(session)` → probe `GET /project/current?cwd=`. Cache Map keyed `${session.id}:${cwd}` (self-invalidating on cwd change — no event wiring needed).

- [ ] **Step 1: Failing tests** with fake client mirroring real shapes: normal probe (`project_source: 'git'`); ambiguous (200 + `available_projects: ['a','b']`) → `ProjectAmbiguousError` with `.available` deep-equal; 409 `explicit_project_required` → `ProjectExplicitRequiredError`; map longest-prefix wins over shorter; explicit arg beats everything; cache hit does not re-probe (call counter); new cwd → new probe.
- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass.** **Step 5: Commit** `feat(engram): per-session project resolution with ambiguity passthrough`.

### Task 5: Agent tools + save-worthiness prompt section

**Files:**
- Create: `packages/engram/lib/agent-tools.js`
- Test: `packages/engram/tests/agent-tools.spec.js`

**Interfaces:**
- Consumes: client, resolver (Tasks 2/4).
- Produces: `export const ENGRAM_PROMPT_TEXT` (string); `export function registerAgentTools(ctx, deps)` → disposer. `deps = { client, resolveProject, ensureReady: () => Promise<void>, ensureSession: async (exec) => void, sessionIdOf = (agent) => agent?.session?.id ?? '' }`. Registers on `ctx.tools` + `ctx.systemPrompt.section({ name: 'tool:engram', order: 2370, text: ENGRAM_PROMPT_TEXT })`. Tools (all with optional `project` param; read-only ones `isConcurrencySafe: () => true`; every execute wrapped in try/catch → `failure(error)` text):

| tool | params (required in bold) | call |
|---|---|---|
| `engram_search` | **q**, type?, scope?, limit? (default 20, max 50), all_projects?, project? | GET /search |
| `engram_save` | **title**, **content**, type?, project? | await `ensureSession(exec)`; POST /observations `{ session_id, title, content, type?, project: resolved, operation_id: exec.callId }` |
| `engram_context` | compact? (default true), max_bytes?, project? | GET /context |
| `engram_timeline` | **observation_id**, before?, after?, project? | GET /timeline |
| `engram_stats` | all_projects?, project? | GET /stats |
| `engram_projects` | — | GET /projects |
| `engram_cloud_status` | project? | GET /sync/status |

Every execute starts with `await deps.ensureReady()` then `resolveProject(exec?.agent?.session, args.project)`. Output: `JSON.stringify` of a trimmed payload, truncated at 8000 chars + `…[truncated]`. `failure()` maps `EngramError`/`ProjectAmbiguousError` to text; ambiguous text must list `available` and mention the `project` parameter.

- [ ] **Step 1: Failing tests** (house style: fake ctx with only `tools`+`systemPrompt`): registration set = the 7 names + section `{name: 'tool:engram', order: 2370}`; **`ENGRAM_PROMPT_TEXT` contains the save-worthiness policy** — assert it names each: "decisions", "preferences", "constraints", "conclusions", and the negatives "transient", "re-derivable", "secrets", plus "search before saving" (spec decision 9); `engram_save` description contains "durable" and "not" (policy embedded at call site); execute paths: save happy (asserts body incl. `operation_id === exec.callId` and resolved project), ambiguous → result text includes both available names; **truncation** (fake returns 10k-char content → output ≤ 8013 chars with marker); **save retries session registration once**: `ensureSession` rejects twice→ save error text mentions session; rejects once then resolves → save succeeds; search `limit` clamped to 50.
- [ ] **Step 2: Verify fail.** **Step 3: Implement** — mirror `packages/gitlab/lib/agent-tools.js` structure (defineTool import, `register` helper pushing disposers, TEXT_OUTPUT-style output).
- [ ] **Step 4: Verify pass.** **Step 5: Commit** `feat(engram): curated tool surface with save-worthiness policy`.

### Task 6: Session bridge

**Files:**
- Create: `packages/engram/lib/session-bridge.js`
- Test: `packages/engram/tests/session-bridge.spec.js`

**Interfaces:**
- Consumes: client, resolver.
- Produces: `export function registerSessionBridge(rootCtx, deps)` → `{ dispose, ensureSession(agent) }`. `deps = { client, resolveProject, note, sessionIdOf = (agent) => agent?.session?.id ?? '' }`. Listens `rootCtx.on('agent/created', agent => ...)`; inside the listener registers on `agent.ctx.effect(() => { ...registration...; return () => end() })` (agent disposal runs `end`). Registration: `POST /sessions { id: 'dsh-' + sessionIdOf(agent), project, ownership_mode: 'project_owned', resume: true }` (create-or-renew semantics). `ensureSession(agent)`: no-op within 4 min of last success for that agent, else re-POST (used by `engram_save`). End: `POST /sessions/{id}/end` with body `{}`, contained (failures only `note`). All bridge failures contained — they must never block the agent.

- [ ] **Step 1: Failing tests** with fake root ctx (`on(name, fn)` capturing listeners; fake agent = `{ ctx: { effect(fn) { registered.push(fn); return () => {} } } }`): agent/created fires → POST /sessions called with `dsh-` prefix + `resume: true` + resolved project; dispose (run the effect's returned teardown) → `/sessions/{id}/end` called; registration rejects → listener does not throw (contained), `note` called; `ensureSession` debounce: second call within TTL → single POST (call count), after TTL (inject clock) → renewed; unresolved project (resolver throws ProjectAmbiguousError) → no POST, `note('bridge-unresolved-project')`, no throw.
- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass.** **Step 5: Commit** `feat(engram): dsh↔engram session bridge with renewal and contained teardown`.

### Task 7: Proactive context injection

**Files:**
- Create: `packages/engram/lib/context-injection.js`
- Test: `packages/engram/tests/context-injection.spec.js`

**Interfaces:**
- Consumes: client, resolver.
- Produces: `export function registerContextInjection(rootCtx, deps)` → disposer. `deps = { client, resolveProject, note, getEnabled, getMaxBytes, ttlMs = 60_000, now = Date.now }`. On `agent/created`: `agent.ctx.effect(() => agent.ctx.systemPrompt?.section({ name: 'engram:memory', order: 2330, text: () => provider(agent) }))` (guard: no systemPrompt on agent ctx → skip + note). Provider: disabled → `''`; resolve cached per (session, cwd); fetch `GET /context?project=<p>&compact=true&max_bytes=<getMaxBytes()>`; TTL cache; any error → `''` (fail-open) + `note`. Text wrapper: `"## Project memory (engram)\n" + context`.

- [ ] **Step 1: Failing tests** (fake agent ctx with `systemPrompt.section` capturing; injected clock): enabled+healthy → section text starts with the header and contains fetched context; ambiguous project → `''` and note; client rejects → `''` (fail-open, no throw); disabled → `''` and zero client calls; TTL: two provider calls within TTL → 1 client call, after TTL → 2.
- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass.** **Step 5: Commit** `feat(engram): per-agent proactive context injection (fail-open, TTL-cached)`.

### Task 8: index.js apply() integration

**Files:**
- Modify: `packages/engram/index.js`
- Test: `packages/engram/tests/host.spec.js` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: `export function apply(ctx, config)` — the full mount. Stages via status writer: `apply → tools-inject → tools-registered`. Inside `ctx.inject(['tools', 'systemPrompt', 'credentials', 'subprocess'], async (scope) => {...})`: build providers from config (readString/readNumber each use); resolve `httpTokenRef`/`cloudTokenRef`/`cloudServerRef` via `scope.credentials.resolve(ref)` with a `credentials/reference-updated` listener refreshing the cached values (gitlab index.js:109-151 pattern); `buildEnv()` composing only non-empty: `ENGRAM_PORT`, `ENGRAM_HTTP_TOKEN`, and when `autosync` on: `ENGRAM_CLOUD_AUTOSYNC: '1'`, `ENGRAM_CLOUD_SERVER`, `ENGRAM_CLOUD_TOKEN`; memoized `ensureReady` = `ensureDaemon(...)` invalidated on `engram/unreachable` (one re-ensure per failure, then surface error); register bridge (`ctx.on('agent/created')` listeners owned by plugin fiber via `ctx.effect`); register injection; register tools with `deps = { client, resolveProject, ensureReady, ensureSession: (exec) => bridge.ensureSession(exec?.agent), sessionIdOf }`.

- [ ] **Step 1: Failing tests** extending host.spec: mount with reactive config wrappers (`{ get: () => value }`) and strict fake services (only injected names present; `credentials.resolve` fake; `subprocess.spawn` fake; `ctx.on`/`ctx.effect` fakes) → asserts status stages sequence; **re-ensure after mid-session daemon death**: first tool execute succeeds, client then throws `engram/unreachable`, `subprocess.spawn` fake armed to make probe succeed again → next execute succeeds and spawn called once; **buildEnv omits blank cloud refs** (all refs resolve empty, autosync on) → env has no `ENGRAM_CLOUD_*` keys; volatile config edit (`getBaseUrl`-style provider re-read) reflected on next call without remount.
- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: `node --test` full suite pass.** **Step 5: Commit** `feat(engram): apply() wiring — credentials, daemon ensure, bridge, injection, tools`.

### Task 9: Client config card + display resources + README

**Files:**
- Create: `packages/engram/client.js`
- Modify: `packages/engram/README.md`, `packages/engram/locale/en.json`, `packages/engram/locale/zh.json`
- Test: `packages/engram/tests/client.spec.js`

**Interfaces:**
- Consumes: chrome-cdp pattern (`packages/chrome-cdp/client.js:371-401`).
- Produces: `client.js` default export `{ inject: ['slots', 'locale', 'configForms'], apply(ctx) }` — registers dictionaries `ctx.locale.register(NS, { zh, en })`, then `ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: ID, locale: NS, inject: card.face }, EngramConfigCard)))`; `EngramConfigCard` renders the Config fields (grouped: daemon / project / injection / cloud) copying chrome-cdp card markup patterns, classes prefixed `engram-`, only `--dsw-alias-*` tokens.

- [ ] **Step 1: Failing test**: fake ctx with `slots`/`locale`/`configForms` fakes (inject/register/subscribe captured) → apply registers the dictionary and the `plugins.bundle.config` slot entry keyed by the bundle id; dispose removes both.
- [ ] **Step 2: Verify fail.** **Step 3: Implement** — no Remote namespace needed in v1 (chrome-cdp's status namespace pattern is the v2 status-card precedent).
- [ ] **Step 4: Verify pass.** **Step 5: README full pass** (English): purpose, install, config reference table (matching Config), daemon stewardship behavior, save-worthiness summary, limitations (v1 core surface; no update/delete; enroll is a CLI action).
- [ ] **Step 6: Commit** `feat(engram): plugins-page config card, locale, README`.

### Task 10: Live-host verification + packaging

**Files:**
- Create: `packages/engram/scripts/live-verify.md` (a runbook capturing the loop + observed evidence, committed)
- No unit test cycle — this task's steps ARE the checks.

**Interfaces:**
- Consumes: installed bundle on a dedicated test profile; real engram binary.

- [ ] **Step 1: Isolated daemon**: `D=$(mktemp -d); ENGRAM_DATA_DIR="$D" ENGRAM_PORT=17437 engram run -d`; `engram ps` (with same env) reports running.
- [ ] **Step 2: Dedicated test profile host**: discover the launch command (`dsh --help`); start `DSH_PROFILE=engram-test` host as a managed background job; confirm its advertised URL responds.
- [ ] **Step 3: Install**: `plugin_manager install_bundle` with `packages/engram` as target (approval per policy); result must report `application: applied`; no pending builds.
- [ ] **Step 4: Host-half evidence**: `~/.dsh/engram-status.json` (test profile's) shows `apply → tools-inject → tools-registered`; `curl -N <host>/plugins/events` prints the engram entry and its combo URL (boot-graph check per AGENTS.md §3).
- [ ] **Step 5: Exercise**: in a session on the test profile (Web GUI or headless CLI), with plugin config `port: 17437`: call `engram_save` (a durable test observation with `project: 'engram-plugin-verify'`), then `engram_search` for it — both succeed; kill the isolated daemon by exact PID; call `engram_search` again → auto-respawn path exercised (status shows `daemon-spawned`) and search succeeds; verify the Plugins page shows the config card (per `references/verification.md`; if no browser control, inspect served graph + report unverified).
- [ ] **Step 6: Stability + cleanup**: host log shows no `dsh: fatal load failure` / plugin errors; `remove_bundle`; stop test daemon by exact pid; delete `mktemp` dir; write observations into `scripts/live-verify.md`.
- [ ] **Step 7: Pack**: `pnpm -F dsh-engram pack` → `dsh-engram-0.1.0.tgz` at repo root (house convention); commit runbook + any fixes: `git commit -m "feat(engram): live-host verification runbook and packaging"`.

---

## Self-Review (done)

1. **Spec coverage**: config (T1/T8), daemon stewardship incl. port-collision + connect-only (T3), project resolution incl. map/ambiguous/explicit + `project` param on all tools (T4/T5), tool surface 6+1 + policy text + operation_id semantics (T5), session bridge register/renew/end/resume + contained degradation (T6), injection on/off/budget/fail-open (T7), cloud orchestration env-only + status tool (T5/T8), English-only + ADR-0005 + status file + inject strictness (Global Constraints, T1/T8 tests), config card via minimal client.js (T9), engines.dsh (T1), live verification per AGENTS.md (T10). Gap check: spec's "resume: true continues the same root session" — pinned in T6 registration body. `toolProfile` config field exists but v1 implements core only — Config field present (T1), no behavioral branch (YAGNI, noted in README).
2. **Step scan**: each step names files/signatures/exact asserts; no TBDs.
3. **Type consistency**: `EngramError(code, message, {status, info})` used in T2/T3/T5; `resolveProject(session, explicit?) → {project, source}` in T4/T5/T6/T7; `ensureSession(agent)` in T5 deps vs T6 export — reconciled via T8 wiring `(exec) => bridge.ensureSession(exec?.agent)`.
4. **Granularity**: every task carries integration risk or semantic edges beyond transcription; none is a pure types/constants task.
5. **Review Focus**: all five lines carry their owning-task tests (T2, T8, T5, T8, T5).
6. **Proportion**: plan ≈ 1.5× spec; code blocks are signatures/asserts only.
