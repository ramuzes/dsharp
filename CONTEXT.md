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

### Memory plugin (dsh-engram / 记忆插件)

A host plugin embedding engram persistent memory into DSH: an HTTP client of the local engram daemon registering curated memory tools, with the project resolved per session and the store shared across workspaces.
_Avoid_: engram MCP wrapper, memory MCP (those name the rejected integration shapes)

### Daemon stewardship (守护进程托管)

The plugin's responsibility model for the `engram run -d` daemon: health probing first, spawning on demand per config or connecting to an existing instance, never racing a user-started one.
_Avoid_: resident studio (engram has no "studio" concept), hosting (as a generic term)

### Project resolution (项目解析)

Mapping a session's working directory to an engram project: the server probe (`GET /project/current?cwd=`) first, explicit per-workspace config overriding, ambiguous results passed through structurally to the model.
_Avoid_: cwd binding (cwd is only a resolution input, not a process property)

### Session bridge (会话桥)

The lifecycle mapping between DSH sessions and engram sessions: register the engram session on agent creation (lease renewed by activity), finalize on agent end.
_Avoid_: session sync, session mirroring

### Proactive context injection (主动记忆注入)

A configurable behavior that injects a bounded engram context summary into the prompt at assembly time, distinct from retrieval tools the model calls.
_Avoid_: auto-memory (confusable with engram autosync)

### Save-worthiness policy (保存价值判断)

The explicit criteria, stated in the tool description and prompt section, for what the agent should persist: durable decisions, preferences, discovered constraints, and conclusions — never transient, re-derivable, secret, or duplicate content. Saving is always the agent's own judgment; the plugin never bulk-captures conversation content.
_Avoid_: auto-save, capture-all

### Role template (角色模板)

A persisted, reusable blueprint for a team member: display name, one-line description, a standing prompt (the role's duties and constraints), an optional base model, an optional high-tier model (which requires a usable base model), and a reuse policy (`role` or `task`). It is exactly what the user would otherwise type to the lead agent when asking for that member, configured once per profile and instantiable in any session.
_Avoid_: agent preset (DSH's own composition mechanism, a different layer), assistant (CherryStudio's term), persona (vague), system prompt (the child's system prompt comes from its own composition, never from the template), task description (that is only the optional part)

### Roster (成员名册)

The profile-wide library of role templates owned by the agent-roster plugin; the single source from which team members are created in any session.
_Avoid_: team (DSH team mode is the per-session coordination flag), library, registry (collides with the preset registry)

### Member spawn (成员生成)

Creating a team member by instantiating a role template as an ordinary subagent under the current tree's root, through the same subagent runtime the `subagent` tool uses. Two ways in: the "+" dialog stages its request and runs the `roster` command, and the lead agent may call the `roster_spawn` tool from the conversation — both through one host-side spawn. The standing prompt is framed in the child's opening message as its role (frozen — the model never rewrites it), never as a task. A spawn resolves a model route: `roster_spawn` names a model tier (`base`, the default, or `high` — which requires a stated reason and a template high-tier model), never a model, and the route comes from the template; the dialog may override it for that one spawn (a spawn override), including back to inheriting the session model. A spawn override never edits the template and is not a tier decision. This holds for the dialog and the typed command as well as `roster_spawn`, which share one member registry. Under the template's `role` reuse policy, a spawn with a task hands it to a resident member of the same template and model route that is idle within the caller's own team tree, and creates a member only otherwise; without a task it likewise adds nobody: it returns that idle member's name and wakes nobody.
_Avoid_: agent creation (that is sessionController's ordinary-session path), preset selection, injection (the dialog never puts words in the user's mouth)

### Roster command (/roster)

The host command that gives a task to, or creates, a member. The transcript records it like `/compact`: a compact command entry with its outcome, no user message, no model turn. Typed with a template name it adds a standby member with that template's defaults; run by the dialog it uses the request the dialog staged for that session.
_Avoid_: slash-command UI only (the dialog runs it too), agent tool (that is `roster_spawn`)

### Standby member (待命成员)

A member created without a first task. Its opening tells it that inherited context is not an assignment and to reply once and wait; it settles without notifying the lead, stays in the parent catalog, and is given work later through messages, the shared task board, or a spawn under role reuse. Under the `role` policy a spawn of the same role and model route without a task does not add a member: it returns the standby member's name and wakes nobody.
_Avoid_: idle agent (it is resident and continuable, not stopped), background task (nothing is being computed)

### Model tier (模型档位)

Which of a template's two stored models a task runs on: `base` (the template's base model, or the session model when it has none) or `high` (its high-tier model). The lead names the tier, never the model, and states a reason for `high`; the plugin does not judge the reason but records every high-tier dispatch (Settings lists the newest 50; a failed record write is reported as a warning on the tool result instead). The tier follows the task, never the role.
_Avoid_: model override (that is the dialog's per-spawn choice), escalation level (nothing is measured)

### Resident member (常驻成员)

A member a role keeps between tasks under the `role` reuse policy: created from a template on one model route, given its next task through a message when idle. Reuse looks only within the caller's own team tree (members of the same root). The plugin remembers which member belongs to which role in memory, for one plugin mount: a host restart or a plugin reload clears the registry.
_Avoid_: standby member (a resident member is one whether or not it currently has a task), session (a member's session persists in the host regardless)

