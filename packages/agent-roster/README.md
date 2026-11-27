# dsh-agent-roster

A dsh plugin that keeps a **profile-wide roster of role templates** and turns
it into one-click team building. A template is exactly what you would
otherwise type to the lead agent: a name, a one-line description, the
standing instruction (responsibility boundary and main goal), an optional
base model, an optional high-tier model, and a reuse policy. From the
composer's "+" menu you pick a template, optionally
override the model and add a first task, and confirm — the plugin runs the
`/roster` command, which the transcript records the way it records
`/compact` (a compact command entry: no message from you, no turn of the
lead). The member is created with the template's prompt (frozen, never
rewritten) and **stands by** until it is given work; a first task typed in
the dialog becomes its first assignment. `/roster <template>` can also be
typed directly. The lead agent can create members itself with the
`roster_spawn` tool.

The member's model and reasoning effort can be overridden for a single spawn
from the same dialog — the picker starts from the template's base model, and
choosing "inherit the session model" clears it — without editing the template.
A member created this way is not subject to the tier rules: you chose its
model.

**Model tiers.** The lead does not choose a model. `roster_spawn` takes
`{ template, task?, tier?: 'base' | 'high', reason? }` and the plugin resolves
the tier from the template: `base` (the default) is the base model, or the
session model when the template has none. `high` needs a one-line `reason`
and a template with a high-tier model; otherwise the call is refused before
anything starts. A template accepts a high-tier model only together with a
usable base model (Settings and `roster_template_save` refuse it otherwise). The tool's description states the basis on every call: every
new task starts on the base model; a task moves to the high tier only after
one rework on the base model failed to pass, or when the task brief itself
names the high tier. The tier follows the task, never the role — a high-tier
task does not make the next task high-tier. Every high-tier dispatch is
recorded (time, session, template, member, reason; Settings lists the newest
50) under the template manager in Settings. A failed record write is reported
as a warning on the tool result instead of a record.

**Resident reuse.** A template's reuse policy is `role` (the default) or
`task`. Under `role`, a spawn with a task — `roster_spawn`, the "+" dialog, or the
typed `/roster` command, which share one member registry — hands the task to
an idle member of the same template and model route in the caller's own team
tree and creates a member only when there is none —
including when the only member is busy, so parallel work never queues behind a
resident member. A high-tier member of a role is therefore a separate member.
The command node then says the member is already in the team. A request
without a task adds no member either: it returns that idle member's name
("is already in the team and standing by") and wakes nobody. Under `task`,
every spawn creates a member. The member registry lives for one plugin mount:
a host restart or a plugin reload clears it, after which the first request for
a role creates a member.

**Yield after dispatch.** The tool description tells the lead to end its turn
once nothing is left but waiting — a member's completion notice starts the
lead's next turn, so there is no polling.

Also included: the model-facing `roster_template_save` / `roster_template_list`
authoring tools (the save takes `default_model`, `high_tier_model` and
`reuse`; the list returns them), and an **Agent roster** manager page in
Settings (create / edit / delete, per-template base and high-tier model, reuse
policy). Members are ordinary subagents — the plugin never renders member
lists itself.

Design and full spec: see `docs/specs/2026-11-22-agent-roster-design.md` and
`docs/plan/2026-11-22-agent-roster.md` in the repository root; tiers, reuse
and yield are decided in `docs/adr/0013-model-tiers-and-resident-members.md`.
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
tools-failed`, or a `wire-failed` record carrying the error text. At
unload, a domain `close()` that rejects (or throws) writes
`storage-close-failed` carrying the error text — the release is best effort,
so the plugin never takes the host down over it.
`tools-pending` is the state between the completed mount and the injected
tools callback: the plugin registers `roster_spawn` only once both `tools` and
`subagents` are available (on a host without a subagent runtime it stays
there, which is honest — member creation is the plugin's core capability). The
`/roster` command registers on its own callback (`commands`, `subagents`);
whichever callback lands last writes one terminal record naming both mounts
(`command-registered` when only the command has mounted, `command-failed` on
a failed command registration). The `tools-registered` record's detail carries `{ authoring, command }` — whether the
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
