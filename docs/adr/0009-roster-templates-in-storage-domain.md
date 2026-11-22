# Role templates persist in a storageDomain table, not the Config schema

Status: Accepted (2026-11-22)

## Context

Role templates are user-authored, unbounded lists of long-text records (standing prompts), edited at runtime from two callers: the Plugins-page card and the model-facing roster tools. The repo's Config convention (ADR-0005) is schemastery fields edited through the config editor, where a non-volatile edit restarts the plugin and the Plugins-page card stages field-level writes; there is no built-in table-of-objects editor (`packages/client/ui-primitives` has no select/textarea primitive at all). feishu-gateway already persists comparable user data (bindings) in a `storageDomain` table with zod records.

## Decision

Templates live in a plugin-owned `storageDomain` table (zod-validated records; `put`/`get`/`delete`/`keys`), following the feishu-gateway pattern (`packages/feishu-gateway/index.js:72-107`). The Config schema keeps only behavior toggles (e.g. whether model-facing roster tools are exposed). The storage service is resolved optionally; absence degrades to an in-memory store with a loud status record instead of a crash.

## Considered Options

- storageDomain table (chosen)
- Config schema `Schema.array(Schema.object(...))` — plugin-restart semantics on edits, long prompts serialized into profile-patch YAML, all-or-nothing list rewrites from the card
- Sidecar JSON file under `~/.dsh` — reinvents the storage service, loses validation and serialized writes

## Consequences

- Template CRUD becomes one Host service method set called by both callers (user-actions doctrine: one operation, two callers).
- The Plugins-page card is a custom React list editor talking to that Remote, not a schema-generated form.
- The profile patch YAML stays small and human-reviewable; templates survive restarts via the storage service, not via profile layers.
