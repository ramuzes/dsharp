# Engram integrates as a daemon HTTP-client plugin, not an MCP wrapper or a sandbox hole

Status: Accepted (2026-11-20)

## Context

engram (v3.7.x, Go/SQLite, a single store at `~/.engram/engram.db` holding all projects) must provide shared memory across DSH workspaces. Three constraints fix the shape: ① the DSH Web host's MCP fleet is host-level and shared — each connection's `cwd`/`--project` is resolved once at Loader composition and frozen, with no `${session.cwd}`-style template, so project alignment breaks structurally under multi-workspace (`packages/mcp/mcp-client/src/config.ts`, `apps/cli/config/examples/mcp-memory/engram.cordis.yml`); ② under the `workspace-write` sandbox, in-session CLI is unworkable — every engram entry point (including read-only search) must take the instance lock under `~/.engram` and fails on a read-only filesystem (reproduced live); ③ Host plugin code runs outside the file sandbox (DSH's trusted-code model, `packages/boot/plugin-manager/src/tools.ts:109`), and engram's project is a per-request parameter with an HTTP-side `GET /project/current?cwd=` server probe and a multi-project session model.

## Decision

Implement host plugin dsh-engram: an HTTP client of a local engram daemon (`engram run -d`) that registers curated memory tools (project resolved per request), bridges session lifecycles, optionally injects memory context into prompts, and orchestrates cloud sync. It does not wrap `engram mcp` and does not configure `additionalWritableRoots` for the sandbox.

## Considered Options

- Daemon HTTP-client plugin (chosen)
- config-only MCP bundle — zero code, but the project misalignment is structural; viable only for single-project users
- skill + CLI + `additionalWritableRoots` — grants every session's bash raw writes to the whole memory store (worst trust boundary); grants lapse under `read-only` sessions; the Windows subprocess backend ignores extra roots
- per-session MCP mounts (ACP-pattern transplant) — no precedent on the Web host; one process per session concurrently writing one SQLite store; kept as a future optional mode inside the plugin
- redirecting `ENGRAM_DATA_DIR` into the workspace — fragments memory per workspace and breaks cross-project recall

## Consequences

- The self-written tool layer must track engram's weekly upstream cadence: keep a thin translation layer, probe `/health` capabilities, pin test baselines.
- One daemon, one SQLite writer — engram's intended serving shape; the plugin handles port/token discovery and coexistence with user-started instances.
- The memory store is treated as an external service (as dsh-gitlab treats the GitLab server): plugin tools bypass the session sandbox and never expose store file paths to sessions.
