# AGENTS.md — Working Rules for Agents on This Repo

Working rules for agents on this repository, distilled from the
feishu-gateway development cycle. Two domains follow: integration testing
against a live dsh host, and interface conformance (external services vs.
the dsh host itself).

## 1. Integration Testing Must Observe the Real Host

Unit tests with hand-written fakes are not enough: the two worst bugs of
this project (an unhandled `TypeError` from a missing `AbortSignal`
argument, and a bare-array vs `{items}` mismatch that killed the whole host
process) both passed a 100% green fake-based suite.

- **A background dsh host is part of the test loop.** When you change
  plugin behavior, verify against a real host process (a dedicated test
  profile), not only `node --test`. The agent itself owns this loop: start
  the host, drive the plugin, read the host log / plugin status and event
  files, and confirm the plugin did not destabilize the host.
- **Monitor host impact, not just plugin output.** Watch for the host's
  fatal path (`dsh: fatal load failure` — any dangling rejected promise
  kills the process), crashes, and silent degradation. A plugin bug must
  never take the host down; every plugin entry point stays wrapped in
  containment (`safely()` / `guarded()`).
- **Fakes must replicate real strictness.** A fake that is more forgiving
  than the real interface (missing required parameters, looser return
  shapes) makes the suite lie. Fakes mirror real signatures exactly —
  including bare dereferences — and return shapes must match the real API.
- **No fire-and-forget assertions.** Await side effects (or flush) before
  asserting; a snapshot taken while a send is still queued proves nothing.
- **Process management rules** (learned from two self-inflicted kills):
  stop hosts by exact pid (pid file / managed background job), never
  `pkill -f` with a pattern that can match your own shell or another
  profile's host. Long-running test hosts run as managed background jobs,
  not shell `&`.
- **Per-instance state.** Status/event files are named per profile or
  appId; never assume a single host instance owns `~/.dsh`.

## 2. Interface Conformance: External Services vs. the dsh Host

Feishu is the representative *external* service; the dsh host is the
*internal* platform. Both were violated during development; both rules
below are mandatory.

### 2a. External services (Feishu / Lark SDK and any third-party API)

- **Follow the external protocol strictly.** Do not guess payload shapes
  from examples or analogy. The Lark SDK flattens schema-2.0 events to the
  top level; card JSON has exact schemas. Before writing parsing code, log
  the raw payload (`JSON.stringify`) to the event log and build against
  what actually arrives.
- **Verify members exist before calling them.** Any field or method taken
  from an external service must be confirmed against its shipped types or
  source first. `request.prompt` and `session.lastUserSource()` both looked
  plausible and neither existed.
- **Silent filtering is a defect.** Every filtered/dropped inbound path
  counts and logs its reason; a 100% filter rate must surface loudly, not
  swallow traffic.

### 2b. The dsh host (internal interfaces)

- **The source code is the single source of truth.** dsh ships no stable
  interface contract for in-process plugin consumers beyond TypeScript
  types a JS plugin cannot see. Where documentation is absent or unclear,
  read the dsh code in the checkout and conform to what it actually does —
  never guess, never invent a member, never work around a missing interface
  with assumptions. If an interface you need genuinely does not exist, say
  so explicitly and surface the gap instead of bypassing it.
- **Use the highest-level interface that exists.** Compose through the
  business orchestration layer (e.g. `sessionController` — the same Remote
  surface the Web GUI speaks), not the low-level primitives (`agents`
  create/resume, manual preset setup, hand-built queueing). "I can inject
  the low-level service" does not mean "I should use it". The official
  clients (Web GUI, dsh-mobile) define the correct integration shape: a
  plugin is another browser, translating protocols, not an orchestrator
  rebuilding what the host already guarantees (preset-faithful resume,
  model resolution, idempotent request ids, single-writer semantics).
- **Hand-writing framework-level code is a stop signal.** The moment you
  are hand-assembling setup callbacks, lifecycle resume, queue/steer
  semantics, or catalog assembly, stop and check whether the host already
  provides it. In this project, replacing hand composition with
  `sessionController` calls deleted more code than it added and eliminated
  an entire failure class.
- **Match the host's design philosophy; do not improvise.** Error codes are
  namespaced and typed (`session/writer-held`, `session/agent-busy`) —
  translate them, don't probe around them. Configuration uses the host's
  schema system with its exact semantics (volatile = live-editable AND
  persisted). Persistence goes through host services (`storageDomain` with
  the schema flavor it actually validates with). Optional services are
  resolved by name. When the host models failure as a legal state (silent
  filter, inject-wait, fail-open), add your own assertion at the boundary —
  do not trust the framework to report your mistakes.

## Quick checklist before finishing any change

1. `node --test tests/*.spec.js` green, with strict fakes.
2. Verified on a live background host: plugin active, host stable, inbound
   and outbound paths exercised.
3. Every dsh interface consumed was located in the dsh source (cite file
   paths in code comments — this repo's convention).
4. No hand-rolled equivalent of a host capability remains.
5. External payloads logged raw before being parsed; no silent drops.
