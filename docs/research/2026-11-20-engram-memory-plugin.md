# Engram × DSH Integration: Feasibility and Options Comparison

Status: Research (2026-11-20) · decision input, not implemented
Evidence baseline: engram v3.7.2 (live probes on this machine + [Gentleman-Programming/engram](https://github.com/Gentleman-Programming/engram) v3.7.2 tag source/docs) · DSH 0.2.2-rc.5 (source at /home/ramuz/deepseek-harness + live-host runtime inspection)

## 1. Problem restatement and live reproduction

Both of the user's incompatibility claims hold up in testing, but the root causes differ from what was assumed:

1. **"In MCP mode engram needs a resident studio process bound to cwd+project, while DSH's MCP cwd is fixed in multi-workspace mode"**
   - Terminology: **"studio" does not exist anywhere in engram** (likely a memory borrowed from another product, e.g. mem0's "Memory Studio"). engram's resident processes are `engram serve` / `engram run -d` (HTTP API daemon, default 127.0.0.1:7437, pidfile-managed) and the `engram cloud serve` dashboard.
   - `engram mcp` (stdio) is **self-contained** — it opens the SQLite store directly and needs no resident daemon (stated in DOCS.md).
   - The fixed-cwd root cause is on the DSH side: the Web host's MCP fleet is **host-level and shared** (one mcp-manager row, `packages/bundle/web-app/cordis.patch.yml:149-155`); each connection's `cwd` is a static string resolved once at composition (`packages/mcp/mcp-client/src/config.ts:59`; default `''` = the host process's launch directory; DSH's official engram example `apps/cli/config/examples/mcp-memory/engram.cordis.yml` pins it with `cwd: !!js process.cwd()`). The template system supports only `${credential:REF}` (`packages/mcp/mcp-client/src/templates.ts:18-21`) — no `${session.cwd}`; per-session mounting exists only in the ACP path (`packages/acp/acp/src/mcp.ts:49-58`).
   - Effect: one host serving N workspaces with N sessions all talk to a single engram process pinned to one directory → project detection misaligns.

2. **"Under the skill + CLI mode, the workspace-write sandbox blocks writes to ~/.engram"**
   - Reproduced live (during this research, inside the sandbox): `engram search --help` fails outright — `acquire instance identity lock: open /home/ramuz/.engram/.instance-id.lock: read-only file system`. Nearly every engram entry point (including read-only search) takes the instance lock / opens WAL — this is not "writes blocked" but "no CLI call runs at all".
   - Sandbox facts (`packages/sandbox/`): `read-only`/`workspace-write` allow writes only under the workspace root + explicit extra roots + temp areas (`sandbox/src/roots.ts:103-105`); extra roots come three ways — deployment-level `additionalWritableRoots` (sandbox-policy Config), CLI `--add-dir`, and runtime per-session `registerWritableRoot` (`sandbox-policy/src/index.ts:252-269`); read/glob/grep are never gated (`fs-sandbox/src/index.ts:7-8`), but that does not help since engram itself needs lock files.

## 2. Three facts that decide feasibility

### 2a. Host plugin code runs outside the file sandbox (trusted-code model)

- Tool bodies execute in-process in the host with no generic sandbox layer: `packages/core/tools/src/pipeline.ts:280` is a plain `await tool.execute(...)`.
- DSH's own approval copy says it directly: *"installed Host code runs outside the workspace sandbox"* (`packages/boot/plugin-manager/src/tools.ts:109`) — which is exactly why installing plugins requires danger-full-access approval while ordinary file edits do not.
- Confinement exists only inside specific capability seams: bash → `ctx.shell` + `ctx.sandbox.confine`; fs tools → the `ctx.fs` policy fence; terminals and PTC workers similarly. **Nothing intercepts plugin JS using `node:fs` / HTTP / subprocesses.**
- MCP stdio children are also unconfined: `StdioClientTransport` is spawned directly by the MCP SDK (`packages/mcp/mcp-client/src/transport.ts:33-41`), with host privileges.
- Repo precedent: dsh-gitlab's API calls (HTTP) run freely in the host process; only its git subprocesses are confined by the calling session's policy (`packages/gitlab/lib/git-exec.js:123-138`) — "external-service clients are unsandboxed, workspace file operations follow the session" is an accepted pattern here.

**Conclusion: a plugin accessing ~/.engram or a local engram daemon is fully legitimate and opens no sandbox hole.**

### 2b. engram's architecture is far friendlier than "bound to one directory"

- **Project is a per-request parameter, not a process property.** Precedence: explicit `project` argument > process override (`--project`/`ENGRAM_PROJECT`) > `.engram/config.json` > git-remote-based cwd detection > directory-basename fallback (`internal/mcp/mcp.go`).
- The HTTP side has a ready-made **server-side detection probe**: `GET /project/current?cwd=<abs path>` → `{project, project_source, project_path, available_projects}`, with structured errors for `ambiguous` and `explicit_project_required` (unsafe HOME). A plugin **does not need to reimplement git detection** — pass the session's working directory and let the server answer.
- **One daemon / one store serves all projects**: `~/.engram/engram.db` holds every project; reads take `?project=`/`all_projects=`; `mem_update`/`mem_delete` use `expected_project` ownership assertions instead of cwd inference. The HTTP session model (`POST /sessions`, 30-minute lease, `resume` continuations, `isolated_session_registration`/`root_session_resume`/`runtime_session_resolution` capability flags) is designed for many clients over one store.
- **Cloud sync is built in**: `engram cloud serve` (Postgres + `/sync/*` + dashboard) + `engram cloud enroll <project>` + `engram sync --cloud`; daemons/MCP processes support `ENGRAM_CLOUD_AUTOSYNC=1` background sync. This machine's `~/.engram/cloud.json` already points at a private endpoint — a plugin only orchestrates configuration; it does not build sync.

### 2c. DSH provides every required mount point (verified on the live 0.2.2-rc.5 host)

| Capability | Service/interface | Source |
|---|---|---|
| Tool registration | `ctx.tools.register(defineTool({...}))` | `packages/core/tools/src/index.ts:128`; full precedent in packages/gitlab/lib/agent-tools.js |
| System prompt injection | `ctx.systemPrompt.section()`; dynamic values via `systemPrompt.variable(name, provider)` / `context()` | live cordis_inspect catalog; practices.md |
| Per-session cwd | `ctx.workingDirectory.get(session)` | `packages/session/working-directory/src/index.ts:155-157`; multi-workspace = workspaceRegistry above per-session roots |
| Subprocesses | `ctx.subprocess.spawn/resolveExecutable` | live cordis_inspect catalog |
| Credentials | `ctx.credentials.modifyRecord/resolve` | ADR-0005 convention: no baked-in deployment values |
| Config persistence | schemastery `Config` + `configEditor.edit` (volatile fields hot-edit without restart) | configuration.md |
| Plugin-contributed MCP connections | `ctx.mcpManager.register()` (plugin lifetime); McpClient can mount in an agent scope (ACP precedent) | `packages/mcp/mcp-manager/src/index.ts:242-259`; `packages/acp/acp/src/mcp.ts` |
| Lifecycle events | `agents.announce` / `agent/created` → mount on `agent.ctx` | practices.md; live cordis_inspect |

## 3. Options

### Option A: config-only MCP bundle (zero code, works today)

A `cordis.patch.yml` inserting one `@deepseek-ai/dsh-mcp-client` row: `command: engram, args: [mcp, --tools=agent]` (stdio is unconfined; DB access is fine).

- **Pros**: zero code and zero maintenance; the official 23 `mem_*` tools with full semantics (conflicts/judge, session lifecycle, deferred ToolSearch — engram itself already marks 16 tools deferred); MCP instructions auto-injected into the system prompt; DSH's reconnect/on-demand loading infra for free; `toolLoading: on-demand` curbs token cost.
- **Cons**: **project/workspace misalignment is structural** — one host, one engram process, one default project; the only remedies are a fixed `--project` (acceptable for single-project users) or manually duplicating connection entries per workspace (unique serverNames, count = workspace count, manual sync on workspace changes); cwd detection runs against the host's launch directory with unpredictable results. No cloud orchestration, no config card.
- **Verdict**: the right zero-effort start for single-project users; does not solve the multi-workspace problem.

### Option B: skill + CLI + an `additionalWritableRoots` hole (rejected)

Add `~/.engram` to deployment-level `additionalWritableRoots`; a skill teaches the agent the CLI.

- **Pros**: no plugin code; full CLI capability.
- **Cons**: ① grants **every session's bash** raw write access to the whole engram data directory — one `rm ~/.engram/engram.db*` bypasses every engram semantic (soft-delete, `expected_project` assertions, conflict auditing); the worst trust boundary of all options; ② the Windows subprocess backend ignores extra roots (sandbox-policy README); ③ `read-only` sessions lose memory entirely (grants ignored); ④ deployment-level config shares the hole across all sessions of the profile; ⑤ skills rely on model discipline and return no structured errors. The sandbox-policy README's own warning about such grants ("permits changes that a later host invocation can execute") applies.
- **Verdict**: rejected.

### Option C: host plugin as HTTP client of the engram daemon (**recommended**)

The plugin stewards (or connects to) an `engram run -d` daemon and registers curated tools over the HTTP API; the project is resolved per request from the session's working directory via the `GET /project/current?cwd=` probe.

Architecture:
```
┌ DSH host (plugin dsh-engram) ───────────────────────────┐
│ apply(ctx, config)                                      │
│  ├ ensureDaemon(): engram ps → spawn engram run -d if   │──► ~/.engram/engram.db
│  │   needed (host-privilege spawn; ENGRAM_PORT /        │    (single writer, one
│  │   ENGRAM_HTTP_TOKEN / cloud autosync env assembled   │     store, all projects)
│  │   from config + credentials)                         │
│  ├ ctx.inject(['tools','systemPrompt','credentials',    │
│  │   'workingDirectory','subprocess'])                  │
│  │   ├ engram_search/save/context/timeline/stats/       │
│  │   │   projects… (6-8 curated tools, per-request      │──► http://127.0.0.1:7437
│  │   │   project)                                       │    (optional Bearer)
│  │   ├ systemPrompt.section('tool:engram', …)           │
│  │   └ [optional] systemPrompt.variable: inject a       │
│  │       GET /context?project&compact&max_bytes summary │
│  └ agent/created → POST /sessions (dsh SessionId ↔      │
│      engram session, 30-min lease renewed on activity;  │
│      agent end → POST /sessions/{id}/end)               │
└─────────────────────────────────────────────────────────┘
```

- **Pros**:
  - **Naturally correct under multi-workspace** — project is a per-request parameter resolved by the server probe; the misalignment disappears;
  - **one daemon, one SQLite writer** — exactly engram's intended serving shape (no cross-process WAL contention);
  - the tool surface is curated to DSH's tool-design rules (bounded outputs, structured error mapping of engram codes like `ambiguous_project`/`session_project_conflict` into model-readable text);
  - **automated session lifecycle** (register/lease-renew/finalize) and **proactive memory injection** (systemPrompt.variable over `GET /context`) — value neither the skill nor the plain MCP path provides;
  - cloud sync is orchestration only (config → daemon autosync env; credentials in the credentials service, per ADR-0005);
  - everything goes through existing high-level interfaces (tools/systemPrompt/workingDirectory/subprocess) — no hand-rolled framework code, satisfying AGENTS.md §2b.
- **Cons**:
  - daemon lifecycle must be managed (`run -d`'s pidfile + `ps` + `stop` keep it simple; port conflicts, `/health` version probing, and coexistence with user-started instances remain);
  - the self-written tool layer must track engram's API evolution (the project ships **weekly** — v3.6.1→v3.7.2 in three weeks; mitigations: `/health` capability probing + a thin translation layer with no semantic processing + a pinned test baseline);
  - versus the MCP path it lacks the official deep-water tools (`mem_judge`/conflicts) — addable later, the HTTP endpoints exist.
- **Verdict**: the default recommendation.

### Option D: host plugin doing per-session MCP mounts (transplanting the ACP pattern)

The plugin listens for `agent/created` and mounts an McpClient for `engram mcp --project <probe-resolved>` (or project resolution via the side-effect-free `engram hook resolve-hook-project`) in the agent's scope, disposed with the agent. The ACP adapter proves the pattern (`packages/acp/acp/src/mcp.ts:49-58`); agent-scoped namespaces may be reused (`packages/mcp/mcp-client/src/index.ts:52-57`).

- **Pros**: zero tool authoring — the official 23 tools with full semantics; MCP instructions/deferred loading/reconnect for free; per-session project correctness.
- **Cons**: ① **one engram process per live session** concurrently writing one SQLite store (WAL allows a single writer at a time; cross-process contention queues behind locks — throughput/latency under frequent saves is doubtful, and each process carries its own autosync state); ② no one has walked the agent-scoped McpClient path on the Web host (ACP is the only precedent) — the "low-level assembly" gray zone AGENTS.md warns about, on interfaces that are not a public commitment; ③ the 23-`mem_*` surface cannot be trimmed; ④ no cloud orchestration or config card (would need another wrapper anyway).
- **Verdict**: more sensible as an optional mode inside the Option C plugin (`toolSurface: native-mcp`) than as a standalone option; not recommended on its own.

### Option E: redirect ENGRAM_DATA_DIR into the workspace (the workspace-env philosophy, rejected)

One store per workspace, merged via git chunks or cloud sync. Memory fragments per workspace; cross-project recall (engram's core value: `--all` search, global timeline, conflicts) breaks; stores are lost with workspace archival. Rejected; recorded for completeness.

### Summary

| Dimension | A config-only MCP | B hole + skill | C HTTP-client plugin ★ | D per-session MCP mounts | E data-dir redirect |
|---|---|---|---|---|---|
| Sandbox fit | ✓ (MCP unconfined) | ✗ deployment-level hole | ✓ host code outside sandbox | ✓ same | ✓ (writes stay in workspace) |
| Multi-workspace project correctness | ✗ (structural misalignment) | ~ (manual CLI `--project`) | ✓ per-request | ✓ per-session | ✓ but fragmented memory |
| engram capability coverage | all 23 tools | full CLI | curated (extensible) | all | full |
| Token cost | high (on-demand mitigates) | low (skill text) | low (curated + spec'd descriptions) | high | low |
| Session lifecycle / context injection | engram-managed | ✗ | ✓ plugin-automated + injectable | engram-managed | ✗ |
| Cloud sync orchestration | manual env | manual CLI | ✓ config + credentials | manual env | manual git/cloud |
| Maintenance cost | zero | low | medium (tracks API) | medium (novel DSH path) | low |
| Trust boundary | good | **worst** (bash writes the store) | good (narrow HTTP surface) | good | good |

## 4. Landing points for the recommended option (Option C; expanded in the spec)

1. **Config (schemastery, per ADR-0005)**: `mode: local|cloud`, `daemon: auto-spawn|connect-only|manual`, `baseUrl` (default empty = 127.0.0.1:7437), `httpTokenRef` (credentials reference), `cloudServerRef`/`cloudTokenRef`, `autosync: bool`, `contextInjection: off|on`, `projectMode: auto|fixed|per-workspace map`, `toolProfile: core|extended`. Hot-editable fields volatile.
2. **Daemon stewardship**: `/health` probe at mount (version + capabilities); auto-spawn via `subprocess.spawn` (host privileges, cloud credentials in env) when unreachable and allowed; failures fail-loud into the status file (repo staged-status convention: `~/.dsh/engram-status.json`).
3. **Project resolution**: `workingDirectory.get(session)` → `GET /project/current?cwd=`; `ambiguous` errors pass through to the model with `available_projects`; `explicit_project_required` points at config.
4. **Session bridge**: `agent/created` → `POST /sessions {id: <dsh sessionId mapping>, project, ownership_mode}`; lease renewal on activity; agent dispose → `/sessions/{id}/end`. This is the plugin-ized version of "memory settles with the session" (`mem_session_summary` semantics).
5. **Tool surface v1 (core)**: `engram_search`, `engram_save` (idempotent via `operation_id`), `engram_context`, `engram_timeline`, `engram_stats`, `engram_projects`; extended adds update/delete/pin/review/conflicts later.
6. **Cloud sync**: nothing homegrown in v1 — `autosync: true` injects `ENGRAM_CLOUD_AUTOSYNC=1` + `ENGRAM_CLOUD_SERVER` + token (from credentials) into the daemon env; an `engram_cloud_status` tool reads `/sync/status`. Enrollment stays an explicit user action (CLI or an extended tool).
7. **Testing (AGENTS.md discipline)**: strict fakes that fully mirror the HTTP contract (409 `session_project_conflict`, 410 operation_id, the `ambiguous` shape); a real host + real `engram serve` (isolated `ENGRAM_DATA_DIR`) exercising tool calls and daemon orchestration; host-stability monitoring (the fatal-load-failure path).

## 5. Open questions (not blocking the option choice)

- API-stability strategy against engram's weekly cadence: is a thin layer + `/health` capability probing + a pinned test baseline enough?
- The dsh SessionId ↔ engram session id mapping rule (raw / prefix / per-agent satellite, cf. Pi's `<runtimeID>@<project>`).
- Budget and timing of proactive context injection (`systemPrompt.variable` pulling per assembly vs a session-start snapshot with invalidation).
- Port/token discovery when the user already runs a daemon (the pidfile under the data dir is readable).
- Whether the deep-water `mem_*` tools (judge/conflicts) have DSH-side demand — decides the extended surface's priority.

## 6. Evidence index

- DSH: `packages/core/tools/src/{index,pipeline,contracts}.ts` · `packages/sandbox/sandbox-policy/src/index.ts` · `packages/sandbox/sandbox/src/roots.ts` · `packages/fs/fs-sandbox/src/index.ts` · `packages/mcp/mcp-client/src/{config,transport,templates,tools}.ts` · `packages/mcp/mcp-manager/src/index.ts` · `packages/acp/acp/src/mcp.ts` · `packages/bundle/web-app/cordis.patch.yml` · `packages/session/working-directory/src/index.ts` · `packages/boot/plugin-manager/src/tools.ts:109` · `apps/cli/config/examples/mcp-memory/engram.cordis.yml` · `docs/user/guide/mcp-memory.md`
- engram: local `engram --help` (v3.7.2), probes under `~/.engram/` and an isolated `ENGRAM_DATA_DIR` server (/health /search /observations /context /sync/status); upstream [DOCS.md](https://github.com/Gentleman-Programming/engram/blob/v3.7.2/DOCS.md), [internal/mcp/mcp.go](https://github.com/Gentleman-Programming/engram/blob/v3.7.2/internal/mcp/mcp.go), [engram-cloud/README.md](https://github.com/Gentleman-Programming/engram/blob/v3.7.2/docs/engram-cloud/README.md)
- Repo precedents: `packages/gitlab/` (tools + session-sandbox confinement + credentials), `packages/workspace-env/` (the env-redirect philosophy), ADR-0001/0005, CONTEXT.md
