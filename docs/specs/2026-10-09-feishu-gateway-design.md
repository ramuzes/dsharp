# 飞书网关（feishu-gateway）— DSH 飞书机器人消息插件

日期：2026-10-09 · 状态：待评审 · 依据：[调研报告](../research/2026-10-09-feishu-bot-plugin.md)、[ADR 0001](../adr/0001-feishu-gateway-as-host-plugin.md)、[ADR 0002](../adr/0002-single-active-session-per-chat.md)

## Requirement (the why & what)

### Problem statement

用户在飞书里无法驱动 DSH：任务要开 Web GUI 才能下发；DSH 遇到需要决策的结构化提问或权限审批时，若用户不在 GUI 前，任务只能停摆等待。飞书上的聊天上下文与 DSH 的多工作区之间也没有任何关联机制——不同项目的任务会混在同一个对话上下文里。

### Goal

一个 dsh host 插件 bundle（feishu-gateway），绑定一个飞书自建应用机器人后：

1. 用户在飞书 p2p 单聊中发消息即可驱动 DSH 在**绑定的活动会话**中执行任务，回复与文件改动预览送达飞书；
2. 用户可在飞书内切换工作区/会话/模型，每次切换后收到固定格式的**状态卡**回显当前状态；
3. DSH 的结构化提问与权限审批以交互卡片送达飞书，用户点按钮即可作答，任务继续；
4. 安装后零运行时依赖、零构建步骤，`dsh plugin add` 即用。

### User stories

1. 作为 DSH 用户，我想把一个飞书自建应用（app_id/app_secret）配置给插件，以便我的飞书机器人成为 DSH 的一个前端。
2. 作为飞书用户，我想在与机器人的 p2p 单聊里直接发任务消息，以便不开 Web GUI 也能驱动 DSH。
3. 作为飞书用户，我想用 `/ws list` 查看所有工作区、`/ws use <名称>` 切换绑定，以便不同项目的任务各归各的工作区。
4. 作为飞书用户，我想用 `/ws new <路径> [标题]` 把一个新目录注册为工作区并绑定，以便冷启动新项目。
5. 作为飞书用户，我想用 `/session new`（在当前工作区开新会话）、`/session resume`（从本 chat 的会话历史中挑一个恢复）与 `/stop`（打断当前回合）管理会话，以便控制任务节奏。
6. 作为飞书用户，我想用 `/model` 从可用目录中挑选模型，以便控制当前会话的模型与推理力度。
7. 作为飞书用户，我想在每次切换工作区/会话/模型后收到一张状态卡（工作区、会话、模型、运行状态），以便随时确知当前状态。
8. 作为飞书用户，我想在会话忙碌时收到明确拒绝（提示先 /stop 或等待），以便理解为什么切换没生效。
9. 作为飞书用户，我想收到 agent 最终回复（markdown 渲染，超长自动分片），以便在飞书内阅读完整结果。
10. 作为飞书用户，我想在每轮任务后收到文件改动摘要（文件、增删行数），摘要卡上按需点开单个文件的 unified diff，以便审查改动。
11. 作为飞书用户，我想在 DSH 提出结构化问题时收到带选项按钮的卡片，点选后任务继续，以便远程做决策。
12. 作为飞书用户，我想在 DSH 请求权限升级时收到允许/拒绝卡片，以便远程审批。
13. 作为 Web GUI 用户，我想同时在 GUI 里看到并操作同一批会话，以便两个前端并存互不干扰。
14. 作为插件使用者，我想让提问/审批只在「该会话来自飞书」时路由到飞书，其余仍走 Web UI，以便多前端各管各的。

### Out of scope

- 群聊（@ 提及、群内 per-user 会话隔离）——留 v2；
- CardKit 2.0 流式打字机卡片、打字机流式渲染——留 v2；
- webhook 回调传输模式（公网地址、challenge、签名校验）——留 v2；
- 入站媒体（用户发飞书消息里的图片/文件进 DSH）——留 v2；
- 出站图片上传（v1 以文本 diff 预览为主）——留 v2；
- 多飞书应用 / 多租户绑定（一个 host 一个 app_id）；
- 定时任务/cron 结果推送。

## Design (the how)

### Solution

一个名为 feishu-gateway 的 host 插件 bundle（本仓库 `packages/` 下，纯 JS 零构建）。它用飞书开放平台的 **WebSocket 长连接**接收一个自建应用机器人的 p2p 消息与卡片回调，把消息送入「绑定」指向的活动会话，并把 DSH 的回复、改动预览、结构化提问与权限审批格式化后送回同一个 chat。工作区/会话/模型通过 chat 内斜杠命令切换，切换由**切换守卫**前置约束（仅 idle），成功后必发**状态卡**。插件同时注册为一个**应答者**，与 Web UI 按「会话来源」分工。

### Implementation decisions

**模块划分**（bundle 内部，均为纯函数或薄状态类，可独立单测）：

- **lark-client**：飞书 API 封装——基于官方 Node SDK（`@larksuiteoapi/node-sdk`，本 bundle 唯一运行时依赖，纯 JS 无构建脚本）：`WSClient` 长连接（事件分发、心跳/重连内置）、`Client` API 调用（token 管理 SDK 内置）、发消息/回复。WebSocket 长连接的线缆协议（端点协商、加密、心跳）为 SDK 私有、无公开规范，这是引入 SDK 的原因（见 ADR 0003）。
- **router**：绑定存储。持久化结构按 chat 组织：`{ chatId, workspaceId, activeSessionId, sessionHistory: [{sessionId, title}], updatedAt }`，经 dsh host 的 storage domain 设施持久化。切换 = 改指针 + 旧会话入历史。
- **commands**：斜杠命令解析（`/ws`、`/session`、`/model`、`/status`、`/stop`、`/help`），子命令各自映射到 router / agents / model-selection 的调用。命令以外的文本视为任务消息。
- **driver**：入站消息 → 无绑定时引导用户 `/ws use`；有绑定时 `agents.resume(activeSessionId)` + `followup`（首次走 create-with-workspace 流程，复用 webhook 模板的编排：workspace → agent → attachSession → followup）。出站：监听全局 `session/event`，按事件来源过滤出本网关管理的会话，回合结束时取最终 assistant 回复发飞书；`workspace/changes` 事件驱动改动摘要。
- **answerer**：注册 `user-questions/request` 与 `approval/request` waterfall 监听器。路由条件：请求所附 agent 的会话来源为 feishu（source kind 判断）；不满足或飞书投递失败时 `next()` 委托。收到飞书卡片回调后 resolve 对应 pending Promise；问题已超时（timed 模式变 continued）则改走 `userQuestions.answer(agent, callId, answer)` 续答。审批卡语义对齐 ApprovalOutcome（允许一次/会话内/总是/拒绝）。
- **formatter**：降级链 markdown → post(`md` tag) → 纯 text；按请求体预算（post 30KB 硬限）预分片，分片上限保守取 8000 字符；diff 渲染为 markdown 代码块；状态卡/提问卡/审批卡为 interactive 卡片 JSON 1.0（v1 不依赖 CardKit 2.0）。

**切换守卫**：`/ws new`、`/session new`、`/session resume`、`/model` 执行前检查当前活动会话的 agent 状态非 running；执行中遇到 `session/writer-held`、`session/agent-busy` 转译为友好提示。`/stop` 是忙碌时的唯一出口（打断当前回合）。`/ws use`（纯指针切换）不受旧会话忙碌限制；`/session resume` 无参数时先列本 chat 会话历史（卡片按钮选择），选择后同样过守卫。

**模型控制**：经 session 模型选择通道提交 `{provider, model, reasoningEffort?}`（校验失败回目录错误）；目录枚举经 LLM 适配器注册表。状态卡显示当前生效模型；若提交时尚有未消费的 pending 选择，标注「下一回合生效」。

**幂等与限频**：入站按 message_id 去重（带 TTL 的内存 + 持久化集合）；出站消息携带 uuid 幂等参数；卡片回调 action 按去重窗口丢弃双击；对同一 chat 的发送做简单排队以避开 5 QPS。

**配置（Config schema）**：`appId`、`appSecret`（支持 env 引用，经 dsh 凭证机制解析，不落明文）、`domain`（feishu|lark）、`commandPrefix`（默认 `/`）、`messageChunkLimit`（默认 8000）。全部有默认值；未配置 app 凭证时插件 inactive 并在日志说明。

**与 Web UI 并存**：插件创建的会话用 source kind `feishu`（附 chatId、senderOpenId）标记；GUI 正常显示与操作这些会话；GUI 触发的提问不经飞书（answerer 路由条件不满足）。

**接口契约（对外）**：不新增公开 Service/Event——插件消费现有 host 服务（agents、workspaceRegistry、userQuestions、approval、workspaceChanges、storage、credentials），不向其他插件暴露 API。bundle 的 Loader 行 id 为 `feishu-gateway`。

### Testing decisions

- **最高缝隙优先**：formatter、router、commands、守卫判定均为纯逻辑，直接 `node --test` 单测（本仓库 bundle 惯例，参照 airboard 的 `tests/*.spec.js`）。
- **lark-client / driver / answerer**：以注入 fake transport（可编程的假 WebSocket/HTTP）测试协议行为——challenge 语义不需要（长连接无），重点：token 刷新时机、message_id 去重、降级链触发（伪造 post 被拒）、waterfall `next()` 委托路径、writer-held 转译。
- **不在单测中触达真实飞书**；端到端连通性留给手工验收（开发者用自己的 app 凭证）。
- 测试文件放 `packages/feishu-gateway/tests/`，`pnpm test` 可跑。

## Further notes

- 飞书侧配置 checklist（开发者后台：开机器人能力、发布版本、事件订阅 `im.message.receive_v1`、回调配置 `card.action.trigger` 均选长连接、scope 集合）写入 bundle README。
- 错误码映射表（230025 超限→自动分片重试；200340→配置指引；230038/230053→用户提示）随 formatter/commands 实现沉淀。
- 后续版本路线：群聊 → 流式卡片 → webhook 传输 → 媒体双向。
