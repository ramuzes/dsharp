# dsh-engram Live-Host Verification Runbook

Date: 2026-11-21 · bundle `dsh-engram-0.1.0.tgz` · engram v3.7.2 · DSH checkout `/home/ramuz/deepseek-harness`

This is the recorded evidence of Task 10: prove the plugin on a real dsh host
against a real engram daemon, per AGENTS.md §1 ("a background dsh host is part
of the test loop") and §3 (boot-graph pitfalls). Every command below was
actually run; deviations are called out inline.

## Environment deviations (read first)

1. **`DSH_HOME` relocated into the workspace.** The session sandbox mounts
   `~/.dsh` read-only (every write returns `EROFS`), and approval escalation
   was disabled. dsh supports `DSH_HOME` (see
   `apps/cli/lib/types/profile-boot.js` — "`$DSH_HOME` may be set by the test
   or launcher"), so all test state went to
   `.scratch/dsh-home` inside the repo instead of the user's real `~/.dsh`.
   This is strictly more isolated than the original plan; profiles `web` and
   `fgtest` were never touched.
2. **pnpm store redirected.** The dsh `plugin add` command shells out to pnpm,
   whose default store (`~/.local/share/pnpm/store/v11`) is also read-only
   here. pnpm 11 ignores `npm_config_store_dir` from the environment, but it
   reads settings from the profile's `pnpm-workspace.yaml`; appending
   `storeDir: /home/ramuz/skills-workspace/dsharp/.scratch/pnpm-store` to the
   fresh profile's workspace file fixed the install (verified with
   `pnpm store path`).
3. **`headless` is a shipped profile template, not a CLI subcommand** — see
   `dsh --help` examples. A second profile `engram-head` was created from the
   `headless` template for the one-shot session attempt.

## Step-by-step commands and observed evidence

### 1. Pack

```
cd packages/engram
npm pack --pack-destination ../.. --cache ../../.scratch/npm-cache
```

(The `--cache` flag is needed in this sandbox: the default `~/.npm` cache is
read-only.) Result: `dsh-engram-0.1.0.tgz` (30,050 bytes) at the repo root.

### 2. Create the test profile

```
export DSH_HOME=<repo>/.scratch/dsh-home
node <dsh>/apps/cli/lib/bin.js --profile engram-test \
  --from-default-profile web --dump-config
```

Exit 0, composed tree printed, and `profiles/engram-test/` created with
`cordis.yml`, `cordis.patch.yml`, `package.json`, `pnpm-workspace.yaml`.

### 3. Install the bundle

```
node <bin> plugin --profile engram-test add <repo>/dsh-engram-0.1.0.tgz
```

First attempts failed with `EROFS` on the pnpm store symlink (diagnosed via
`profiles/engram-test/.plugin-manager/logs/operation-*/pnpm.log`, not retried
blind — AGENTS.md §3 boot-graph incident). After the `storeDir` fix the
install reported `+ dsh-engram 0.1.0 … done`, `added 1`, and left
`pnpm-workspace.yaml` intact.

### 4. Isolated daemon on the plugin-default port

`curl http://127.0.0.1:7437/health` was checked first: connection refused, so
port 7437 was free and **no user-layer config override was needed** (plugin
default config, zero overrides).

```
ENGRAM_DATA_DIR=<repo>/.scratch/engram-data ENGRAM_PORT=7437 engram run -d
```

`engram ps` (same env): `running (pid 12) on port 7437`; `/health` answered
`{"service":"engram","status":"ok","version":"3.7.2", …}`.

**Deviation:** the daemonized process was reaped when the starting shell
exited (sandbox process cleanup), so the daemon was restarted for the
exercise phase as a managed background job running `engram run` in the
foreground (same env). Same binary, same data dir, same port.

### 5. Boot the test web host

```
ENGRAM_STATUS_FILE=<scratch>/engram-test-status.json \
  node <bin> --profile engram-test --port 17890 --no-open   # managed background job
```

Note: the earlier `… --profile engram-test web --port …` form is wrong —
`web` there is a *profile name* in the help examples, not a subcommand; the
positional is rejected with `too many arguments`. The host printed
`dsh web: http://127.0.0.1:17890/?token=…` and the URL answered HTTP 401
(auth fence) / 200 with the token.

### 6. Host-half evidence

* **Status file** (`ENGRAM_STATUS_FILE`): during boot it showed
  `{"stage":"apply"}` and after boot settled on the terminal success stage
  ```
  {"stage":"tools-registered","detail":{"port":7437,"tokenConfigured":false,
   "autosync":false,"contextInjection":"off"},"at":"2026-11-21T03:23:50.222Z"}
  ```
  The writer keeps only the latest record per mount (by design, `status.js`),
  and the live progression `apply → tools-inject → tools-registered` was
  observed across polls. `port: 7437` proves the wrapped config value was
  read through `readString` (AGENTS.md §3 pitfall 1 did not fire).
* **Boot graph.** `GET /plugins/events` no longer exists — removed in
  v0.2.2-rc.3 (`docs/upgrade-guide/v0.2.2-rc.3/client-hmr-plugin-events-stream/`)
  in favor of the authenticated `pluginEvents/follow` Remote stream.
  Equivalent served-graph check used instead: fetch the app HTML with the
  boot token and inspect `window.__DSH_BOOT__`. The engram entry is present
  with its combo URLs:
  * `plugins/??dsh-engram/client.js&rev=64c4a5869d45` (standalone entry)
  * a shared combo `plugins/??…,engram/client.js,…&rev=0aec038d85fb`
  Fetching the standalone combo returned **HTTP 200, 27,593 bytes** starting
  with the `dsh-engram — browser half` banner. Client half is in the served
  boot graph; no stale-graph condition (dsh-gitlab 0.1.1 incident check).
* **Host stability.** The host job stayed `running` with **zero** stderr
  output — no `dsh: fatal load failure`, no plugin errors, for the whole
  session. (No per-boot log file was written under `$DSH_HOME/logs` in this
  build; job stderr was the fatal-path signal.)

### 7. Session-turn exercise (headless)

```
node <bin> --profile engram-head \
  "Call engram_save … then engram_search … Report both tool results verbatim."
```

**Recorded failure (verbatim):**

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route
"deepseek-official"; store DEEPSEEK_API_KEY through the credentials service
(the web Models page writes it), or export DEEPSEEK_API_KEY in the launching
environment
```

The fresh sandbox profile has no model account, and the session could not
inject credentials. Per the task brief, the engram side was then verified
directly against the isolated daemon, mirroring the exact bodies the plugin
sends (`lib/session-bridge.js`, `lib/agent-tools.js`):

```
POST /sessions  {"id":"dsh-live-verify-1","project":"engram-plugin-verify",
                 "ownership_mode":"project_owned","resume":true}
  -> 201 {"id":"dsh-live-verify-1","status":"created"}
POST /observations {"session_id":"dsh-live-verify-1","title":"live verify",
                 "content":"dsh-engram live verification observation",
                 "project":"engram-plugin-verify","operation_id":"task10-curl"}
  -> 201 {"id":1,"status":"saved"}
GET /search?q=live%20verify&project=engram-plugin-verify
  -> 200 [{"id":1,"title":"live verify",
           "content":"dsh-engram live verification observation",
           "project":"engram-plugin-verify", …}]
```

Save → search round-trip against the real daemon succeeds with the plugin's
payload shapes.

### 8. Daemon-death respawn drill

**Not executed.** The respawn path (`daemon-spawned` stage) is triggered by a
tool call inside an agent session, which step 7 could not open without model
credentials. Unit tests cover the spawn logic; the live drill is an open
manual item (see below).

### 9. Cleanup

Test host and daemon stopped via the background-job system (exact job ids,
no `pkill`); `curl` confirmed both ports refuse connections. The mktemp data
dir was removed. **Kept for inspection:** profile `engram-test` (and
`engram-head`) under `.scratch/dsh-home/profiles/`, and
`dsh-engram-0.1.0.tgz` at the repo root (gitignored — `git check-ignore`
matches, and no `*.tgz` is tracked historically, so it stays untracked).

## Open manual items

1. **Session-turn exercise** (step 7): needs a profile with model
   credentials (`DEEPSEEK_API_KEY` or the web Models page). With a key, the
   exact headless command above should be re-run and both tool results
   recorded verbatim.
2. **Respawn drill** (step 8): with the session working, `engram stop` the
   daemon, issue one more `engram_search`, and confirm the status file
   reports `daemon-spawned` and the search succeeds.
3. **Plugins-page config card**: the client bundle is proven served in the
   boot graph (step 6), but the rendered card was not visually confirmed (no
   browser was driven against the test host in this run).

## Reproducing

```
export DSH_HOME=<repo>/.scratch/dsh-home
export ENGRAM_STATUS_FILE=<repo>/.scratch/sdd/2026-11-21-engram-memory-plugin/engram-test-status.json
node <dsh-checkout>/apps/cli/lib/bin.js --profile engram-test --port 17890 --no-open
ENGRAM_DATA_DIR=$(mktemp -d) ENGRAM_PORT=7437 engram run
```
