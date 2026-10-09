# DSH 飞书（Feishu/Lark）机器人消息插件 — 调研报告

日期：2026-10-09。调研对象：DSH 插件架构（本地 checkout `/home/ramuz/deepseek-harness/`）、Hermes Agent 的 Feishu 集成（参考设计）、飞书开放平台 API 标准。所有关键结论均标注一手出处。

---

## 0. 总结论

DSH 为「飞书 bot 网关插件」准备了几乎全部基础设施，且仓库内已有一个非常接近的参考实现：**GitHub webhook → 自动创建 Session 并注入 prompt**（`packages/webhook/`）。推荐插件形态为 **host plugin**（可打包为本仓库 `packages/` 下的 bundle）：

1. 飞书侧接入用**长连接（WebSocket）模式**接收 `im.message.receive_v1` 与 `card.action.trigger`（无需公网回调），或经 `dsh-host-webserver` 注册 HTTP 路由接收 webhook 回调；
2. 用 `ctx.agents.create()/resume()` + `ctx.workspaceRegistry` 创建/恢复会话，`agent.followup()/steer()` 注入用户消息；
3. 监听 `session/event`（global）观察输出，经 `ctx.workspaceChanges` 取每轮文件变更与 unified diff；
4. 注册 `user-questions/request` 与 `approval/request` **waterfall** 监听器，把 ask_user_question 与权限审批路由到飞书卡片、回收答案（与 Web UI 天然并存）；
5. **workspace 切换是 Hermes 明确没有的能力**，需自行设计：把「飞书 chat ↔ workspace」映射持久化，提供飞书内切换命令。

---

## 1. DSH 插件架构（源码级）

### 1.1 插件/bundle 形态

- 普通 host plugin：带 `apply(ctx)` 命名导出的 ESM 包即可（`docs/cordis-tutorial/01-first-plugin.zh.md`）。
- bundle：package.json `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，并把 patch 列入 `exports`/`files`（参照 `packages/bundle/base/package.json`）。patch YAML 为 Loader 方言（`- insert:` 列表，`{id, name, disabled, config}`，按 id 覆盖，支持 `!!js` 表达式）；文档 `docs/cordis-tutorial/06-composition-and-hmr.md`、`docs/cordis-primer.md`。
- 本仓库（dsharp）已有模板：[packages/workspace-env](../../packages/workspace-env)（纯 host）、[packages/airboard](../../packages/airboard)（host+client 双半，`dsh.client` + slot 注入）。飞书插件主体在 host，客户端半边仅在做 Web GUI 配置卡片时需要。
- 零构建纯 JS、依赖只留 dsh peer 包，是本仓库 bundle 的既定约定。

### 1.2 Service / Events / Tools / Config

- Service：`class MyService extends Service { static inject = [...] }`，`declare module '@deepseek-ai/cordis'` 合并 ctx 类型（模板 `packages/webhook/webhook/src/index.ts:13-82`）。
- 事件：`ctx.on('session/event', (session, event) => {}, { global: true })`（`packages/interaction/user-questions/src/index.ts:111-122`）；可拦截应答的 waterfall 事件用 `ctx.on(name, (payload, next) => ...)`。
- 工具：`ctx.tools.register(defineTool({...}))`（`packages/interaction/tool-ask-user/src/index.ts:33-60`）。
- Config：`export const Config = z.object({...})`（schemastery），loader 行 config 经它校验/填默认值。

### 1.3 长驻后台与 HTTP 入口

- 生命周期 = Cordis effect：`ctx.effect(() => disposer)`，后台循环在 disposer 中 abort + drain（模板 `webhook/src/index.ts:105-175`；定时循环模板 `packages/schedule/schedule/src/runtime.ts:19-82`）。飞书 WS 长连接客户端即以此管理，重连用 capped backoff。
- HTTP 路由：`WebRoute`（`@deepseek-ai/dsh-host-webserver`），注册 API `webServer.register(route)`；GitHub webhook 的签名校验 + dispatch 是完整范例（`packages/webhook/webhook-github/src/handler.ts:13,81,115`）。凭证经 `ctx.credentials.resolve()`（env 引用）。
- 宿主另有 `webhookRuntime`（fire-and-forget 规则运行时）可复用。

### 1.4 编程式驱动 Session（消息驱动任务的核心）

- `ctx.workspaceRegistry.create(path, title?)` / `get/list/resolveByPath` / `attachSession/detachSession`（`packages/workspace/workspace/src/index.ts:170,236`）。
- `ctx.agents.create({ sessionId?, meta: { cwd, agentPreset }, agentOptions, setup })` / `resume({ resumeSessionId })`（`packages/core/agent/src/index.ts:202,245,391,410`）。
- 用户消息：`agent.followup(msg)`（新回合）、`agent.steer(msg)`（插队/续答）；消息经 `createUserMessage({ content, source })` 构造，`source` 可自定义 kind——webhook 用 `{kind:'webhook',...}`，飞书可用 `{kind:'feishu', chatId, senderOpenId, messageId}`。
- **完整模板**：`packages/webhook/webhook/src/session.ts:117-179` `createWebhookSession()`——解析 workspace 路径/标题/prompt/preset/model → 建 workspace → `agents.create` → attach → `followup(prompt)`，失败回滚。飞书消息驱动可直接照抄。
- 观察输出：`session/event`（`user/message`、`turn/end` 等）+ `agent/assistant-stream`（流式帧）；历史回查用 `packages/session-query/`（SQLite）。
- 替代路线：`packages/sdk/`（进程外 JSON-RPC stdio 全 runtime）或 `packages/acp/`（外部程序前端协议，含审批应答范例 `acp/src/index.ts:155`）——但同进程 host 插件能直接挂 waterfall answerer，更贴合。

### 1.5 结构化提问 / 审批 → 飞书路由（关键 seam）

- `ask_user_question` 工具（`tool-ask-user`）→ `ctx.userQuestions.ask()` → **waterfall `user-questions/request`**（`user-questions/src/index.ts:287,324-329`）。Web UI 即经 remote 转发监听同名事件（`ui-user-questions/src/client/index.ts:400`）。
- 超时续答：`@Remote answer(agent, callId, answer)` 把答案 steer 回 agent（`:164-206`）——飞书侧迟到答案应走此接口，而非再造消息。
- 权限审批：`approval/request` waterfall（`packages/interaction/user-approval/`）；无 answerer 则 fail-closed；沙箱升级（`sandbox/src/escalation.ts`、bash 工具）走此 seam。每次 ask/decided 写审计事件。
- 飞书插件做法：注册两个 waterfall 监听器，渲染飞书卡片（选项按钮/允许拒绝），回调到达后 return 答案；不处理时 `next()` 委托给 Web UI → **多前端并存**。注意：agentless 问题只有 unscoped 全局监听器能接（`user-questions/README.md` Known Limitations）。

### 1.6 文件/改动预览

- `ctx.workspaceChanges`：每轮 git 快照 + 编辑捕获 → `WorkspaceChangesSummary { turn, cwd, files[{path, added, deleted, binary?, oversized?}], total, added, deleted }` 与 `WorkspaceFileDiff`（unified-diff hunks，行带 +/- 前缀）——可直接格式化为飞书文本卡片 / markdown diff 块（类型见 `docs/subsystems/deliverables.md`）。
- `present` 工具产生 `PresentedFile` 事件可识别交付物；图片经 `packages/attachment/` 附件服务读取后上传飞书。
- Web 渲染参考：`packages/client/ui-deliverables/`。

### 1.7 现状

DSH 全库**无任何** slack/telegram/discord/wechat/feishu/lark 集成；最近的是 GitHub webhook、ACP、SDK。

---

## 2. Hermes Agent 飞书集成（参考设计）

来源：[官方文档](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/feishu)、[PR #3817](https://github.com/NousResearch/hermes-agent/pull/3817)（diff 新增 `gateway/platforms/feishu.py` 3255 行）、[`gateway/session.py`](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/gateway/session.py)、社区插件 [hermes-feishu-zh](https://github.com/OLDBAI213/hermes-feishu-zh)、[hermes-lark-streaming](https://github.com/Cheerwhy/hermes-lark-streaming)。

### 2.1 运行模式
- 双模式 `FEISHU_CONNECTION_MODE=websocket|webhook`，默认 websocket：官方 `lark-oapi` SDK 的 WS Client 跑在后台线程，心跳/自动重连内置，断链 supervisor 以 capped backoff 重建。
- webhook 模式：自动应答 url_verification challenge（受 verification_token 门控）+ `SHA256(timestamp+nonce+encrypt_key+body)` timing-safe 签名校验 + 限流 + body ≤1MB；**不支持加密体 payload**。
- 卡片回调 `card.action.trigger` 必须配在 **Callback Configuration**（与 Event 订阅分开的 tab），长连接模式选 Long Connection——配置错则按钮点击报 200340（卡能发、回调收不到）。
- 同一 app_id 全局仅一个实例（scoped lock）。

### 2.2 会话绑定
- 确定性 session key：`agent:<profile>:<platform>:<chat_type>:<chat_id>[:<thread_id>][:<user_id>]`；DM 按 chat_id 一会话，群聊默认按用户隔离；`SessionStore` 持久化路由索引，支持 `/new` `/resume` `/stop` 与自动重置。
- 并发：**每 chat_id 一把锁串行，chat 间并发**；message_id 去重（24h TTL 持久化）；突发合并（text 0.6s/8条/4000字）。

### 2.3 消息格式
- 出站：纯文本→`text`；含 markdown→**post 富文本 + 内嵌 `md` tag**；post 被拒时回退 strip-markdown 纯文本（两级回退保证必达）。
- 超长分片：`MAX_MESSAGE_LENGTH=8000` 字符切多条（分片而非截断）。
- 流式：核心适配器只做 Typing reaction；流式卡片（CardKit v2.0 streaming API）是社区插件层方案，接近 200 元素上限自动拆卡。
- 入站 post 富文本逐元素归一化为 markdown（at/img/file/code_block），interactive 等打占位符。

### 2.4 交互回路
- 卡片按钮 → 合成 `/card button {...}` 命令进统一管线；action token 15 分钟去重防双击。
- 审批：Allow Once / Session / Always / Deny 卡片，回调送回决策并把卡片替换为 resolved 态。
- 收到消息先打 OK reaction 作回执。

### 2.5 文件/媒体
- 收：`im:resource` scope + GetMessageResource 下载缓存；小 .txt/.md 内容直接注入消息文本。
- 发：先上传换 key（图片 `CreateImage`、文件 `CreateFile`），按扩展名路由 opus/mp4/doc/stream；GIF 降级为文件附件（无原生 GIF 气泡）。

### 2.6 Workspace 切换 —— 明确空白
Hermes 飞书集成无任何 per-chat 工作目录/项目切换机制（一个 app = 一个实例 = 一套全局工作区）。最接近的只有 multi-profile（多 bot 非多项目）与群内 per-user 会话隔离。**此功能需自行设计，无参考实现。**

---

## 3. 飞书开放平台 API 标准（官方文档）

（官方文档页加 `.md` 后缀可得纯 Markdown 版，如 `.../message/create.md`。海外域名把 open.feishu.cn 换成 open.larksuite.com。）

### 3.1 应用与鉴权
- 企业自建应用 + 「添加应用能力→机器人」；**开启能力后必须发布版本才生效**。
- `tenant_access_token`：`POST /open-apis/auth/v3/tenant_access_token/internal`，body `{app_id, app_secret}`；**TTL 2h，剩余 <30min 再取返回新 token（新旧并存）**；`Authorization: Bearer`。
- 所需 scopes：发送 `im:message`（或 `send_as_bot`）；接收 p2p `im:message.p2p_msg`、群 @ `im:message.group_at_msg`；上传 `im:resource`；卡片实体 `cardkit:card:write`；群列表 `im:chat:readonly`。

### 3.2 事件订阅
- **Webhook**：需公网 IPv4；保存时 `url_verification` challenge 需 1s 内原样返回；Encrypt Key = AES-256-CBC（key=SHA256(ek)，PKCS7）；Verification Token 校验 `header.token`；失败重推 15s/5min/1h/6h 最多 4 次。
- **长连接（WebSocket）**：SDK 内置，无需公网/解密验签；仅自建应用；每应用 ≤50 连接；集群模式随机投递；事件需 3s 内处理。**自建应用推荐**。
- 事件 `im.message.receive_v1`（schema 2.0）：`event.sender.sender_id.{open_id,union_id,user_id}`、`event.message.{message_id, chat_id, chat_type("p2p"/"group"), message_type, content(JSON 字符串), mentions[]}`。
- **幂等：官方要求按 message_id 去重，不要依赖 event_id**。

### 3.3 发送消息
- `POST /im/v1/messages?receive_id_type=open_id|chat_id`，`content` 为 JSON 字符串；`uuid` 参数可幂等（1h 内同 uuid 至多一条）。
- 类型：`text`（支持 at/加粗/链接轻标签）、`post`（富文本，tag: text/a/at/img/media/hr/code_block/**md**；**md tag 支持 CommonMark 0.31+GFM**，官方推荐 markdown 首选 post+md）、`interactive`（卡片实体/模板/裸 JSON 三种）、`image/file/audio/media`（需先上传）。
- 回复：`POST /im/v1/messages/:message_id/reply`。

### 3.4 长度/大小限制（关键数字）
| 项 | 限制 |
|---|---|
| text 请求体 | ≤150 KB |
| post / interactive 请求体 | ≤30 KB（超限报 230025，**无自动截断**） |
| 卡片组件数（JSON 2.0） | ≤200 |
| 卡片实体 data | ≤3,000,000 字符（但建议 ≤30KB） |
| 上传图片 | ≤10MB；文件 ≤30MB |
| 频控 | 同一用户 5 QPS；同群机器人共享 5 QPS；接口级 50 次/秒、1000 次/分 |
| 卡片局部更新 | 10 次/秒/卡，1000 次/分 |

### 3.5 卡片与流式
- 卡片 JSON 2.0（CardKit）：`schema:"2.0"`、`config.streaming_mode`、每组件全局唯一 `element_id`；仅共享卡（update_multi=true），需客户端 ≥7.20。
- 卡片实体：`POST /cardkit/v1/cards` → `card_id`，仅可发送一次、**14 天有效**。
- 全量更新：`PATCH /im/v1/messages/:message_id`（14 天内、5 QPS、前后均需 update_multi:true）或 `PUT /cardkit/v1/cards/:id`。
- 局部更新：`POST /cardkit/v1/cards/:id/batch_update`（`sequence` 严格递增；actions: add/delete/update/patch elements）。
- **流式打字机（官方为 AI bot 设计）**：`config.streaming_mode:true`（print_frequency_ms 默认 70ms）→ 建卡片实体 → 发送 → 调「流式更新文本」接口传全量文本（平台算增量）→ 结束后关 streaming_mode（10 分钟自动关）。
- **回调 `card.action.trigger`**：3s 内响应，可在响应体直接返回 `{toast, card:{type:"raw",data}}` 原地换卡；或用 `event.token` 延时更新（30 分钟有效、最多 2 次）。

### 3.6 其他约束
- 机器人发消息前提：用户在可用范围、群内机器人有发言权；用户可关闭接收（230053）；跨租户 p2p 禁止（230038）。
- 群自定义机器人（webhook bot）不能调 /im/v1/messages——与自建应用机器人别混用。
- 群列表 `GET /im/v1/chats` 分页（page_size ≤100，不含 p2p）；租户标识 `tenant_key`。

---

## 4. 设计要点综合（面向后续 SPEC）

1. **接入**：飞书自建应用 + 长连接模式（Node SDK `WSClient`），host 插件内 `ctx.effect` 管理重连；token 缓存 <30min 刷新。webhook 模式可作可选 fallback（复用 `webServer.register` + Hermes 式签名校验）。
2. **绑定模型**：`chat_id(+sender open_id) → { workspaceId, sessionId }` 持久化路由（Hermes SessionStore 模式）；新消息 → 有路由则 `agents.resume + followup`，无则按 workspace 默认建新会话（照抄 `createWebhookSession`）。同一 app_id 单实例锁。
3. **workspace 切换**（自研，无先例）：飞书命令如 `/ws list`、`/ws use <name>`、`/ws new <path>`（走 `commands` 服务或插件内命令解析）；切换即改绑定路由（保留旧 sessionId 便于切回；`/new` 开新会话）。群聊默认按用户隔离会话，但 workspace 绑定按 chat 级（或提供 per-user 覆盖）。
4. **出站格式化**：markdown → post+`md` tag → 纯文本两级回退；>8000 字（或按 30KB 请求体预算）分片；diff 预览用 `workspaceChanges` 的 summary+hunks 渲染成 markdown 代码块卡片；图片先 `attachments` 读再 `im/v1/images` 上传。
5. **问答/审批路由**：注册全局 `user-questions/request` 与 `approval/request` waterfall 监听器 → 飞书卡片按钮 → 回调 return 答案；不认识的 scope `next()` 委托 Web UI；timed 超时后续答走 `userQuestions.answer(agent, callId, answer)`。审批卡用 Allow Once/Session/Always/Deny 语义对齐 DSH `ApprovalOutcome`。
6. **幂等与并发**：inbound 按 message_id 去重（持久化 TTL）；outbound 用 `uuid` 参数；per-chat 串行、chat 间并发；卡片回调 action token 去重防双击。
7. **进阶（可后置）**：CardKit 2.0 流式打字机卡片渲染 assistant-stream；状态 reaction 作回执。
8. **模型控制（飞书端）**：模型选择是 per-session 的——`session-controller.selectModel()`（`packages/api/session-controller/src/commands.ts:151`，经 `requireModel` 对照 LLM adapter catalog 校验）→ `agent.session.append('model/selection', selection)` 持久化并作用于下一次请求（`agent.ts:279-336`；Web GUI `/model` 弹窗即走此路，host 插件可直接调用）。模型目录经 LLM 服务 `listModels(provider)` 枚举（`llm/adapters-updated` 事件维护时效）。飞书侧提供 `/model` 卡片选项列表（provider → model → 可选 reasoningEffort），当前生效模型从 `modelSelection` session projection 或日志 request header 读取。
9. **切换后显式状态回显**：每次 `/ws use`、`/session new|resume`、`/model` 成功后固定发一张「当前状态卡」：工作区（title + path）、会话（id/title/preset）、模型（provider/model/effort）、运行状态（`agent/status`、`api-session/status`）。失败回错误原因。
10. **单 chat 单会话 + 切换前置条件**：并发不自行发明锁，对齐 DSH 单写者语义——session 被占用时 `selectModel`/会话写入报 `session/writer-held` / `session/agent-busy`（Web UI 即译为「会话正在使用中」）。设计：绑定路由 `chat_id → {workspaceId, sessionId}` 一 chat 一活动会话；切换/新建/换模型的前置条件 = 目标 agent idle（监听 `agent/status`，或尝试后优雅处理 `writer-held`，回飞书「运行中，请先 /stop 或等待完成」）；切换只改绑定指针，旧 sessionId 留在路由历史，可切回（`agents.resume` 支持任意恢复）。
11. **风险清单**：卡片回调配置错（200340）；post/卡 30KB 硬限无截断；5 QPS 频控；agentless 问题的全局监听器要求；`ask` 审批策略 fail-closed。

---

## 附录：一手出处索引

- DSH 源码（本地 checkout）：`packages/webhook/webhook/src/{index,session}.ts`、`packages/webhook/webhook-github/src/handler.ts`、`packages/interaction/{tool-ask-user,user-questions,user-approval}/`、`packages/core/agent/src/index.ts`、`packages/workspace/workspace/src/index.ts`、`packages/deliverables/workspace-changes/`、`packages/host/webserver/src/index.ts`、`packages/acp/`、`packages/sdk/`、`docs/{cordis-tutorial,cookbook,subsystems}/`。
- 运行中 Host 实测（cordis_inspect）：`userQuestions`、`approval`、`agentLoop`、`agents`、`workspaceRegistry/workspaceController`、`workspaceChanges`、`webhookRuntime`、`webServer`、`attachments`、`fileUploads`；事件 `user-questions/request`、`approval/request`、`agent/assistant-stream`、`session/event`、`api-session/*`。
- Hermes：[Feishu/Lark 文档](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/feishu)、[PR #3817 diff](https://patch-diff.githubusercontent.com/raw/NousResearch/hermes-agent/pull/3817.diff)、[gateway/session.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/gateway/session.py)、[hermes-feishu-zh](https://github.com/OLDBAI213/hermes-feishu-zh)、[hermes-lark-streaming](https://github.com/Cheerwhy/hermes-lark-streaming)。
- 飞书官方：[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[消息内容结构](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json)、[接收消息事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)、[事件订阅概述](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview)、[长连接](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case)、[tenant_access_token](https://open.feishu.cn/document/ukTMukTMukTM/uIjNz4iM2MjLyYzM)、[卡片 JSON 2.0](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)、[更新卡片](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/update-feishu-card)、[流式更新](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)、[卡片回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)、[上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)、[上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create)、[频控策略](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)、[群列表](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/list)。
