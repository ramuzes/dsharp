# 飞书网关作为同进程 host 插件，而非独立进程

飞书机器人网关（feishu-gateway）以 dsh host 插件形态实现在 dsh 进程内，而不是独立网关进程（经 SDK/JSON-RPC 或 ACP 驱动 dsh）。原因：结构化提问（`user-questions/request`）与权限审批（`approval/request`）的接管依赖进程内注册 Cordis waterfall 应答者，跨进程只能走 remote 事件转发扩展，复杂度陡增；同进程还让网关与 Web UI 作为并行前端天然并存（不处理时 `next()` 委托）。代价是 host 重启会断开长连接——由飞书 SDK 语义内的自动重连吸收。

## Considered Options

- 同进程 host 插件（选定）
- 独立进程网关（SDK stdio / ACP）——进程隔离更好，但应答者路由不可行或过重
