# 交接文档 — dsh 飞书机器人网关插件（feishu-gateway）

日期：2026-10-10 · 分支：`feat/feishu-bot-plugin`（基于 `master`，未合并）· 仓库：`/home/ramuz/skills-workspace/dsharp`

## 1. 项目目标与当前状态

为 DeepSeek Harness（DSH）做一个飞书（Lark）机器人消息插件：飞书 p2p 消息驱动绑定的 workspace 会话执行任务；DSH 的结构化提问/权限审批以交互卡片往返飞书；chat 内可切换工作区/会话/模型，切换后回显状态卡。

**状态：实现完成、全部测试通过（feishu 73 + airboard 39）、已安装进本机 live profile（`link:` 本地链接），等用户完成飞书侧配置后做端到端实测。**

## 2. 交付物地图

| 路径 | 内容 |
|---|---|
| `docs/research/2026-10-09-feishu-bot-plugin.md` | 调研报告（DSH 插件架构 / Hermes 飞书模式 / 飞书 API 标准，全部带一手出处） |
| `CONTEXT.md` | 领域术语表（绑定、活动会话、切换守卫、状态卡、应答者、降级链） |
| `docs/adr/0001-feishu-gateway-as-host-plugin.md` | 网关=同进程 host 插件（拒绝独立进程 SDK 路线） |
| `docs/adr/0002-single-active-session-per-chat.md` | 每 chat 单活动会话 + 守卫复用 DSH 单写者语义 |
| `docs/adr/0003-depend-on-official-lark-node-sdk.md` | 依赖官方 `@larksuiteoapi/node-sdk`（长连接协议无公开规范） |
| `docs/specs/2026-10-09-feishu-gateway-design.md` | SPEC（14 条用户故事 + 设计，已评审通过） |
| `docs/plan/2026-10-09-feishu-gateway.md` | 实施计划（8 任务 TDD，已全部执行完） |
| `packages/feishu-gateway/` | **本插件**（纯 JS 零构建，host + browser 双半边） |
| `packages/airboard/` | 顺带改造：token 从 patch 明文迁移到凭证存储 |

### feishu-gateway 模块结构

- `index.js` — apply() 接线：凭证解析（credentials 服务）→ SDK client → transport/driver/answerer；未配置时 inactive 只打日志；`setSdkForTests`/`getLastAnswererForTests` 测试缝。
- `lib/config.js` — Config schema：`appId`、`appSecretEnv`（credential-ref，默认 `FEISHU_APP_SECRET`，表单不显示）、`domain`、`commandPrefix`、`messageChunkLimit`（8000）。
- `lib/lark-client.js` — 出站封装：per-chat 串行队列（避 5 QPS）、每次发送自动带 uuid 幂等参数。
- `lib/transport.js` — SDK WSClient 长连接；`normalizeInboundEvent`（p2p 过滤、content JSON 解析）；`MessageDedup`（message_id TTL 去重）；`ActionDedup`（messageId+actionId 复合键防双击，带清理）；`loadSdk` 可注入。
- `lib/formatter.js` — 降级链 markdown→post(md tag)→strip 纯文本（每片至多送达一次）；`chunkText` 分片；状态卡/提问卡/审批卡/改动摘要卡（interactive JSON 1.0）；diff 渲染。
- `lib/router.js` — `BindingRouter`：chat→{workspace, activeSession} 持久化绑定（storage domain，内存回退）；切换=改指针+历史（上限 10）；`chatForSession` 供 answerer 路由。
- `lib/commands.js` — `parseCommand`（SUBCOMMANDS 仅 ws/session 有 sub）、`guardDecision`（running→拒绝+提示 /stop）、`translateGuardError`（writer-held/agent-busy→友好中文）、`HELP_TEXT`。
- `lib/driver.js` — 命令执行、会话编排（agents.create/resume + followup/steer，UserMessage 形状照 webhook 模板；`/stop` 用 `agent.cancel({kind:'user'})`）；turn/end → 最终回复+改动卡；模型经 `apiSessions.selectModel`；所有变更路径过守卫。
- `lib/answerer.js` — `user-questions/request`/`approval/request` waterfall 应答者：路由条件=router 的会话归属（`resolveChat`）+lastUserSource 次要信号；不属于自己的 `next()` 委托；request.signal abort→killPending→迟到答案走 `userQuestions.answer`；多问题迟到点击有守卫。
- `client.js` — browser 半边（factory 格式）：Plugins 页 bundle 配置卡。appId/domain 走 SettingsFormModel；**App Secret 走 `remote.credentials.set/describe`**（凭证存储，只显示已配置/未配置）。
- `cordis.patch.yml` — bundle 层（appId/domain 默认值）。
- `tests/*.spec.js` — 73 个测试（node --test，fake transport/ctx，不触真实飞书）。

## 3. 关键决策与裁定（Rulings，接手者必读）

1. **SDK 依赖**：长连接线缆协议为 SDK 私有 → 依赖 `@larksuiteoapi/node-sdk`（唯一运行时依赖，ADR 0003）。
2. **降级链**：每片 post 优先→失败降级 strip 文本，**无 post-after-text 重试**（曾裁定 SPEC-VIOLATING：会重复消息）。
3. **dsh 真实 API 对齐**（终审修正，接手者改 driver/answerer 前先对照 dsh 源码）：
   - `followup/steer` 收一个 UserMessage 对象（`packages/core/agent-loop/src/agent.ts:163,167`；形状见 `packages/llm/llm/src/message.ts` 的 `createUserMessage`，源码里 best-effort import + 形状一致的本地 fallback）；
   - `/stop` 用 `agent.cancel({kind:'user'})`；
   - 最终回复从 `session.deriveMessages()` 倒序取 assistant 文本；
   - 会话标题 `ctx.sessionTitle.get(session)`、模型 `session.requestHeader()?.config`；
   - answer item 形状 `{id, selected}`；`callId` 在 `request.wait?.callId`；ApprovalOutcome 真实 union 是 `allowed-once/rejected/cancelled/unavailable`（answerer 返回字符串；卡片的 会话内/总是→`allowed-once` 有损映射，v1 可接受）。
   - dsh checkout 只读参考路径：`/home/ramuz/deepseek-harness/packages/`。
4. **配置哲学**（最后一轮改动，26161dc）：**secret 永不进 patch 层**——GUI secret 控件写 `remote.credentials.set`（引用名 `FEISHU_APP_SECRET`/`AIRBOARD_TOKEN` 由 Config credential-ref 字段持有），host 经 `ctx.credentials.resolve()` 解析，env 同名变量兼容。airboard 旧 patch 明文 token 保留为只读回退。
5. **client 半边升级坑**：client module system 把"非 client 包"判定缓存到 **host 重启**为止；给已安装插件新增 browser 半边后必须重启 host + 强刷浏览器（普通刷新可能拿到旧 boot 图缓存）。

## 4. 环境与安装状态

- live profile：`~/.dsh/profiles/web`（GUI http://127.0.0.1:3080）。feishu-gateway 已 `link:` 安装并在 bundles 列表，浏览器 boot 图已包含（用户已确认配置卡出现）。
- 本机 bash 在 bwrap 沙箱（独立 PID 命名空间）：**看不到、也重启不了 host 进程**；重启 host 需用户操作。
- 插件管理走 `plugin_manager` 工具（`set_plugin` target 用 `include:feishu-gateway`）。
- `cordis_inspect_query` 带 input 参数会报 "input must be an object"（harness 缺陷），无参 catalog 查询可用。

## 5. 等待用户完成的事项（端到端实测前置）

1. Plugins 页 feishu-gateway 卡片：填 App ID + App Secret（secret 存凭证存储）。
2. 飞书开发者后台 checklist（详见 `packages/feishu-gateway/README.md`）：开机器人能力→**发布版本**；权限 `im:message`、`im:message.p2p_msg`、`im:chat:readonly`、`im:resource`；事件配置选**长连接**+`im.message.receive_v1`（客户端先在线再保存）；回调配置长连接+`card.action.trigger`；把自己加可用范围。
3. 实测序列：`/help` → `/ws list` → `/ws use <名>` → 任务消息（回复+改动卡）→ 触发 ask_user_question（按钮卡片）。
4. airboard：用户在卡片重存 token 后，**删除 `~/.dsh/profiles/web/cordis.patch.yml` 里 airboard 行的明文 `token: abt_...`**（第 231 行附近；删前确认凭证已存）。

## 6. 已知遗留（v1 可接受，均记于 SDD 会话；.scratch 已清理，见各任务 ledger 摘要沉淀在 git log）

- 多问题提问只渲染 questions[0]（live 部分答案；迟到点击有守卫不发错）；multiSelect 以文字回复。
- diff 消息无 30KB 分片守卫（超大 diff 的 post 会被拒且无回退）。
- host 重启后绑定仍指向旧 sessionId 时静默新开会话（未走 resume 路径，driver.spec 有记录）。
- 群聊、CardKit 流式卡片、webhook 传输、媒体双向：v2 范围（SPEC out-of-scope）。
- 审批卡四按钮中「会话内/总是」映射为 allowed-once（DSH 无对应语义），建议 v2 收敛为两按钮。
- 团队多人共用建议加 `allowedUsers`（open_id 白名单）配置——用户已知悉，未实施。
- 飞书侧硬限制（已核实官方文档）：一个 app_id 只能被一个网关进程持有（长连接集群模式随机投递）；多用户=加应用可用范围即可（每 chat 天然隔离）。

## 7. 建议的下一步（按序）

1. 完成第 5 节的端到端实测；任何一跳失败，对照 host 日志 + `packages/feishu-gateway/README.md` 排查。
2. 清理 airboard patch 明文 token。
3. 分支收尾：`finishing-a-development-branch`（合并回 master / PR / 保留——用户尚未选择）。
4. 可选增量：`allowedUsers` 白名单、v2 范围项。

## 8. 常用命令

```sh
cd packages/feishu-gateway && node --test "tests/*.spec.js"   # 73 tests
cd packages/airboard && node --test "tests/*.spec.js"          # 39 tests
pnpm -r pack                                                  # 打 tarball
git log --oneline master..HEAD                                # 25+ commits
```
