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
| `/ws list` | 列出所有工作区 |
| `/ws use <名称>` | 切换绑定的工作区（纯指针切换，不受运行限制） |
| `/ws new <路径> [标题]` | 注册新工作区并绑定 |
| `/session new` | 当前工作区开新会话（需会话空闲） |
| `/session resume` | 从会话历史恢复（卡片选择；需空闲） |
| `/stop` | 打断当前回合 |
| `/model` | 选择模型（卡片；需空闲） |
| `/status` | 当前状态卡 |
| `/help` | 帮助 |

普通文本消息进入当前活动会话；会话运行中的消息作为 steer 插入。
每回合结束发送最终回复（markdown → 飞书富文本，超长分片）与改动摘要卡
（可按文件点开 unified diff）。提问与权限请求以卡片按钮作答，迟到答案
自动走续答通道。
