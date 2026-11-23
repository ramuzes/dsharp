# dsh-agent-roster Live-Host Verification Runbook

Date: 2026-11-23 · bundle `dsh-agent-roster-0.1.0.tgz` (shasum
`5781e96ef4fa413fbc1b13f90700687160642ea3`) · DSH checkout
`/home/ramuz/deepseek-harness` (release 0.2.2-rc.5, commit 2e39e70) ·
profile `agent-roster-test` · host port 17891

The recorded evidence of Task 9: prove the packed bundle on a real dsh
host, per AGENTS.md §1 ("a background dsh host is part of the test loop")
and §3 (boot-graph pitfalls). Modeled on `packages/engram/scripts/
live-verify.md`; every command below was actually run, deviations called
out inline.

**Scope ruling (controller).** The test profile carries NO model
credentials, so everything that needs no LLM is verified live; the
model-backed draft happy path is deferred to user acceptance in the real
GUI.

**Environment deviation (read first).** Browser control (chrome-cdp) was
REJECTED by the environment when first invoked, so no page was driven.
Fallback, per the ruling and dsh-doc `references/verification.md`
("inspect the installed resources and report that rendered display
remains unverified"):

1. Served-over-HTTP checks (boot graph, client combo) were done with curl.
2. The Plugins-page **metadata resources** were verified as installed
   package files (locale JSON, icon SVG, DETAIL docs) — see step 6.
3. The plugin's **remote surface** (what the settings card, spawn modal,
   and draft area call through the gateway) was driven by a throwaway
   sibling bundle, `.scratch/roster-driver/dsh-roster-driver-0.0.3.tgz`:
   it injects the `agentRoster` service dsh-agent-roster registers and
   calls all six remote methods with the client's exact payload shapes.
   Two cordis lessons are recorded there: the inject callback receives a
   scoped **ctx**, so the service is `scope.agentRoster` (schedule
   index.ts:250-256 pattern), not the callback argument; and a shell-loop
   status poller is reaped when its shell exits — in-process pollers or
   managed jobs only.

## Step-by-step commands and observed evidence

### 1. Pack

```
cd packages/agent-roster
npm pack --pack-destination ../.. --cache ../../.scratch/npm-cache
```

Result: `dsh-agent-roster-0.1.0.tgz` at the repo root (gitignored),
package size 46.9 kB, **17 files**: `index.js`, `client.js`,
`cordis.patch.yml`, `lib/*` (7 modules), `locale/{en,zh}.json`,
`icon.svg`, `docs/DETAIL{,.zh}.md`, `README.md`, `package.json`. Unit
suite before packing: **107 pass / 0 fail**.

### 2. Create the test profile

```
export DSH_HOME=<repo>/.scratch/dsh-home
node /home/ramuz/deepseek-harness/apps/cli/lib/bin.js --profile agent-roster-test \
  --from-default-profile web --dump-config
```

Exit 0; `profiles/agent-roster-test/` created; `storeDir:
<repo>/.scratch/pnpm-store` appended to its `pnpm-workspace.yaml` (the
engram §2 read-only-store fix).

### 3. Install the bundle

```
node <bin> plugin --profile agent-roster-test add <repo>/dsh-agent-roster-0.1.0.tgz
```

`+ dsh-agent-roster 0.1.0 … done` (pnpm 11.28.5, hard-linked from
`.scratch/pnpm-store/v11`).

### 4. Boot the test host (managed background job — NEVER pkill)

```
AGENT_ROSTER_STATUS_FILE=<repo>/.scratch/agent-roster-test-status.json \
  node <bin> --profile agent-roster-test --port 17891 --no-open
```

The host prints `dsh web: http://127.0.0.1:17891/?token=…`; the root URL
answers 401 without the token (auth fence), 303→app HTML with it.

### 5. Host-half evidence

* **Status file.** Every boot's latest record is the terminal success
  stage `{"stage":"tools-registered"}` (never `wire-failed`, never
  `storage-degraded` — the storageDomain opened on the real host). The
  live progression was captured by an in-process poller
  (`.scratch/roster-stage-poller.mjs`, 5 ms tick) with the status file
  deleted first: `done (record at 01:02:46.218Z) → tools-registered
  (01:02:46.221Z)`. Earlier stages complete inside one tick (mount is
  sub-10 ms); their ordered writes are pinned by tests/host.spec.js.
* **Served boot graph** (checked on the graph itself, not a page —
  dsh-gitlab 0.1.1 incident). Fetch `/?token=…` following the 303 with
  the cookie; `globalThis["__DSH_BOOT__"]` (release 0.2.2-rc.5, 77
  entries) contains:

  ```
  {"id":"dsh-agent-roster","url":"plugins/??dsh-agent-roster/client.js&rev=6faa0e3796cc",
   "rev":"6faa0e3796cc","inject":[…5 client services…]}
  ```

  The standalone combo `plugins/??dsh-agent-roster/client.js&rev=6faa0e3796cc`
  fetched with the same cookie: **HTTP 200, 88,446 bytes**, starting with
  the `dsh-agent-roster — browser half` banner and containing
  `add-agent-member`. Identical rev + 200 re-verified on the final boot.
  (Note: `GET /plugins/events` is gone in this release — the engram
  runbook's §6 already recorded the boot-graph replacement.)
* **Host stability.** Across all nine boots — including the runs that
  exercised CRUD, spawn, and both drafts — the host job's entire output
  was the one boot-URL line: no stderr, no `dsh: fatal load failure`, no
  crash. Hosts were stopped by exact job id (SIGTERM), never pkill.

### 6. Metadata resources (browser-rejected fallback)

The installed copy under `profiles/agent-roster-test/node_modules/
dsh-agent-roster/` was inspected (HTTP serves only the registered client
combo; the Plugins page reads these files host-side):

* `locale/en.json` / `locale/zh.json`: valid JSON, `meta.title /
  meta.description / meta.detail` present ("Agent roster" /
  "Agent 花名册"); English in sentence case; zh detail → `docs/DETAIL.zh.md`.
* `icon.svg`: 970 bytes, tag-balanced self-contained SVG, `viewBox="0 0
  64 64"` + `width="64" height="64"`, no `<text>`/`<script>`/`<style>`/
  animation/`foreignObject`/remote refs (dsh-doc artwork rules).
* `docs/DETAIL.md` (791 B) and `docs/DETAIL.zh.md` (696 B) present.

### 7. Remote-surface exercise (driver bundle, full mode)

`dsh-roster-driver` (throwaway, `.scratch/roster-driver/`) mounted in the
same host, `ROSTER_DRIVER_MODE=full`, report at
`.scratch/roster-driver/report.json` — **17/17 steps, ~0.6 s**:

* **CRUD round-trip** (settings-card payloads): `listTemplates → []`;
  `saveTemplate` create → record `id ecc52d0540` with timestamps;
  list → 1; patch (`id`+`name`+`prompt` only) → `description` preserved
  (patch semantics); missing prompt → `roster/bad-request` "prompt is
  required / prompt 不能为空"; duplicate name → `roster/name-taken`;
  `deleteTemplate` → `{deleted:true}`; second delete → `roster/not-found`.
* **Team gating**: `teamStatus({sessionId})` →
  `{"teamMode":false,"isRoot":true,"canEnable":true}` before AND after —
  exactly the data behind the modal's team-off banner + one-click enable.
* **Spawn from a template**: `spawnMember({sessionId, templateId,
  memberName:"live-verify-member", task})` →
  `{"name":"live-verify-member","childSessionId":"8b141417-…"}`. The
  child session exists with `origin:"subagent"`,
  `parentSession:"roster-live-verify-…"`, `delegationDepth:1`, subagent
  identity label "Live verify researcher" — a real member on the caller's
  tree (the data the Subagents panel renders). Its one turn ended with
  `llmMs:0` (no credentials), member committed regardless.
* **Model inheritance (ruling 3)**: parent session
  `modelSelection.lastUsed = {provider:"deepseek-official",
  model:"deepseek-flash"}`; spawned child — created with NO model choice —
  records the **identical** `modelSelection.lastUsed`. Default spawn
  inherits the session model.
* **Draft delivery + failure surfacing (ruling 2)**: `draft({sessionId,
  brief})` ×2 each returned `{name:"",description:"",prompt:"",
  parsed:false}` immediately (the modal's parse-failure line — no hang, no
  host error). The draft session `session-12a55867-…` (title pinned
  "Agent roster drafter") shows in its event cache `turnOutline.turns`:
  **two turns, each `prompt:"You are drafting a roster member definition
  from…"`** — the meta-prompt delivered verbatim, twice, into the SAME
  reused per-workspace session (`turnBoundary.lastTurn:2`). Exactly one
  draft session exists in the data files.
* **Restart persistence**: after a full host restart
  (`ROSTER_DRIVER_MODE=list`), `listTemplates` returned the stored
  template `88370f34bf` byte-identical — real storageDomain persistence,
  not the memory fallback (an in-memory store would restart empty).

### 8. Cleanup

Host stopped by exact job id; `curl` confirmed port 17891 refuses
connections; all background jobs accounted for (each host job killed by
id, the poller completed). No `pkill` anywhere. **Kept for inspection**
under `.scratch/`: the `agent-roster-test` profile (with the driver
bundle), `dsh-agent-roster-0.1.0.tgz` at the repo root (gitignored), the
status/poller/driver artifacts, and the session data files cited above.

## What remained unverified (browser-dependent)

No page was rendered or clicked (chrome-cdp rejected). Specifically NOT
live-verified, only resource- or data-verified:

1. **Plugins page rendering** of title / description / icon (zh and en)
   and the detail document — resources verified (step 6), pixels not.
2. **Settings card UI** — its remote calls fully exercised (step 7), the
   card's rendering not.
3. **"+" menu → modal flow** — team banner data, spawn, and draft failure
   surfaces exercised through the same remotes (step 7); the modal's
   rendering, the one-click enable CLICK (`agentTeams.setEnabled` is a
   dsh service, unit-tested in the client suite), and the Subagents
   panel listing not.
4. **Model-backed draft happy path** — deferred to user acceptance with
   real credentials, per the ruling.

## Reproducing

```
export DSH_HOME=<repo>/.scratch/dsh-home
export AGENT_ROSTER_STATUS_FILE=<repo>/.scratch/agent-roster-test-status.json
node /home/ramuz/deepseek-harness/apps/cli/lib/bin.js --profile agent-roster-test --port 17891 --no-open
# driver (optional): install .scratch/roster-driver/dsh-roster-driver-0.0.3.tgz,
# set ROSTER_DRIVER_MODE=full|list, read .scratch/roster-driver/report.json
```
