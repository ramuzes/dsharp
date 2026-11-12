# dsh-feishu-gateway

飞书（Lark）机器人网关：把一个飞书自建应用机器人的 **p2p 单聊**接入 dsh。
消息驱动绑定的 workspace 会话执行任务；结构化提问与权限审批以交互卡片
往返；支持在 chat 内切换工作区 / 会话 / 模型，切换后回显状态卡。

英文 README：`README.md`；开发规则：`DEVELOPMENT.md` 与仓库根 `AGENTS.md`。

## 配置

在 Web GUI 的 **Plugins 页面**（bundle 卡片的配置表单）配置：

| 字段 | 说明 |
|---|---|
| `appId` | 飞书自建应用 App ID（`cli_` 开头） |
| App Secret（secret 控件） | 填入一次即存入 dsh **凭证存储**（`FEISHU_APP_SECRET` 引用），只显示 已配置/未配置，不再回显。启动环境 export `FEISHU_APP_SECRET=xxx` 同样有效（headless 场景）。 |
| `domain` | `https://open.feishu.cn`（海外用 `https://open.larksuite.com`） |

未解析到凭证时插件静默 inactive（日志提示一次并指明缺哪个引用）。

## 飞书开发者后台 checklist

1. 企业自建应用 → 添加应用能力 → **机器人**；**创建版本并发布**（发布后才生效）。
2. 权限（发布后生效）：`im:message`、`im:message.p2p_msg`、`im:chat:readonly`、`im:resource`。
3. 事件与回调 → 事件配置：订阅方式选 **长连接**，添加事件 `im.message.receive_v1`。
4. 事件与回调 → 回调配置：选 **长连接**，配置 `card.action.trigger`（按钮报
   200340 通常是这里配错）。
5. 可用范围：把使用者加进应用可用范围，使其能和机器人对话。

## Chat 命令

| 命令 | 作用 |
|---|---|
| `/ws [list]` / `/ws use <名称>` / `/ws new <路径> [标题]` | 工作区列表 / 切换指针 / 注册并绑定 |
| `/session [list]` / `/session new` / `/session resume [序号\|前缀]` | 会话列表 / 新建 / 恢复（要求空闲） |
| `/stop` / `/release` | 打断当前轮次 / 暂停 IM 投递（保留绑定） |
| `/model` | 模型选择卡（运行中可选，下一轮生效） |
| `/status` / `/doctor` / `/help` | 状态卡 / 自检 / 帮助 |

普通文本进入活动会话（运行中的消息作为 steering 插入）；每轮结束回执最终
回复（markdown→富文本，超长分片）与变更卡。提问与审批经卡片按钮作答。
