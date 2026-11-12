# dsh-plugins

DeepSeek Harness 插件 bundle 仓库：每个 `packages/` 子目录是一个可独立安装的 dsh bundle。当前领域围绕飞书机器人网关插件（feishu-gateway）。

## Language

### GitLab 工具插件（dsh-gitlab）

面向 agent 的 GitLab 操作工具集：REST API 加注入令牌的 HTTPS git，全部在 Host 进程内执行，令牌不进会话、不进工具输出。
_Avoid_: glab 包装器（不是包装 CLI，是原生 HTTP + git）、凭据代理（token 保管走 dsh 凭据存储规范）。

### 会话沙箱跟随（Session-sandbox Confinement）

gitlab 插件的 git 进程权限模型：每次调用经 `ctx.sandboxPolicy.resolve({ session })` 取发起会话自己的权限配置，非 `danger-full-access` 模式下由 `ctx.sandbox.confine` 以同一套沙箱执行——与该会话的 bash 完全同边界，插件不自设路径白名单。
_Avoid_: 工作区根白名单（已被此模型取代）、插件自有权限。

### 仅已合并删除（Merged-only Delete）

分支删除的硬性契约：本地 `git branch -d`（永不 -D），远端删除前经 compare API 验证无未合并提交；默认分支与受保护分支一律拒绝，push 无 force。
_Avoid_: 强制删除、-D（不提供，属设计决策）。

### Chrome CDP plugin (chrome-cdp)

A provider bundle that brings the user's real, in-use Chrome into DSH over the Chrome DevTools Protocol: mounts chrome-devtools-mcp exclusively for each live session, layered with a per-action approval gate and a Plugins-page config card. It only attaches to an existing browser; it does not launch disposable browsers (already covered by the in-tree provider).
_Avoid_: browser-use (the host subsystem name, means something else), WebBridge (a third-party product name).

### Connection Mode

How the plugin reaches the browser instance, one of three: `auto` (Chrome ≥144 approval mode, reads the default profile's DevToolsActivePort by channel); `url` (a debug endpoint http://host:port, covering cross-layer setups such as WSL port mappings); `ws` (a browser-level WebSocket endpoint). Endpoint reachability is the environment's responsibility; the plugin makes no network-topology assumptions.
_Avoid_: remote debugging (ambiguous with the Chrome switches of the same name), attach (colloquial; do not use outside the config field).

### Sensitive Action

A browser tool call that the approval gate requires the user to Allow/Deny by default. Every tool outside the default read-only list is treated as sensitive: listing/reading/snapshot/screenshot/network and heap-snapshot analysis/waiting are read-only; navigation, interaction, input, evaluate, and page/extension management are sensitive. Three policy levels: sensitive (default) / all / none.
_Avoid_: dangerous operation (semantically vague).

### Approval Gate

Per-action human approval returned as ask from `tools/pre-execute`, presented in the Web GUI by the host approval service and attached to that tool-call card; fail-closed per host semantics when no approval channel is available.
_Avoid_: connect-level authorization (Kimi WebBridge-style one-shot authorization; different granularity, do not conflate).

### 飞书网关（Feishu Gateway）

把一个飞书自建应用机器人的 p2p 消息接入 DSH、并把 DSH 的输出与提问送回飞书的 host 插件。一个 app_id 对应一个网关实例。
_Avoid_: bot、集成、adapter（泛指时）

### 绑定（Binding）

一条「飞书 chat ↔ DSH 工作区 + 活动会话」的持久化路由。切换绑定只移动指针，不销毁会话；被换下的会话保留在绑定历史中，可随时恢复。
_Avoid_: 映射、上下文（context 在 DSH 中另有所指）

### 活动会话（Active Session）

一个 chat 当前绑定的唯一 DSH 会话。同一 chat 任一时刻至多一个活动会话；发给该 chat 的普通消息一律进入活动会话。
_Avoid_: 当前会话、主会话

### 切换守卫（Switch Guard）

工作区/会话切换与模型变更的前置条件：仅当目标会话空闲（agent idle）时允许执行；忙碌时拒绝并提示用户停止或等待。守卫复用 DSH 的单写者语义，不引入插件自有锁。
_Avoid_: 锁、互斥

### 状态卡（Status Card）

每次绑定切换、新建会话或模型变更成功后固定发送的回执卡片：工作区（名称+路径）、会话、模型、运行状态。失败时回错误原因卡。
_Avoid_: 欢迎消息、摘要

### 应答者（Answerer）

代表某个前端回答 DSH 结构化提问或权限审批的 waterfall 监听方。飞书网关是一个应答者，与 Web UI 并存；不处理时委托给下一个应答者。
_Avoid_: handler、回调

### 降级链（Fallback Chain)

出站消息的格式回退顺序：markdown → post 富文本（md tag）→ 纯文本；超长分片多条发送。任何格式失败都沿链降级，保证必达。
_Avoid_: 重试、兼容模式
