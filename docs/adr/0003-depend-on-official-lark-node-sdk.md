# feishu-gateway 依赖官方飞书 Node SDK

飞书 WebSocket 长连接（事件订阅 + 卡片回调的推荐传输）没有公开的线缆协议：端点协商、加密、心跳都在官方 SDK 内实现。裸实现等于逆向无文档协议。因此 feishu-gateway 引入 `@larksuiteoapi/node-sdk` 作为唯一运行时依赖（纯 JS、无原生构建脚本，安装不需要 allowBuilds 授权），放弃本仓库「无运行时 npm 依赖」的默认约定；HTTP API 调用也统一走 SDK 以减少自维护面。

## Considered Options

- 官方 Node SDK（选定）
- 裸 HTTP+WS 实现——长连接协议无公开规范，不可行
- v1 改 webhook 传输免 SDK——需公网地址，与「本机部署无需公网」目标矛盾
