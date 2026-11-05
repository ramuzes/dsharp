# 0004 — chrome-cdp reuses the browser-use subsystem to mount chrome-devtools-mcp

Status: Accepted (2026-10-19)

## Context

The DSH agent must be able to operate the user's real, daily-use Chrome (over CDP, with logged-in sessions), and sensitive actions must pass human approval. Candidate implementation paths:

1. Ride the host browser-use subsystem: `ctx.browserUse.register` + reuse `mountSessionMcp` (one exclusive MCP child process per live Session);
2. Hand-rolled per-session mount: depend only on dsh-mcp-client + dsh-scope, replicating the createScope / agent/created / scope.ctx.plugin core;
3. Config-only bundle: a cordis.patch.yml inserting a global mcp-client row (the mechanism already proven by the B spike);
4. Native CDP tools: hold a WebSocket to the debug endpoint inside the host process and register tools ourselves.

## Decision

Path 1. The plugin = a provider (following the in-tree browser-use-chrome-devtools-mcp mounting pattern, adding the `auto` connection mode that passes through `--auto-connect`) + a global `tools/pre-execute` approval gate (matching the `mcp__chrome-cdp__` prefix, not intruding into the runtime) + a Plugins-page config card and a status command.

- The `chrome-devtools-mcp` dependency is **pinned exactly**: the approval lists are maintained against its tool-name surface, and minor-version changes may rename or add tools.
- No launch (disposable browser) mode: the in-tree provider already covers that scenario; this plugin targets the real browser only.
- The approval gate is a global listener (not agent-scoped): MCP tools are uniformly visible to all sessions, so the gate must be uniform too.

## Consequences

- We inherit all host semantics — per-Session exclusivity, busy-session masking, discovery awaited during creation — and hand-roll no framework-level lifecycle (an AGENTS.md hard rule).
- Cost one: a dependency on an experimental alpha package (browser-use-runtime). Implementation step 0 must verify that its published npm tarball actually ships the `./mcp` export and `mountSessionMcp`; if missing, vendor the minimal mounting core per path 2, citing provenance and differences in code comments.
- Cost two: upstream provider behavior may change (experimental); the live-host verification loop is the backstop.
- Revision (2026-11-05): the runtime dependency moved from an exact npm pin to peerDependencies "*" — it resolves from the dsh installation, so it always matches the running host and no pin bump follows dsh releases. Rationale: semver ranges cannot express "any later prerelease in the 0.2.x line" (prerelease comparators only match the same major.minor.patch tuple), so every dsh bump would otherwise invalidate an exact pin (observed twice: 0.2.2-alpha.2, 0.2.2-rc.1). Local tests pin it via devDependencies. Revisit when the browser-use packages graduate from experimental: at that point a stable range (or the graduated API) replaces the peer.
- Consistent with the B-spike findings: every mechanism already exists; the plugin assembles rather than invents. The two practical pitfalls (the `- insert:` patch dialect and the chrome-devtools-mcp dual-bin trap) are recorded in the research note §7.
