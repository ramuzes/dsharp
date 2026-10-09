# dsh-plugins

DeepSeek Harness 插件 bundle 仓库：每个 `packages/` 子目录是一个可独立安装的 dsh bundle。当前领域围绕飞书机器人网关插件（feishu-gateway）。

## Language

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
