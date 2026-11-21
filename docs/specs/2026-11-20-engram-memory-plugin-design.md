# dsh-engram — Engram Memory Plugin Design

Status: Draft (2026-11-20) · Ref: ADR-0007 · Research: docs/research/2026-11-20-engram-memory-plugin.md

## Requirement (the why & what)

### Problem statement

The user runs engram persistent memory (Go/SQLite; a single store at `~/.engram/engram.db` holding all projects) across multiple DSH workspaces. Both off-the-shelf integration paths are broken:

- **MCP mode**: the DSH Web host runs MCP servers as a host-level shared fleet; each connection's `cwd`/`--project` is resolved once at Loader composition and frozen — there is no per-session template token. Under multi-workspace, engram's project resolution is structurally misaligned (every workspace's sessions talk to one process pinned to one directory).
- **Skill + CLI mode**: under the `workspace-write` sandbox, every engram CLI entry point (including read-only `search`) fails outright because it cannot take the instance lock under `~/.engram` (reproduced live during research). Granting `additionalWritableRoots` for `~/.engram` would expose the entire store to every session's bash, bypassing all engram semantics.

### Goal

Ship an installable dsh-engram bundle: every session in every workspace reads and writes the shared memory store through curated tools, with the project resolved correctly per session; sessions can optionally auto-register with engram, receive a memory-context summary in the prompt, and have private-cloud sync orchestrated by the plugin. No sandbox holes; no store file paths exposed to sessions.

### User stories

1. As an agent, I want to save an observation (title + content + type), so that key decisions and facts persist across sessions.
2. As an agent, I want to search memories by keyword/type/scope and get timeline context, so that I can reuse prior conclusions instead of rediscovering them.
3. As an agent, I want to pull a project's recent context and stats, so that I start with knowledge of prior work.
4. As a multi-workspace user, memories saved from a session in any workspace must land in the correct engram project, and searches must scope to that project unless explicitly cross-project.
5. As a user, I want the daemon stewarded by the plugin (probe → spawn on demand → health check), so that I never manage it manually.
6. As a user, I want sessions to auto-register with engram on start and auto-finalize on end, so that memory accumulates per session without relying on the model's discipline to call tools.
7. As a user, I want "proactive context injection" to optionally place a bounded memory summary in the prompt (default off).
8. As a user, I want to configure the local store or private-cloud sync on the Plugins page (server URL/token via the credential store), with no deployment values baked into source.
9. As a user, when the daemon is unreachable/incompatible or the project is ambiguous, I want tools to return clear actionable errors instead of failing silently, and the host to stay stable.
10. As an agent, when project resolution is ambiguous, I want the error to list the available projects and tell me how to specify one explicitly.
11. As a user, I want the agent to exercise its own judgment when saving — persisting durable decisions, user preferences, discovered constraints, and investigation conclusions, while skipping transient or re-derivable content — so that the store stays high-signal instead of an echo of the conversation.

### Out of scope

- Deploying/operating the engram cloud backend itself (`engram cloud serve`; the user already runs one).
- engram deep-water tools: conflicts/judge, obsidian-export, TUI, doctor/repair (deferred to a v2 extended profile).
- The per-session MCP mount mode (`toolSurface: native-mcp`; recorded in ADR-0007 as a future option).
- Modifying the DSH upstream (the plugin uses only existing public service interfaces) or the engram upstream.
- Memory store schema, multi-store routing, per-workspace stores (explicitly rejected: memory fragmentation).

## Design (the how)

### Solution

dsh-engram is a host plugin (packages/engram/, shaped like dsh-gitlab) that works as an **HTTP client of a local engram daemon**: on mount it stewards the daemon (health probe; auto-spawn `engram run -d` per config when unreachable), registers six curated memory tools (project resolved per request), bridges DSH↔engram session lifecycles, optionally injects a memory summary into the prompt, and orchestrates the cloud-sync environment for the daemon. The memory store is treated as an external service: plugin tools do not go through the session sandbox, and sessions cannot reach store files through the plugin.

### Implementation decisions

1. **Package shape**: single-package bundle (manifest + one insert row in cordis.patch.yml), host logic + a **minimal client.js** — the browser half does exactly one thing: register the Plugins-page config card into the `plugins.bundle.config` slot, mirroring the host Config schema (chrome-cdp precedent; DSH renders config cards only from the client side, so a host-only bundle's card silently never appears). No other UI in v1. Declare `engines.dsh` against the current 0.2.2-rc.5. Follow repo plugin conventions: staged status file (`~/.dsh/engram-status.json`, env-overridable), explicit inject lists on every callback, defensive `readString`/`readNumber` on every config read, containment wrappers on all entry points. **All code comments and documents in this package are English.**

2. **Config (schemastery; per ADR-0005 — defaults empty or protocol-generic, no deployment values)** *(revised 2026-11-21)*:
   - `daemonMode: auto-spawn | connect-only` (default `auto-spawn`)
   - `port` (default empty = 7437), `httpTokenRef` (credential reference, default `ENGRAM_HTTP_TOKEN`; the Plugins-page **secret control** — feishu SettingsSecretField pattern — pastes the value straight into the credential store, write-only, Configured/Not-set badge)
   - `autosync: boolean` (volatile, default false)
   - `contextInjection: off | on` (volatile, default off) + `contextMaxBytes` (default 2048)
   - `projectMode: auto | fixed | map`, `fixedProject` (for `fixed`), `projectMap` (workspace-root prefix → project name)
   - `toolProfile: core | extended` (v1 implements core only; field declared forward)
   - **Cloud server/token config is deliberately absent**: upstream resolves them from `~/.engram/cloud.json` with env as *override* — duplicating them here would silently shadow the user's engram configuration. `autosync` only passes the env-only `ENGRAM_CLOUD_AUTOSYNC=1` opt-in to daemons this plugin spawns.
   - Hot-editable fields declared volatile; secrets never appear as config values, only reference names.

3. **Daemon stewardship**: on first tool call or mount, `GET /health` (validate version ≥ 3.7 and capability flags); if unreachable and `auto-spawn`, run `engram run -d` via `ctx.subprocess` with host privileges (env assembly: `ENGRAM_PORT` if configured, `ENGRAM_HTTP_TOKEN`, and `ENGRAM_CLOUD_AUTOSYNC=1` when autosync is on — **never** cloud server/token, which upstream resolves from the user's own `~/.engram/cloud.json`); bounded-backoff health retries after spawn; `connect-only` never spawns and reports an instructive error when unreachable. When a user-started instance on another port makes the instance lock refuse our spawn, the failure lands in the status file with guidance to configure `port` or switch to `connect-only` — v1 does no pidfile discovery (see Further notes). Every stage lands in the status file.

4. **Project resolution** (on every memory operation): if `projectMode=map` and the session's working directory matches a prefix → explicit project; otherwise the server probe `GET /project/current?cwd=<workingDirectory.get(session)>`; results cached per (session, cwd), invalidated on working-directory change events. `ambiguous` → the tool error passes through `available_projects` plus guidance (configure the map, or pass `project` explicitly in the call); `explicit_project_required` → points at config. **All six memory tools accept an optional `project` parameter** overriding resolution (precedence matching engram's: explicit argument > config > probe), so an ambiguous workspace can still search — it never depends on a session editing host config.

5. **Tool surface (core: 6 memory tools + 1 cloud-status tool)**: `engram_search` (q/type/scope/limit/cross-project switch), `engram_save` (title/content/type; the tool description embeds the save-worthiness policy so the criteria are visible at the call site; `operation_id` derived from callId for idempotency, passing through 409/410 semantics — this idempotency covers transport-level retries only; a model re-issuing a save after a timeout gets a new id and a possible duplicate, accepted as consistent with engram semantics), `engram_context` (budget params, compact by default), `engram_timeline` (observation_id/before/after), `engram_stats`, `engram_projects`; all accept the optional `project` parameter (decision 4). Additionally `engram_cloud_status` (reads `GET /sync/status`, decision 8). Outputs follow repo tool-design rules: bounded, plain-text JSON, errors mapped to model-readable text (including engram error codes), never rethrown into the host. Read-only tools declare `isConcurrencySafe: true`.

6. **Session bridge**: listen for agent creation; in that agent's context call `POST /sessions` (id `dsh-<sessionId>`, project from that session's resolution, ownership mode by project ownership); tool activity renews the lease (engram's 30-minute lease semantics); agent disposal calls `POST /sessions/{id}/end`. DSH resume → engram `resume: true` continues the same root session. **The bridge registers and finalizes sessions only — it never extracts or auto-saves conversation content; what gets remembered is always the agent's explicit decision through `engram_save`.** Bridge failure never blocks the session (degrade to bare tools without session association; error to the status file).

7. **Proactive context injection**: when `contextInjection=on`, a systemPrompt dynamic-value provider pulls `GET /context?project=<resolved>&compact&max_bytes=<budget>` with a short TTL cache to avoid per-step HTTP; fetch failure is fail-open (omit the section) but recorded in the status file. No injection when the project is unresolved (ambiguous) or the daemon is unreachable.

8. **Cloud sync orchestration**: the plugin does not implement sync — when autosync is on it injects the cloud environment into the daemon it stewards; the `engram_cloud_status` tool surfaces `GET /sync/status` (including reason codes like `blocked_unenrolled`). Enrolling a project stays an explicit user action (CLI or a future extended tool). Under `connect-only` with a user-managed daemon, cloud configuration remains engram's own (cloud.json/env) and the plugin never rewrites it.

9. **System prompt**: register a `tool:engram` section (order adjacent to `tool:gitlab`) carrying an explicit **save-worthiness policy** — saving is the agent's judgment call, and the guidance states what qualifies and what does not (mirroring engram's own proactive-save rule):
   - **Worth saving**: decisions and their rationale (chosen approach, rejected alternatives); durable user preferences and constraints; discovered environment facts that were costly to learn (versions, quirks, working configurations, paths that matter); investigation conclusions and answers that took real work; corrections that supersede an earlier memory.
   - **Not worth saving**: transient state (todo lists, scratch paths, in-flight file names); content re-derivable at trivial cost (file contents, command output, docs the next session can read again); conversation echo and pleasantries; secrets or credentials (never); anything a quick search shows is already stored.
   - **Discipline**: search before saving to avoid near-duplicates; when an observation contradicts an existing one, say so in the content and reference the prior observation (dedicated update/conflict tools arrive with the v2 extended surface).
   The section also covers: project resolution is automatic and usually need not be passed; and do not run the engram CLI directly in bash (the session sandbox blocks it).

10. **Display resources**: `locale/en.json` + `locale/zh.json` meta (title/description/detail); original icon; verify on the Plugins page per the dsh-doc checklist after installation.

### Testing decisions

- **Strict fakes + the real contract**: HTTP fakes mirror real engram serve behavior exactly (409 `session_project_conflict`, the `ambiguous_project` shape, operation_id 409/410, `explicit_project_required`), with shapes taken from live probes against a real server under an isolated `ENGRAM_DATA_DIR` (recorded in the research doc). Fakes must be no more forgiving than the real API (AGENTS.md §1).
- **Real-host loop**: a dedicated test profile runs a background host + a real engram server with an isolated data dir; drive tool calls, assert status-file stages and host stability (no fatal load failure / mount crash); also verify that mount-failure paths do not take the host down.
- **Priority cases**: project resolution's three shapes (normal/ambiguous/explicit-required), daemon stewardship's three paths (auto-spawn/connect-to-existing/connect-only-unreachable), the session bridge (register/renew/finalize/resume/bridge-failure degradation), injection on/off and budget truncation, volatile hot-reload of config, missing-credential error paths.
- **Prior art**: packages/gitlab/tests (API fake strictness, error-mapping assertions), airboard's status-file stage assertions, feishu-gateway's host-loop scripts.

## Further notes

- The session-id mapping rule (`dsh-<sessionId>` prefix) and satellite-session variants are finalized during implementation planning; engram's `<runtimeID>@<project>` precedent applies.
- engram releases weekly: CI pins a baseline version + forward-compatible `/health` capability probing; the spec does not bind a patch version.
- Discovery of user-managed daemons on non-default ports (reading the pidfile/port record under the data dir) is a v1.1 candidate; v1 uses the configured port only.
- v2 candidates (recorded, not committed): the extended tool surface (update/delete/pin/review/conflicts), the native-mcp mode switch, a Plugins-page status card (daemon/sync state visualization).
