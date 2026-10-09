# 每 chat 单活动会话，切换守卫复用 DSH 单写者语义

一个飞书 chat 任一时刻只绑定一个活动 DSH 会话；工作区/会话切换与模型变更仅在该会话空闲（agent idle）时允许。并发不在插件层自建锁：DSH 的会话写入与模型选择已带单写者防线（`session/writer-held`、`session/agent-busy`），守卫只需前置检查 agent 状态并优雅转译忙碌错误。动机：多会话并发到一个 chat 会使消息顺序错乱、回答无法对应；放弃 chat 内并发换取确定的输出归属。
