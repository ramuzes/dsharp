# DSH 通过 CDP 操作用户正在使用的 Chrome — 调研报告

日期：2026-10-19。调研对象：Chromium/Chrome 远程调试约束(Chromium 源码、Gerrit、官方博客)、Kimi WebBridge(现更名 Kimi Browser Extension)官方文档与开源 skill、Playwright/Puppeteer attach 官方文档、DSH 插件与工具体系(checkout `/home/ramuz/deepseek-harness/`)。所有关键结论均标注一手出处;[TESTED] 为本会话受限执行器内实测,[INFERRED] 为推断。

---

## 0. 总结论

**可行,且大部分基础设施 DSH 已经具备。** 「agent 操作用户正在使用的 Chrome」按"附加到哪个浏览器实例"分三条正路,对应 DSH 三档做法:

1. **零改动,立即可用(端口路线)**:Chrome 以 `--remote-debugging-port=9222 --user-data-dir=<非默认目录>` 启动后,在 profile 挂载树内已有的 `dsh-browser-use` + `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp`,配置 `mode: attach` + `endpoint`。agent 即获得 `mcp__chrome-devtools-mcp__*` 系列工具,直接操作该浏览器(含登录态)。限制:Chrome 136 起默认 profile 拒绝调试开关,所以这条路线**碰不到用户默认 profile**。
2. **零改动,面向默认 profile(Chrome 144+ 审批模式)**:用户在 `chrome://inspect#remote-debugging` 开启审批模式后,用 `dsh-mcp-client` YAML 直挂官方 `chrome-devtools-mcp --auto-connect`(DSH 固定依赖 chrome-devtools-mcp@1.9.0 已支持该旗标,[TESTED] 见 §3.2)。这是官方支持的"附加到正在运行的默认 profile Chrome"路线:每次连接 Chrome 自己弹窗审批并常驻横幅。browser-use provider 目前不透传 `--auto-connect`(需几行改动,§4 方案 C)。
3. **新增插件(本仓库 dsharp 新 bundle)**:做 Kimi WebBridge 式的完整体验——连接管理(自动发现 DevToolsActivePort)、**逐操作人工审批**(`tools/pre-execute` → `{kind:'ask'}` → Web GUI Allow/Deny 卡片)、截图走附件管线、Plugins 页配置卡。所需机制(tools.register、approval service、storageDomain、client 半边、containment 约定)全部存在,插件是"组装"而非"发明"。

另一条实用路线:**直接调用 Kimi WebBridge 的本地 daemon**(§2.5)。它的 agent 侧就是 `POST http://127.0.0.1:10086/command`,官方定位"支持所有 Local Agent";DSH 侧可零改动用 run_code/bash 调用,或写薄插件包装成正式工具。代价是依赖其专有二进制(闭源)。

外部侧关键事实(详见 §2):**正在运行、未开调试的默认 profile Chrome,在 Chrome 144 之前无法被附加**(无启动后开启机制);144 起有官方审批模式;调试端口本身无鉴权,本机任意进程可连接并获得全部页面与登录态控制权。

---

## 1. 需求与判定

用户诉求:DSH 里的 agent 能操作**用户日常使用的 Chrome 实例**(带已登录会话),参考 Kimi WebBridge(浏览器侧人工授权)或 Playwright attach。判定维度:

- 附加对象:正在运行的默认 profile 浏览器,还是可接受重启/独立 profile?
- 人工授权:连接级(一次性)还是逐操作级?
- DSH 侧成本:零改动(profile/YAML 配置)vs 新插件 bundle。

## 2. 外部事实(一手出处)

### 2.1 附加到「正在使用的 Chrome」的路径全景

| 路线 | 能否附加正在运行的默认 profile | 人工审批 | 前提 |
|---|---|---|---|
| 扩展 + 本地 daemon(chrome.debugger,Kimi WebBridge 模式) | **能**(扩展在浏览器内部执行 CDP,不受 136 限制) | 连接级(扩展内点击 Connect)+ Chrome 每个被调试标签的 infobar(可手动取消) | 装扩展 + daemon |
| Chrome ≥144 审批模式(`chrome://inspect#remote-debugging`) | **能**(默认 profile、运行中实例;每次连接弹窗 + 常驻"受自动化测试软件控制"横幅) | Chrome 原生逐连接审批 | Chrome ≥144 + 用户一次性开启;客户端读 profile 目录下 `DevToolsActivePort` |
| 调试端口 + 非默认 `--user-data-dir` | 不能(另一个 profile,须带旗标重启) | 无 | Chrome 136 起**必须**非默认 user-data-dir |
| `--remote-debugging-pipe` | 不能(仅子进程启动时继承 fd 3/4) | 无 | 仅 launch 场景 |
| Playwright/Puppeteer 全新 profile | 不能(非用户浏览器) | — | 最安全但不符合诉求 |

### 2.2 Chrome 136 / 144 的两个关键变化

- **136 起拒绝默认 profile 调试开关**:官方博客(https://developer.chrome.com/blog/remote-debugging-port ):"from Chrome 136 … `--remote-debugging-port` and `--remote-debugging-pipe` … will no longer be respected if attempting to debug the default Chrome data directory. These switches must now be accompanied by the `--user-data-dir` switch"。动因是窃密攻击者用远程调试端口提取 cookie。Gerrit CL 6311292(MERGED);现行源码 `chrome/browser/devtools/remote_debugging_server.cc` 显示仅 Google Chrome 品牌构建强制(`GOOGLE_CHROME_BRANCHING` 宏),Chromium 非品牌构建不拦。
- **144 起官方审批模式**:源码同文件:"remote debugging is enabled via chrome://inspect … the debugging server [starts] in the approval mode in which each incoming connection needs to be approved by the user";端口从默认 profile 目录的 `DevToolsActivePort` 文件发现(端口 + browser target WS 路径,`content/browser/devtools/devtools_http_handler.cc` 注释:"Write this port to a well-known file in the profile directory")。官方公告:https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session (2025-12-11)。旧行为:调试服务器只在启动时按开关创建——**144 之前,未带调试旗标启动的实例无法事后附加**。
- **端口无鉴权**:DevTools HTTP handler 的流量注释自称数据"can be sent to any destination";绑定 loopback 且 Host 头必须是 IP 字面量或 localhost(拒绝 DNS 名,防 DNS rebinding;WS 侧 2018 年起,HTTP 侧现行源码 `RequestIsSafeToServe` 均校验)。但这对**本机进程**没有任何防御——本机任意进程连上即得全部页面与登录态控制权。这是 136 收紧的根因,也是本方案必须配审批门的理由。

### 2.3 Playwright / Puppeteer attach 的保真度

- Playwright `browserType.connectOverCDP`(https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp ):接受 `http://localhost:9222/` 或 `ws://127.0.0.1:9222/devtools/browser/<guid>`;官方警告 "This connection is significantly lower fidelity than the Playwright protocol connection via browserType.connect()",且非 Playwright 启动的浏览器可能破坏部分功能(缓解:`noDefaults`(1.60,"Useful when attaching to a user's daily-driver browser")、`isLocal`(1.58)、`artifactsDir`(1.61))。仅支持 Chromium 系。
- Puppeteer `puppeteer.connect`:`browserURL` 走 `GET /json/version` 取 `webSocketDebuggerUrl`;实验性 `channel` 选项直接读默认 user data dir 的 `DevToolsActivePort` 连接——即 Puppeteer 对 144+ 审批模式的客户端支持(chrome-devtools-mcp 内部即用此机制,[TESTED] 见 §3.2)。

### 2.4 Kimi WebBridge(现名 Kimi Browser Extension)架构拆解

- 组成(https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-how-it-works ):**本地 Bridge Service**(daemon,默认监听 `127.0.0.1:10086`)+ **浏览器扩展**(用 Chrome DevTools Protocol 执行动作)。产品页一句话:"The Agent sends commands to the local service, which uses Chrome DevTools Protocol to navigate, click, screenshot, and read pages in your existing Chrome or Edge browser … Everything runs locally"(https://www.kimi.ai/products/kimi-browser-extension )。
- 连接方向:agent → HTTP(`POST http://127.0.0.1:10086/command`,官方 skill 文档 https://github.com/MoonshotAI/kimi-code `plugins/official/kimi-webbridge/skills/kimi-webbridge/SKILL.md`);扩展 → WS 反向连 daemon(`ws://127.0.0.1:10086/ws`,FAQ)。**浏览器不开调试端口**;CDP 执行体是扩展内的 `chrome.debugger` API(Chromium 源码 `chrome/common/extensions/api/debugger.json`:"serves as an alternate transport for Chrome's remote debugging protocol"),附着的标签会显示 Chrome 自己的 infobar,用户可取消(`DetachReason.canceled_by_user`)。
- **授权粒度是"连接级"而非逐步审批**:官方文档只记载 扩展内手动 Connect、session 标签组隔离(默认只动本 session 开的标签,`active:true` 显式"借用"用户当前标签才返回 `borrowed:true`)、"Agent 只能访问你授权的操作结果"、敏感操作前确认的**使用建议**。未记载任何逐步浏览器内审批 UI(UNVERIFIED 项,官方页面无此描述)。
- 能力(SKILL.md 工具表):navigate / find_tab / snapshot(无障碍树 + @e 引用)/ click / fill(含 contenteditable)/ evaluate / **cdp(chrome.debugger 原始透传)** / screenshot / network 抓包 / upload / save_as_pdf 等。已知限制:严格校验 `event.isTrusted` 的站点(部分银行、验证码)会忽略合成点击/输入;官方要求 macOS 或 Windows(Linux 路径存在于 operations.md,但要求表未列 Linux)。
- 开源状态:kimi-code CLI(MIT)与其中的 skill 文档开源;**daemon 二进制与扩展闭源**(skill 在 kimi.plugin.json 标 "license": "Proprietary")。官方定位"supports all Local Agents, including Claude Code, Codex, Cursor, Kimi Code…"——即任何能发本地 HTTP 的 agent(含 DSH)都能当它的客户端。

## 3. DSH 现状(源码级;路径相对 `/home/ramuz/deepseek-harness/`)

### 3.1 树内已有 browser-use 子系统(attach 模式存在)

- 注册表:`dsh-browser-use` 独占 provider 槽(`ctx.browserUse.register(name)`,`docs/subsystems/browser-use.md`)。
- `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp`(43 行 provider,`packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts:26-43`):spawn 固定依赖 `chrome-devtools-mcp@1.9.0`(package.json:33);attach 模式按 endpoint 形态追加 `--ws-endpoint` 或 `--browser-url`(README:"Use `mode: attach` and set `endpoint` … to operate an existing browser … Cleanup disconnects and leaves the external browser and its pages running")。
- 语义(README,Lead 已抽查原文):每个活跃 Session 初始化时**独占**该连接,别的 Session 直连报错;加载/重载 provider 不收养已激活的 Session;`toolOrder` 不要显式列浏览器工具名(否则无浏览器连接的 Session 组装 prompt 会失败);截图需要附件存储 + 图像能力模型路由;仅 Chromium 系。
- 同构参考:`browser-use-playwright-mcp`(`@playwright/mcp@0.0.80`,attach 传 `--cdp-endpoint`)、`browser-use-stagehand-native`(进程内)。

### 3.2 零代码路径与 --auto-connect 现状

- `dsh-mcp-client` YAML 可挂任意 MCP server,工具以 `mcp__<server>__<tool>` 进入同一注册表(`packages/mcp/mcp-client/src/tools.ts:81-87`)。因此**今天就能**:`command: npx`,`args: [chrome-devtools-mcp, --auto-connect]` 直连 Chrome 144+ 审批模式的默认 profile 浏览器。
- [TESTED] DSH 固定的 `chrome-devtools-mcp@1.9.0` 已实现 `--auto-connect`(`node_modules/.pnpm/chrome-devtools-mcp@1.9.0/…/config/browser-options.js`:"automatically connects to a browser (Chrome 144+) running locally from the user data directory identified by the channel param (default channel is stable). Requires the remote debugging server to be started … via chrome://inspect/#remote-debugging";`browser.js` 内部读 `DevToolsActivePort` 经 Puppeteer 连接)。
- 缺口:browser-use provider 的 Config 只有 `mode/headless/executablePath/endpoint/toolCallTimeoutMs`,**不透传 `--auto-connect`**——补一个透传字段即可让 provider 路线也吃到审批模式(几行改动,属 DSH 上游而非本仓库)。

### 3.3 run_code 今天就能写 CDP(实测)

- 沙箱是**纯文件效果**,网络不在治理词汇表内(`packages/sandbox/sandbox/src/index.ts:24-30`:"Network and process visibility are outside this vocabulary";bwrap profile 无 `--unshare-net`,`packages/sandbox/sandbox-local/src/profiles.ts:16-23`)。
- [TESTED] 本会话 workspace-write 执行器内:`fetch('http://127.0.0.1:3080/')` 得到应答;裸 TCP connect OK;`typeof WebSocket === 'function'`(Node 25 内建 WS 客户端)——零依赖 CDP 客户端今天就能对 `ws://127.0.0.1:9222` 编程。注意:run_code 每次全新子进程、env 为空、默认 120s/上限 600s(`packages/ptc-runtime/ptc-runtime-node/src/config.ts:33-34`);按名 import playwright/ws/chrome-devtools-mcp 均失败(解析自 ptc-runtime 位置),只可用内建 WebSocket 或绝对路径 import [TESTED]。
- 结论:不装任何东西,agent 已能"手工"驱动带调试端口的 Chrome;但无连接复用、无审批门、每次重连,体验差——只宜当应急/验证手段。

### 3.4 人工审批 seam(逐操作审批的机制已存在)

- `tools/pre-execute` waterfall 可返回 `{kind:'ask'}`:`PreToolDecision`(`packages/core/tools/src/index.ts:599-612`,"ask runs only after an approval service returns `allowed-once` and otherwise denies");注册表走 `ctx.approval.request({agent, toolName, callId, …})`(index.ts:1517-1518, 1735-1776),无审批服务则 fail-closed 拒绝。
- Web GUI 的 `ui-approval` 把 Allow/Deny 卡片**附着在已流式呈现的工具调用上**(经 `callId`,`docs/subsystems/approval.md`);`ApprovalOutcome` 闭合(`allowed-once | rejected | cancelled | unavailable`),每次 ask/decided 落审计事件。先例:`plugin_manager` 的每个动作都走该门(`packages/boot/plugin-manager/README.md:31`);feishu-gateway 用 `ctx.on('approval/request')` 把审批路由到飞书卡片(`lib/answerer.js:61`)。
- 含义:**Kimi WebBridge 的"人工审批"在 DSH 里可以做得更强**——不是连接级,而是逐次敏感操作(navigate/click/submit)在 GUI 里 Allow/Deny。浏览器侧 M144 审批模式则再叠加一层 Chrome 自己的逐连接弹窗。

### 3.5 插件组装面(新 bundle 所需的全部件)

- 注册工具:`ctx.tools.register(defineTool({...}))`;最小样例 `packages/experimental/tool-worktree/src/index.ts`(43 行)。
- bundle 形态:package.json `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` + Loader 行;模板抄本仓库 `packages/workspace-env`(纯 host)或 `packages/airboard`(带 client 半边);零构建纯 JS、依赖只留 dsh peer 包是既定约定(README「Adding a new plugin」)。
- 配置:schemastery `Config`,`.volatile()` 字段热改生效并持久(endpoint 频繁变动的场景适用);持久化:`ctx.storageDomain.open(domain)` + zod `domainTable`(feishu 先例,index.js:52-78);Web GUI:`dsh.client` 半边注册 Plugins 页配置卡。
- 长驻连接/子进程:feishu-gateway 的 WSS 长连接 + `ctx.effect` disposer、browser-use runtime 的每 Session MCP 子进程均为先例;containment(`safely()` 包裹一切回调、防 dangling rejection 杀死宿主)、per-profile 状态文件、真机后台 host 验证循环,均为本仓库 AGENTS.md 强制要求。

## 4. 方案对比与推荐

| 方案 | 附加到正在使用的默认 profile | 审批粒度 | DSH 侧成本 | 适用 |
|---|---|---|---|---|
| A. browser-use provider `attach`(调试端口 + 独立 profile) | ✗(独立 profile) | 无 | 零(profile 配置) | 可接受专用 profile 自动化 |
| B. mcp-client 直挂 `chrome-devtools-mcp --auto-connect` | ✓(Chrome ≥144) | Chrome 逐连接弹窗 + 横幅 | 零(YAML) | **最快用上真浏览器** |
| C. dsharp 新插件(chrome-cdp bundle):透传 auto-connect 或原生 CDP 工具 + pre-execute 审批门 + 附件截图 | ✓(同 B 的连接方式) | Chrome 逐连接 + **DSH GUI 逐操作** | 一个新 bundle | 目标形态 |
| D. 薄插件/直接调用 Kimi WebBridge daemon | ✓(装扩展+daemon 后,任何 Chrome 版本) | 连接级(扩展内) | 零到薄 | 接受闭源 daemon 时 |
| E. run_code 手写 CDP WebSocket | 同 A/B 的连接前提 | 无 | 零 | 应急/验证 |

**推荐路径:先 B 后 C。** B 让用户当下就在 DSH 里用上"正在使用的 Chrome"(唯一动作:Chrome ≥144 开启 `chrome://inspect#remote-debugging` + profile YAML 加一条 mcp-client;或上游给 provider 补 `--auto-connect` 透传后走 A 的配置面)。C 是 dsharp 的新 bundle,按 §3.5 组装,把逐操作审批、连接健康检查(读 DevToolsActivePort)、截图交付做齐;如需覆盖 Chrome <144 或不想开审批模式,再加 D(WebBridge daemon 对接)作为 provider 选项。

## 5. 风险与已知限制

- **端口无鉴权**:任何本机进程可连调试端口并获得全部页面/登录态控制;DSH 沙箱明确不管网络。插件必须默认走审批门,并在文档中写明该风险。
- **Chrome 136 硬约束**:默认 profile + 调试开关一律拒绝(仅 Google 品牌构建);别在方案里承诺"重启 Chrome 带端口即可用默认 profile"。
- 保真度:Playwright 官方自述 attach 连接"significantly lower fidelity";chrome.debugger 合成事件对 `isTrusted` 严格站点无效(Kimi 文档同列此限)。
- DSH 侧:浏览器连接每 Session 独占(第二个 Session 会拿不到);截图需附件存储 + 图像模型路由;`toolOrder` 不列浏览器工具名;provider 重载不收养已激活 Session。
- 实施须遵循本仓库 AGENTS.md:真机后台 host 验证循环、strict fakes、containment、per-profile 状态、代码注释引用 dsh 源码路径。

## 6. 下一步(若决定实施 C)

1. 上游(或本仓库薄 provider)给 browser-use-chrome-devtools-mcp 增加 `--auto-connect` 透传(最小改动路线);
2. dsharp 新建 `packages/chrome-cdp`:Config(mode/endpoint/autoConnect/审批策略 volatile 字段)、`tools/pre-execute` 敏感操作审批门、DevToolsActivePort 探测与状态卡、截图经附件管线;
3. 按 AGENTS.md 清单完成单测(strict fakes)+ 真机 host 验证(host 稳定性、审批往返、断连恢复);
4. 文档化:Chrome ≥144 开启审批模式的用户操作步骤、安全须知。
---

## 7. B 方案实验记录(2026-10-19,零改动路径实测)

**环境**:WSL2(NAT 模式)宿主机;浏览器为本地 chromium 129(Playwright 缓存构建,<144,故走端口附加路线);模型 glm-5.3(zai-coding-cn,密钥取自 `~/.dsh/.env`)。

**组装**(全部位于工作区 `.scratch/dsh-btest/`,不触碰正式 `~/.dsh`):`DSH_HOME` 覆盖到测试目录,profile `headless` = `dsh-base` + `dsh-headless`(一次性 agent),patch 层插入 `dsh-mcp-client` 行(stdio 挂 `chrome-devtools-mcp@1.9.0 --browser-url http://127.0.0.1:9223`)。浏览器以 `--headless=new --remote-debugging-port=9223 --user-data-dir=<非默认>` 启动。

**结果:端到端成功。** 一次性任务"用 chrome-cdp 工具打开 example.com 并报告 h1 与标签数"中,agent 通过 `mcp__chrome-cdp__*` 工具真实完成 navigate、`evaluate`(querySelectorAll('h1'))、无障碍快照、标签枚举;答案与浏览器实际状态完全一致(example.com 新版无 h1,2 个标签页);进程干净退出(exit 0)。DSH 侧能力(MCP 挂载、工具目录注入、PTC 分发、失败重试、降级)全部按设计工作。

**实操坑(此前文档未写清)**:
1. loader 方言:profile patch 新增行必须用 `- insert:` 列表;顶层 `- id:` 只能覆盖既有行(base bundle 已提供 llm-pi-ai 等默认行,所以那些可直接覆盖)。
2. **`chrome-devtools-mcp@1.9.0` 的 package.json 有两个 bin**:`chrome-devtools-mcp`(`build/src/bin/chrome-devtools-mcp.js`,MCP server 入口)与 `chrome-devtools`(`build/src/bin/chrome-devtools.js`,CLI/daemon 控制工具,无参运行即报 "Not enough non-option arguments" 退出)。挂 MCP 必须用前者——DSH 树内 provider 正是 import 前者(`packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts:31`)。
3. run_code/bash 沙箱每次调用私有 /tmp,跨调用状态必须放工作区。

**推广到用户真实 Chrome(≥144,默认 profile)**:同一行配置把 `--browser-url http://127.0.0.1:9223` 换成 `--auto-connect`(用户先在 `chrome://inspect#remote-debugging` 开启审批模式;每次连接 Chrome 弹窗授权并显示控制横幅)。WSL2 NAT 注意:Windows 侧 Chrome 监听 127.0.0.1,WSL 内不可直达,需 mirrored networking、Windows 侧 netsh portproxy,或浏览器改绑 `--remote-debugging-address`。

