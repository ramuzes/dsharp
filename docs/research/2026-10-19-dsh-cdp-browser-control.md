# DSH operating the user's real Chrome over CDP — research report

Date: 2026-10-19. Research subjects: Chromium/Chrome remote-debugging constraints (Chromium source, Gerrit, official blogs), Kimi WebBridge (now renamed Kimi Browser Extension) official docs and its open-source skill, Playwright/Puppeteer attach official docs, and the DSH plugin & tooling system (checkout `/home/ramuz/deepseek-harness/`). Every key conclusion cites a primary source; [TESTED] marks what was verified empirically inside this session's confined executor, [INFERRED] marks inference.

---

## 0. Overall conclusion

**Feasible — and DSH already has most of the infrastructure.** "The agent operates the Chrome the user is actually using" splits into three legitimate paths by *which browser instance you attach to*, mapped to three DSH tiers:

1. **Zero changes, usable immediately (port route)**: after Chrome is started with `--remote-debugging-port=9222 --user-data-dir=<non-default directory>`, mount the in-tree `dsh-browser-use` + `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp` in the profile, configured with `mode: attach` + `endpoint`. The agent then gets the `mcp__chrome-devtools-mcp__*` tool family and operates that browser directly (login state included). Limitation: since Chrome 136 the default profile refuses the debug switches, so this route **can never touch the user's default profile**.
2. **Zero changes, targeting the default profile (Chrome 144+ approval mode)**: after the user enables approval mode at `chrome://inspect#remote-debugging`, mount the official `chrome-devtools-mcp --auto-connect` directly via a `dsh-mcp-client` YAML entry (DSH's pinned dependency chrome-devtools-mcp@1.9.0 already supports this flag — [TESTED], see §3.2). This is the officially supported route for "attaching to the running default-profile Chrome": each connection triggers Chrome's own approval dialog plus a persistent banner. The browser-use provider does not currently pass through `--auto-connect` (a few lines of change; option C in §4).
3. **New plugin (a new bundle in this repo, dsharp)**: deliver the full Kimi-WebBridge-style experience — connection management (auto-discovering DevToolsActivePort), **per-action human approval** (`tools/pre-execute` → `{kind:'ask'}` → Web GUI Allow/Deny card), screenshots through the attachment pipeline, and a Plugins-page config card. Every mechanism needed (tools.register, approval service, storageDomain, client half, containment conventions) already exists; the plugin "assembles" rather than "invents".

One additional practical route: **call the Kimi WebBridge local daemon directly** (§2.5). Its agent side is just `POST http://127.0.0.1:10086/command`, and it is officially positioned as "supporting all Local Agents"; DSH could call it today via run_code/bash with zero changes, or a thin plugin could wrap it into proper tools. The cost is a dependency on its proprietary (closed-source) binaries.

Key external facts (details in §2): **a running default-profile Chrome started without debugging cannot be attached at all before Chrome 144** (no post-launch enablement existed); from 144 on there is an official approval mode; the debug port itself is unauthenticated — any local process can connect and gain full control of all pages and logged-in sessions.

---

## 1. Requirements and evaluation criteria

The user's ask: the agent in DSH must operate the **Chrome instance the user uses daily** (with logged-in sessions), in the manner of Kimi WebBridge (browser-side human authorization) or a Playwright attach. Evaluation dimensions:

- Attach target: the running default-profile browser, or is a restart / separate profile acceptable?
- Human authorization: connect-level (one-shot) or per-action?
- DSH-side cost: zero changes (profile/YAML config) vs. a new plugin bundle.

## 2. External facts (primary sources)

### 2.1 Landscape of paths for attaching to "the Chrome in use"

| Route | Can attach to a running default-profile browser? | Human approval | Preconditions |
|---|---|---|---|
| Extension + local daemon (chrome.debugger, the Kimi WebBridge model) | **Yes** (the extension executes CDP inside the browser, unaffected by the 136 restriction) | Connect-level (click Connect inside the extension) + Chrome's per-debugged-tab infobar (manually dismissible) | Install extension + daemon |
| Chrome ≥144 approval mode (`chrome://inspect#remote-debugging`) | **Yes** (default profile, running instance; per-connection dialog + persistent "controlled by automated test software" banner) | Chrome-native per-connection approval | Chrome ≥144 + one-time enablement by the user; client reads `DevToolsActivePort` from the profile directory |
| Debug port + non-default `--user-data-dir` | No (a different profile; requires restart with flags) | None | Since Chrome 136 a non-default user-data-dir is **mandatory** |
| `--remote-debugging-pipe` | No (fds 3/4 inherited only at child-process launch) | None | Launch scenarios only |
| Playwright/Puppeteer fresh profile | No (not the user's browser) | — | Safest, but fails the requirement |

### 2.2 The two key Chrome 136 / 144 changes

- **136 refuses the debug switches on the default profile**: official blog (https://developer.chrome.com/blog/remote-debugging-port): "from Chrome 136 … `--remote-debugging-port` and `--remote-debugging-pipe` … will no longer be respected if attempting to debug the default Chrome data directory. These switches must now be accompanied by the `--user-data-dir` switch". The motivation was infostealer attackers using the remote-debugging port to extract cookies. Gerrit CL 6311292 (MERGED); current source `chrome/browser/devtools/remote_debugging_server.cc` shows the check is enforced only for Google Chrome branded builds (`GOOGLE_CHROME_BRANCHING` macro); unbranded Chromium builds do not block it.
- **144 adds the official approval mode**: same source file: "remote debugging is enabled via chrome://inspect … the debugging server [starts] in the approval mode in which each incoming connection needs to be approved by the user"; the port is discovered from the `DevToolsActivePort` file in the default profile directory (port + browser-target WS path; `content/browser/devtools/devtools_http_handler.cc` comment: "Write this port to a well-known file in the profile directory"). Official announcement: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session (2025-12-11). Old behavior: the debug server was created only at launch per the switches — **before 144, an instance started without a debug flag could not be attached after the fact**.
- **The port is unauthenticated**: the DevTools HTTP handler's own traffic annotation calls the data "can be sent to any destination"; it binds loopback and the Host header must be an IP literal or localhost (DNS names rejected, defending against DNS rebinding; the WS side since 2018, the HTTP side per current source `RequestIsSafeToServe`, both validated). But this offers **no defense against local processes** — any local process that connects gains full control of all pages and login state. This is the root cause of the 136 tightening and the reason this project must ship an approval gate.

### 2.3 Playwright / Puppeteer attach fidelity

- Playwright `browserType.connectOverCDP` (https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp): accepts `http://localhost:9222/` or `ws://127.0.0.1:9222/devtools/browser/<guid>`; official warning: "This connection is significantly lower fidelity than the Playwright protocol connection via browserType.connect()", and a browser not launched by Playwright may break some features (mitigations: `noDefaults` (1.60, "Useful when attaching to a user's daily-driver browser"), `isLocal` (1.58), `artifactsDir` (1.61)). Chromium-family browsers only.
- Puppeteer `puppeteer.connect`: `browserURL` goes through `GET /json/version` to read `webSocketDebuggerUrl`; the experimental `channel` option reads `DevToolsActivePort` from the default user data dir directly — Puppeteer's client-side support for the 144+ approval mode (chrome-devtools-mcp uses exactly this mechanism internally, [TESTED] see §3.2).

### 2.4 Kimi WebBridge (now Kimi Browser Extension) architecture dissected

- Composition (https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-how-it-works): a **local Bridge Service** (daemon, listening on `127.0.0.1:10086` by default) + a **browser extension** (executes actions via the Chrome DevTools Protocol). One-sentence product-page summary: "The Agent sends commands to the local service, which uses Chrome DevTools Protocol to navigate, click, screenshot, and read pages in your existing Chrome or Edge browser … Everything runs locally" (https://www.kimi.ai/products/kimi-browser-extension).
- Connection directions: agent → HTTP (`POST http://127.0.0.1:10086/command`, official skill doc at https://github.com/MoonshotAI/kimi-code `plugins/official/kimi-webbridge/skills/kimi-webbridge/SKILL.md`); extension → WS dials back to the daemon (`ws://127.0.0.1:10086/ws`, FAQ). **The browser opens no debug port**; the CDP executor is the extension's `chrome.debugger` API (Chromium source `chrome/common/extensions/api/debugger.json`: "serves as an alternate transport for Chrome's remote debugging protocol"); attached tabs show Chrome's own infobar, which the user can dismiss (`DetachReason.canceled_by_user`).
- **Authorization granularity is "connect-level", not per-action approval**: the official docs only describe a manual Connect inside the extension, session tab-group isolation (by default it only touches tabs opened by this session; `active:true` explicitly "borrows" the user's current tab and returns `borrowed:true`), "The Agent can only access the operation results you authorize", and the *usage guidance* to confirm before sensitive operations. No step-by-step in-browser approval UI is documented anywhere (an UNVERIFIED item — no official page describes one).
- Capabilities (SKILL.md tool table): navigate / find_tab / snapshot (accessibility tree + @e refs) / click / fill (including contenteditable) / evaluate / **cdp (raw chrome.debugger passthrough)** / screenshot / network capture / upload / save_as_pdf, etc. Known limitation: sites that strictly check `event.isTrusted` (some banks, captchas) ignore synthetic clicks/input; officially requires macOS or Windows (Linux paths exist in operations.md, but the requirements table omits Linux).
- Open-source status: the kimi-code CLI (MIT) and the skill docs inside it are open; the **daemon binary and the extension are closed-source** (the skill is marked "license": "Proprietary" in kimi.plugin.json). Officially positioned as "supports all Local Agents, including Claude Code, Codex, Cursor, Kimi Code…" — i.e. any agent that can issue local HTTP (DSH included) can be its client.

## 3. DSH current state (source-level; paths relative to `/home/ramuz/deepseek-harness/`)

### 3.1 The browser-use subsystem already exists in-tree (attach mode included)

- Registry: `dsh-browser-use` holds one exclusive provider slot (`ctx.browserUse.register(name)`, `docs/subsystems/browser-use.md`).
- `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp` (a 43-line provider, `packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts:26-43`): spawns the pinned dependency `chrome-devtools-mcp@1.9.0` (package.json:33); in attach mode it appends `--ws-endpoint` or `--browser-url` per the endpoint shape (README: "Use `mode: attach` and set `endpoint` … to operate an existing browser … Cleanup disconnects and leaves the external browser and its pages running").
- Semantics (README, spot-checked by the Lead): each live Session **exclusively** claims the connection during initialization; direct calls from other Sessions fail; loading/reloading the provider does not adopt already-active Sessions; do not explicitly list browser tool names in `toolOrder` (otherwise prompt assembly fails for Sessions without a browser connection); screenshots require an attachment store + an image-capable model route; Chromium-family only.
- Structural references: `browser-use-playwright-mcp` (`@playwright/mcp@0.0.80`, attach passes `--cdp-endpoint`), `browser-use-stagehand-native` (in-process).

### 3.2 The zero-code path and the state of --auto-connect

- A `dsh-mcp-client` YAML entry can mount any MCP server; its tools enter the same registry as `mcp__<server>__<tool>` (`packages/mcp/mcp-client/src/tools.ts:81-87`). So **today you can**: `command: npx`, `args: [chrome-devtools-mcp, --auto-connect]` to reach the default-profile browser under Chrome 144+ approval mode directly.
- [TESTED] DSH's pinned `chrome-devtools-mcp@1.9.0` already implements `--auto-connect` (`node_modules/.pnpm/chrome-devtools-mcp@1.9.0/…/config/browser-options.js`: "automatically connects to a browser (Chrome 144+) running locally from the user data directory identified by the channel param (default channel is stable). Requires the remote debugging server to be started … via chrome://inspect/#remote-debugging"; `browser.js` internally reads `DevToolsActivePort` and connects through Puppeteer).
- Gap: the browser-use provider's Config only has `mode/headless/executablePath/endpoint/toolCallTimeoutMs` and **does not pass through `--auto-connect`** — adding one passthrough field would let the provider route reach approval mode too (a few lines, belonging to DSH upstream rather than this repo).

### 3.3 run_code can already speak CDP today (tested)

- The sandbox is **file-effect only**; network is outside the governance vocabulary (`packages/sandbox/sandbox/src/index.ts:24-30`: "Network and process visibility are outside this vocabulary"; the bwrap profile has no `--unshare-net`, `packages/sandbox/sandbox-local/src/profiles.ts:16-23`).
- [TESTED] inside this session's workspace-write executor: `fetch('http://127.0.0.1:3080/')` got an answer; raw TCP connect OK; `typeof WebSocket === 'function'` (Node 25 ships a built-in WS client) — a zero-dependency CDP client against `ws://127.0.0.1:9222` is writable today. Caveats: run_code runs a fresh child process each call, with an empty env, default 120s / capped 600s (`packages/ptc-runtime/ptc-runtime-node/src/config.ts:33-34`); importing playwright/ws/chrome-devtools-mcp by name all fail (resolution starts from the ptc-runtime location) — only the built-in WebSocket or absolute-path imports work [TESTED].
- Conclusion: with nothing installed, the agent can already "hand-roll" driving a debug-ported Chrome; but with no connection reuse, no approval gate, and a reconnect every call, the experience is poor — fit only as an emergency/verification tool.

### 3.4 The human-approval seam (per-action approval mechanism already exists)

- A `tools/pre-execute` waterfall listener can return `{kind:'ask'}`: `PreToolDecision` (`packages/core/tools/src/index.ts:599-612`, "ask runs only after an approval service returns `allowed-once` and otherwise denies"); the registry then goes through `ctx.approval.request({agent, toolName, callId, …})` (index.ts:1517-1518, 1735-1776); with no approval service it fails closed and denies.
- The Web GUI's `ui-approval` **attaches the Allow/Deny card to the already-streamed tool call** (via `callId`, `docs/subsystems/approval.md`); `ApprovalOutcome` is closed (`allowed-once | rejected | cancelled | unavailable`), and every ask/decided lands in audit events. Precedents: every `plugin_manager` action goes through this gate (`packages/boot/plugin-manager/README.md:31`); feishu-gateway routes approvals to Feishu cards via `ctx.on('approval/request')` (`lib/answerer.js:61`).
- Implication: **DSH can do Kimi WebBridge's "human approval" one better** — not connect-level, but per sensitive action (navigate/click/submit) Allow/Deny in the GUI. On the browser side, the M144 approval mode adds another layer of Chrome's own per-connection dialog.

### 3.5 The plugin assembly surface (every part a new bundle needs)

- Registering tools: `ctx.tools.register(defineTool({...}))`; minimal example `packages/experimental/tool-worktree/src/index.ts` (43 lines).
- Bundle shape: package.json `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` + Loader rows; copy the template from this repo's `packages/workspace-env` (host-only) or `packages/airboard` (with client half); zero-build plain JS with only dsh peer packages as dependencies is the established convention (README "Adding a new plugin").
- Config: schemastery `Config`, `.volatile()` fields live-edit and persist (fits frequently-changing endpoints); persistence: `ctx.storageDomain.open(domain)` + zod `domainTable` (feishu precedent, index.js:52-78); Web GUI: the `dsh.client` half registers a Plugins-page config card.
- Long-lived connections/child processes: feishu-gateway's WSS long connection + `ctx.effect` disposer, and browser-use runtime's per-Session MCP child processes are both precedents; containment (`safely()` wrapping every callback, preventing dangling rejections from killing the host), per-profile state files, and the live background-host verification loop are all mandatory per this repo's AGENTS.md.

## 4. Option comparison and recommendation

| Option | Attaches to the in-use default profile | Approval granularity | DSH-side cost | Fit |
|---|---|---|---|---|
| A. browser-use provider `attach` (debug port + separate profile) | ✗ (separate profile) | None | Zero (profile config) | Acceptable for dedicated-profile automation |
| B. mcp-client direct mount of `chrome-devtools-mcp --auto-connect` | ✓ (Chrome ≥144) | Chrome per-connection dialog + banner | Zero (YAML) | **Fastest way to the real browser** |
| C. New dsharp plugin (chrome-cdp bundle): auto-connect passthrough or native CDP tools + pre-execute approval gate + attachment screenshots | ✓ (same connection as B) | Chrome per-connection + **DSH GUI per-action** | One new bundle | Target form |
| D. Thin plugin / direct call to the Kimi WebBridge daemon | ✓ (after installing extension + daemon, any Chrome version) | Connect-level (inside the extension) | Zero to thin | When a closed-source daemon is acceptable |
| E. run_code hand-written CDP WebSocket | Same connection preconditions as A/B | None | Zero | Emergency/verification |

**Recommended path: B first, then C.** B lets the user drive "the Chrome in use" inside DSH right now (the only actions: enable `chrome://inspect#remote-debugging` on Chrome ≥144 and add one mcp-client entry to the profile YAML; or, once upstream adds `--auto-connect` passthrough to the provider, use A's config surface). C is the new dsharp bundle, assembled per §3.5, completing per-action approval, connection health checks (reading DevToolsActivePort), and screenshot delivery; to also cover Chrome <144 or users unwilling to enable approval mode, add D (WebBridge daemon integration) as a provider option later.

## 5. Risks and known limitations

- **The port is unauthenticated**: any local process can connect to the debug port and gain control of all pages/login state; the DSH sandbox explicitly does not govern network. The plugin must default to the approval gate and must state this risk in its docs.
- **Chrome 136 hard constraint**: default profile + debug switches are always refused (Google branded builds only); never promise "restart Chrome with the port flag and the default profile works".
- Fidelity: Playwright officially describes attach connections as "significantly lower fidelity"; chrome.debugger synthetic events fail on `isTrusted`-strict sites (Kimi's docs list the same limit).
- DSH side: the browser connection is exclusive per Session (a second Session gets nothing); screenshots need an attachment store + an image model route; do not list browser tool names in `toolOrder`; provider reload does not adopt already-active Sessions.
- Implementation must follow this repo's AGENTS.md: live background-host verification loop, strict fakes, containment, per-profile state, and dsh source paths cited in code comments.

## 6. Next steps (if C is chosen for implementation)

1. Add `--auto-connect` passthrough to browser-use-chrome-devtools-mcp upstream (or as a thin provider in this repo) — the minimal-change route;
2. Create `packages/chrome-cdp` in dsharp: Config (mode/endpoint/autoConnect/approval-policy volatile fields), the `tools/pre-execute` sensitive-action approval gate, DevToolsActivePort probing and status card, screenshots through the attachment pipeline;
3. Complete unit tests (strict fakes) + live-host verification per the AGENTS.md checklist (host stability, approval round-trips, disconnect recovery);
4. Documentation: user steps to enable Chrome ≥144 approval mode, security notes.
---

## 7. B-spike experiment record (2026-10-19, zero-change path verified live)

**Environment**: a WSL2 (NAT mode) host; the browser was a local chromium 129 (a Playwright-cache build, <144, hence the port-attach route); model glm-5.3 (zai-coding-cn, key taken from `~/.dsh/.env`).

**Assembly** (all inside the workspace at `.scratch/dsh-btest/`, never touching the real `~/.dsh`): `DSH_HOME` overridden to the test directory; profile `headless` = `dsh-base` + `dsh-headless` (one-shot agent); the patch layer inserts a `dsh-mcp-client` row (stdio mounting `chrome-devtools-mcp@1.9.0 --browser-url http://127.0.0.1:9223`). The browser was started with `--headless=new --remote-debugging-port=9223 --user-data-dir=<non-default>`.

**Result: end-to-end success.** In the one-shot task "use the chrome-cdp tools to open example.com and report the h1 and the tab count", the agent genuinely performed navigate, `evaluate` (querySelectorAll('h1')), an accessibility snapshot, and tab enumeration via the `mcp__chrome-cdp__*` tools; the answer matched the browser's actual state exactly (the new example.com has no h1; 2 tabs); the process exited cleanly (exit 0). The DSH-side capabilities (MCP mounting, tool catalog injection, PTC dispatch, failure retry, degradation) all worked as designed.

**Practical pitfalls (not previously documented)**:
1. Loader dialect: new rows in a profile patch must use the `- insert:` list; a top-level `- id:` can only override an existing row (base bundles already provide default rows like llm-pi-ai, which is why those can be overridden directly).
2. **The chrome-devtools-mcp@1.9.0 package.json has two bins**: `chrome-devtools-mcp` (`build/src/bin/chrome-devtools-mcp.js`, the MCP server entry) and `chrome-devtools` (`build/src/bin/chrome-devtools.js`, the CLI/daemon control tool — run without arguments it errors with "Not enough non-option arguments" and exits). Mounting MCP must use the former — the DSH in-tree provider imports exactly that one (`packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts:31`).
3. The run_code/bash sandbox gives each call a private /tmp; cross-call state must live in the workspace.

**Generalizing to the user's real Chrome (≥144, default profile)**: in the same config row, replace `--browser-url http://127.0.0.1:9223` with `--auto-connect` (the user first enables approval mode at `chrome://inspect#remote-debugging`; each connection triggers Chrome's authorization dialog plus the control banner). WSL2 NAT caveat: a Windows-side Chrome listens on 127.0.0.1, unreachable from inside WSL — you need mirrored networking, a Windows-side netsh portproxy, or rebinding the browser with `--remote-debugging-address`.
