# chrome-cdp — 把用户真实 Chrome 经 CDP 接入 DSH

## Requirement（为什么 & 做什么）

### 问题陈述

用户在浏览器里保有登录态与工作现场，agent 却只能用无状态的 web_fetch 看页面。用户希望 agent 能操作"正在使用的 Chrome"完成网页任务，且敏感操作必须经人工批准——类似 Kimi WebBridge 的体验，但不依赖其闭源组件，并以更细的逐操作审批替代其连接级授权。

### 目标

安装 chrome-cdp bundle 后：agent 获得 chrome-devtools-mcp 全量浏览器工具，作用于用户指定的真实浏览器实例（三种连接模式，环境无关）；敏感操作在 Web GUI 逐次弹 Allow/Deny；连接与策略在 Plugins 页可配置、热改生效；状态可查。B 实验已证明宿主机制全部就绪，本插件为组装层。

### 用户故事

1. 作为用户，我想让 agent 操作我正在使用的 Chrome（带登录态），以便把网页上的信息与操作交给 agent。
2. 作为用户，我想选择连接模式（auto / url / ws），以便适配同机默认 profile（Chrome ≥144 审批模式）、端口映射（WSL→Windows 等）或任意可达调试端点——插件不假设网络拓扑。
3. 作为用户，我想敏感浏览器操作默认弹 Allow/Deny、只读操作免打扰，以便agent 动浏览器必须过我这一关，又不至于刷屏。
4. 作为用户，我想把审批策略切成 all / sensitive / none，以便按场景收紧或放开。
5. 作为用户，我想在 Plugins 页改端点与策略并即时生效（新会话起），以便换浏览器不用重启宿主。
6. 作为用户，我想随时查看连接健康（DevToolsActivePort 探测、挂载归属、上游版本），以便排查"浏览器没反应"。
7. 作为用户，我想第二个会话不抢已在用的浏览器连接（独占 + 明确报错），以免两个 agent 同时操作。
8. 作为 agent，我想先 take_snapshot / take_screenshot 看页面再动手，以便操作有依据。

### 范围外

- Kimi WebBridge daemon 的对接（调研已确认可行，留作后续 provider 选项）。
- Web GUI 侧栏浏览器面板（标签页列表/操作流水视图）。
- launch（一次性浏览器）模式——树内 browser-use-chrome-devtools-mcp 已覆盖。
- WSL↔Windows 的网络打通（端口映射、mirrored networking 由环境侧负责，插件只消费端点）。
- 桌面级 computer-use 控制。

## Design（怎么做）

### 方案

一个 dsharp bundle（host 半边 + client 半边）。host 半边注册为 browser-use 子系统的 provider：按连接模式拼装 chrome-devtools-mcp 启动参数，复用宿主每会话挂载语义（独占 attach、忙碌遮罩、创建期发现等待）；再注册全局审批门与状态命令。client 半边在 Plugins 页提供配置卡与连接状态显示。

### 实现决策

- **连接模式**（Config，enum）：
  - `auto`：透传 `--auto-connect`（Chrome ≥144 审批模式；`channel` 默认 stable，可配）。插件不读端口文件——上游自行解析 DevToolsActivePort。注意 auto 隐含「浏览器与 DSH 同环境」（同 OS 的默认 profile 目录）；跨环境（如 WSL→Windows）用 url + 端口映射。
  - `url`：透传 `--browser-url <endpoint>`（http 端点；含端口映射场景）。
  - `ws`：透传 `--ws-endpoint <endpoint>`（浏览器级 WS 端点）。
  - 统一追加 `--no-usage-statistics`。
- **审批门**：全局 `tools/pre-execute` 监听，匹配 `mcp__chrome-cdp__` 前缀；按策略与只读清单返回 ask（displayReason 中英双语，reason 落审计）/ allow；不匹配前缀一律放行。ask 的 UI 与审计由宿主 approval service 承担（无渠道即 fail-closed）。
  - 默认只读清单（chrome-devtools-mcp 1.9.0 工具名面）：list_pages、list_network_requests、list_console_messages、list_extensions、list_webmcp_tools、get_network_request、get_console_message、get_tab_id、get_os_app_state、take_snapshot、take_screenshot、wait_for、performance_start_trace、performance_stop_trace、performance_analyze_insight、take_heapsnapshot、close_heapsnapshot、compare_heapsnapshots、query_heapsnapshot_objects、get_heapsnapshot_*（9 个）。
  - 策略：`sensitive`（默认，清单外皆审）、`all`（全审）、`none`（全放行）。
  - 清单与策略均为 Config 字段；只读清单为覆盖式替换（用户给清单即整体取代默认清单）。
- **配置**（schemastery，volatile 标注热改字段）：连接模式、端点、channel、审批策略、只读清单覆盖、工具调用超时。volatile 语义按宿主：改动写回 profile patch、对新挂载生效。
- **依赖**：dsh 包全部 peer `*`（随宿主解析）；`chrome-devtools-mcp` 精确锁 1.9.0（工具名面稳定是审批清单的前提）。
- **上游验证（实施第 0 步）**：确认发布版 browser-use-runtime 含 `./mcp` 导出与 `mountSessionMcp`；缺失则 vendor 最小挂载核心（scope + agent/created + mcp-client plugin），代码注释注明出处与差异，并回写本 SPEC 的决策记录。
- **状态**：`/cdc` 斜杠命令（dsh-commands）+ Plugins 卡状态区：连接模式、端点/通道、上游版本、当前挂载归属会话；探测不主动连接浏览器（不产生额外审批弹窗），仅组装当前配置的诊断文本。
- **containment**：一切回调经 safely 包装；挂载生命周期由宿主 effect 管理；状态文件按 profile 命名。
- **每会话独占**：沿用宿主 browser-use 语义（attach 独占、忙碌会话工具遮罩）。

### 测试决策

- **单元测试**（node --test，strict fakes）：审批门策略矩阵（sensitive/all/none × 只读/敏感/前缀外工具 → allow/ask）、参数拼装（三种连接模式 + 旗标）、配置校验（非法模式/端点缺失）。fake 严格复刻 pre-execute 载荷形状与 waterfall 语义（含 next() 委托），不放宽任何字段。
- **真机 host 验证循环**（AGENTS.md 要求）：复用 B 实验装置（工作区 .scratch 测试 home + headless profile + 本地 chromium 调试端口）：①策略 none 端到端（agent 驱动真实浏览器）；②策略 sensitive 下敏感工具被拦截（无审批渠道时 fail-closed 报错可见）；③宿主全程稳定、无 dangling rejection。
- **GUI 人工验证**（一次）：fgtest host 上策略 sensitive，浏览器敏感操作在 Web GUI 弹出 Allow/Deny，Allow 放行、Deny 拒绝（模型侧收到明确拒绝原因）。
- 先例：feishu-gateway 的 strict-fake 测试与真机验证循环。

## 补充说明

- 背景与可行性论证见 docs/research/2026-10-19-dsh-cdp-browser-control.md（含 B 实验记录与两个实操坑）。
- 架构决策记录：docs/adr/0004-chrome-cdp-via-browser-use-mcp.md。
- 安全基线：调试端点无鉴权，本机任意进程可连；插件的缓解是审批门 + 文档明示，不得宣称沙箱隔离。
