# dsh-agent-roster

A dsh plugin that keeps a **profile-wide roster of role templates** and turns
it into one-click team building: a "+"-menu member spawn flow (pick a
template, name the member, optionally pick a model and an initial task), a
reusable AI-assisted drafting session for new templates, model-facing
`roster_template_save` / `roster_template_list` tools, and a roster manager
card on the Plugins page. Members are ordinary subagents — the plugin never
renders member lists itself.

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
| `exposeAgentTools` | boolean | `true` | no | Expose `roster_template_save` and `roster_template_list` tools to the model. Structural: edits take effect after plugin reload. |

## Boot observability

Every mount writes its stage progression to
`~/.dsh/agent-roster-status.json` — the file keeps only the latest record,
so it always names the stage the mount currently sits at:
`apply → wire-ready → (storage-degraded when the host exposes no
storageDomain; storage-open-failed when the domain's open() rejects — the
mount proceeds but store operations then fail loudly, and the record carries
the error text) → service-registered → done → tools-registered |
tools-skipped | tools-failed`, or a `wire-failed` record carrying the error
text. Point `AGENT_ROSTER_STATUS_FILE` elsewhere for tests or
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
