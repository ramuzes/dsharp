# dsh-feishu-gateway

飞书（Lark）机器人网关：把一个飞书自建应用机器人的 **p2p 单聊**接入 dsh。
消息驱动绑定的 workspace 会话执行任务；结构化提问与权限审批以交互卡片
往返；支持在 chat 内切换工作区 / 会话 / 模型，切换后回显状态卡。

- 设计文档：`docs/specs/2026-10-09-feishu-gateway-design.md`
- 依赖官方飞书 Node SDK（`@larksuiteoapi/node-sdk`，纯 JS 无构建脚本）

## 安装

```sh
dsh plugin --profile <name> add /path/to/dsharp/packages/feishu-gateway
```

> **升级注意**：client module system 会把「某 Loader 行不是 client 包」的判定
> 缓存到 host 重启为止。若先安装过不含 browser 半边的旧版本，升级后必须
> **重启 dsh host** 并刷新页面，Plugins 页的配置卡片才会出现；全新安装
> （host 在安装后启动/重载）不受影响。

## 配置

在 Web GUI 的 **Plugins 页面**（bundle 卡片的配置表单，由 browser 半边注册）配置：

| 字段 | 说明 |
|---|---|
| `appId` | 飞书自建应用 App ID（`cli_` 开头） |
| App Secret（secret 控件） | 填入一次即存入 dsh **凭证存储**（`FEISHU_APP_SECRET` 引用），只显示 已配置/未配置，不再回显 |
| `domain` | `https://open.feishu.cn`（海外用 `https://open.larksuite.com`） |

**secret 永不进 patch 层**：secret 控件经 `remote.credentials.set` 写入
凭证存储（与 Models 页 API key 同模式），host 启动时经 `ctx.credentials`
解析。启动环境 export `FEISHU_APP_SECRET=xxx` 同样有效（headless 场景）。
未解析到时插件静默 inactive（日志提示一次并指明缺哪个引用）。

## 飞书开发者后台 checklist

1. 企业自建应用 → 添加应用能力 → **机器人**；**创建版本并发布**（能力发布后才生效）。
2. 权限（发布后生效）：`im:message`、`im:message.p2p_msg`、`im:chat:readonly`、`im:resource`。
3. 事件与回调 → 事件配置：订阅方式选 **使用长连接接收事件**，添加事件 `im.message.receive_v1`。
4. 事件与回调 → 回调配置：选 **长连接**，配置 `card.action.trigger`。
   （`card.action.trigger` 必须配在回调配置，不是事件订阅；点按钮报 200340 通常是这里配错。）
5. 可用范围：把使用者加入应用可用范围，用户才能与机器人单聊。

## Chat 命令

| 命令 | 作用 |
|---|---|
| `/ws` | 工作区列表（默认行为，同 `/ws list`；未知子命令同样回落到列表） |
| `/ws use <名称>` | 切换绑定的工作区（纯指针切换，不受运行限制） |
| `/ws new <路径> [标题]` | 注册新工作区并绑定（需会话空闲） |
| `/session` | 会话列表（默认行为，同 `/session list`，时间倒序 10/页，按钮恢复） |
| `/session new` | 当前工作区开新会话（需会话空闲） |
| `/session resume [序号\|sessionId前缀]` | 恢复指定会话（需空闲；指针切换+回显上一轮输出） |
| `/stop` | 打断当前回合 |
| `/model` | 模型目录单卡选择（**运行中可选**，下一轮生效） |
| `/status` | 当前状态卡（模型行读 modelSelection 投影，待生效切换有标注） |
| `/doctor` | 网关自检（启动阶段/最近事件/绑定/写锁/默认模型） |
| `/help` | 帮助 |

普通文本消息进入当前活动会话（宿主 `prompt()`，幂等 requestId）；会话运行中的
消息作为 steer 插入当前回合。每回合结束发送最终回复（markdown → 飞书富文本，
超长分片）与改动摘要卡（可按文件点开 unified diff）。提问与权限请求以卡片按钮
作答，迟到答案自动走续答通道。

## 开发规约（本插件专属）

以下规则是本插件开发中踩过的坑，通用规则见仓库根 `AGENTS.md`，这里只记
飞书侧与本插件的 specifics。

### 架构：gateway-as-browser

驱动会话一律走宿主 `sessionController` Remote 面（`prompt/create/cancel/
selectModel/modelCatalog/projections/list`）——与 Web GUI 相同的入口。**绝不**
直接调 `agents.create/resume`、手挂 preset setup、手拼 agentOptions：那会重新
发明宿主已保证的语义（按会话 preset 恢复、模型解析、幂等 requestId、跨进程
`session/writer-held` 错误码），历史上造成过 {{model}} 变量崩溃、空心 Agent
（36 个 tool-removal）、锁冲突三类故障。注意 Remote 方法签名可能带必填的
第二参数 `signal`（如 `prompt(request, signal)` 首行裸调
`signal.throwIfAborted()`），进程内调用必须传。

### 飞书侧协议事实

- **事件被 SDK 扁平化**：`EventDispatcher.parse()` 把 schema-2.0 事件的
  `message/sender/action/context/operator` 放到顶层，不在 `data.event` 下。
  解析同时兼容两种形状（`lib/transport.js`）。
- **字段以 SDK 类型为准**：`ApprovalRequestEvent` 只有 `reason` +
  `displayReason: {en, zh, …}`，没有 `prompt`；卡片文案优先 `displayReason.zh`。
- **入站先记日志再解析**：每个到达的事件（含被过滤的）写入
  `~/.dsh/feishu-gateway-events.json`（type/chatType/outcome），排查"没反应"
  先看这里和 `~/.dsh/feishu-gateway-status.json`。
- **出站限速**：飞书对同 chat 限 5 QPS，`lib/lark-client.js` 按 chat 串行 +
  250ms 间隔；发送失败只记日志不抛出（绝不进宿主调用栈）。

### 集成测试（FGTEST 流程）

1. 改动 → `node --test tests/*.spec.js` 全绿（fake 必须复刻真实签名严格性）。
2. 用独立 profile 起 dsh 宿主（托管后台任务，按 pid 停止，勿用 `pkill -f`）。
3. 从飞书真实发消息驱动，观察宿主日志 + 状态/事件文件，确认宿主稳定
   （`dsh: fatal load failure` = 插件把宿主搞挂了，最高优先级事故）。
4. `node scripts/doctor.mjs --profile <dir>` 自检凭证与长连接。

