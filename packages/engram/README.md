# dsh-engram

A dsh host plugin that embeds [engram](https://github.com/) memory for agents: it stewards the local engram daemon (health probe, auto-spawn or connect-only), registers six curated memory tools (`engram_search`, `engram_save`, `engram_context`, `engram_timeline`, `engram_stats`, `engram_projects`, plus `engram_cloud_status`), bridges DSH↔engram session lifecycles, and optionally injects a memory summary into the prompt. Secrets (daemon HTTP token, cloud sync credentials) live only in the dsh credential store; configuration follows ADR-0005 — no deployment values baked into source.

**Status:** scaffold (Tasks 1–7 of the 2026-11-21 plan). This task ships the package manifest, Config schema, reactive config readers, and the staged status writer only; `apply()` and the daemon/tools/bridge wiring land in later tasks — the package is not yet installable.

Design and full spec: see `docs/specs/2026-11-20-engram-memory-plugin-design.md` and `docs/plan/2026-11-21-engram-memory-plugin.md` in the repository root.
