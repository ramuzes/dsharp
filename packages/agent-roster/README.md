# dsh-agent-roster

A dsh plugin that keeps a **profile-wide roster of role templates** and turns
it into one-click team building. A template is exactly what you would
otherwise type to the lead agent: a name, a one-line description, the
standing instruction (responsibility boundary and main goal), and an
optional model. From the composer's "+" menu you pick a template, optionally
add this session's task, and confirm — the plugin **injects that instruction
into the current conversation**, the lead agent runs its normal loop and
calls the `roster_spawn` tool, and the host creates the member with the
template's prompt (frozen, never rewritten) and model.

The member's model and reasoning effort can be overridden for a single spawn
from the same dialog — the picker starts from the template's default, and
choosing "inherit the session model" clears it — without editing the template.

Also included: the model-facing `roster_template_save` / `roster_template_list`
authoring tools, and an **Agent roster** manager page in Settings (create /
edit / delete, per-template default model). Members are ordinary subagents —
the plugin never renders member lists itself.

Design and full spec: see `docs/specs/2026-11-22-agent-roster-design.md` and
`docs/plan/2026-11-22-agent-roster.md` in the repository root.
Live-host verification runbook (recorded evidence): `scripts/live-verify.md`.

## Install

Plugins → **Add plugin** → point it at this package's local directory
(`packages/agent-roster`). The bundle layer (`cordis.patch.yml`) mounts the
host half on one row (`agent-roster`); enabling the bundle starts it.

## Configuration reference

| Field | Type | Default | Volatile | Meaning |
| --- | --- | --- | --- | --- |
| `exposeAgentTools` | boolean | `true` | no | Expose the `roster_template_save` / `roster_template_list` authoring tools to the model. `roster_spawn` is always registered (the "+" flow depends on it). Structural: edits take effect after plugin reload. |

## Boot observability

Every mount writes its stage progression to
`~/.dsh/agent-roster-status.json` — the file keeps only the latest record,
so it always names the stage the mount currently sits at:
`apply → wire-ready → (storage-degraded when the host exposes no
storageDomain; storage-open-failed when the domain's open() rejects — the
mount proceeds but store operations then fail loudly, and the record carries
the error text) → service-registered → done → tools-pending → tools-registered |
tools-failed`, or a `wire-failed` record carrying the error text.
`tools-pending` is the state between the completed mount and the injected
tools callback: the plugin registers `roster_spawn` only once both `tools` and
`subagents` are available (on a host without a subagent runtime it stays
there, which is honest — member creation is the plugin's core capability). The
`tools-registered` record's detail carries `{ authoring }` — whether the
authoring pair was included (the stage claims the spawn tool, which is
always registered). Point `AGENT_ROSTER_STATUS_FILE` elsewhere for tests or
multi-instance setups — the target resolves at write time, and the writer
is best-effort by contract.

## Tests

```
npm test        # node --test "tests/*.spec.js"
```

Dev-note: this package's devDependencies pin the `0.0.1-rc.1` toolchain
(airboard precedent), which sits behind `dsh-tools`' transitive peer range —
install with `npm install --legacy-peer-deps` (or `npm ci` against the
committed lockfile) when adding dependencies here.
