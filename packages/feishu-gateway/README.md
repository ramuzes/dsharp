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

## 配置

在 Web GUI 的 **Plugins 页面表单**（由 Config schema 自动生成）配置：

| 字段 | 说明 |
|---|---|
| `appId` | 飞书自建应用 App ID（`cli_` 开头） |
| `appSecretEnv` | 凭证引用（credential-ref）：secret 存放的环境变量名，默认 `FEISHU_APP_SECRET` |
| `domain` | `https://open.feishu.cn`（海外用 `https://open.larksuite.com`） |

**secret 本身不进配置层**：`appSecretEnv` 指向的凭证经 dsh 的
credentials 服务解析（与内置模型路由同 seam）——启动环境里 export
`FEISHU_APP_SECRET=xxx`，或存入凭证存储。未解析到时插件静默 inactive
（日志提示一次并指明缺哪个引用）。

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
