# 0004 — chrome-cdp 复用 browser-use 子系统挂载 chrome-devtools-mcp

状态：已接受（2026-10-19）

## 背景

需要让 DSH agent 操作用户正在使用的真实 Chrome（CDP，带登录态），并且敏感操作须经人工审批。可选实现路径：

1. 依附宿主 browser-use 子系统：`ctx.browserUse.register` + 复用 `mountSessionMcp`（每会话独占挂载 MCP 子进程）；
2. 自绘每会话挂载：仅依赖 dsh-mcp-client + dsh-scope，复刻 createScope / agent/created / scope.ctx.plugin 核心；
3. 纯配置 bundle：cordis.patch.yml 插入全局 mcp-client 行（B 实验已验证该机制可行）；
4. 原生 CDP 工具：宿主进程内自持 WebSocket 直连调试端点，自注册工具。

## 决策

采用路径 1。插件形态 = provider（复用树内 browser-use-chrome-devtools-mcp 的挂载模式，新增 `auto` 连接模式透传 `--auto-connect`）+ 全局 `tools/pre-execute` 审批门（按 `mcp__chrome-cdp__` 前缀匹配，不侵入 runtime）+ Plugins 页配置卡与状态命令。

- `chrome-devtools-mcp` 依赖**精确锁版本**：审批清单按其工具名面维护，次版本变动可能改名/新增工具。
- 不实现 launch（一次性浏览器）模式：树内 provider 已覆盖该场景，本插件只面向"真实浏览器"。
- 审批门为全局监听（非 agent scope）：MCP 工具对全部会话可见性一致，门也必须一致。

## 后果

- 继承宿主每会话独占、忙碌遮罩、创建期发现等待等全部语义；不手搓框架级生命周期（AGENTS.md 铁律）。
- 代价一：依赖 experimental alpha 包（browser-use-runtime）。实施第 0 步必须验证其 npm 包实含 `./mcp` 导出与 `mountSessionMcp`；若缺失，按方案 2 vendor 最小核心并在代码注释注明出处与差异。
- 代价二：上游 provider 行为变化（experimental）可能要求跟进；以真机 host 验证循环兜底。
- 与 B 实验结论一致：机制全部现成，插件是组装而非发明；两个实操坑（- insert 方言、chrome-devtools-mcp 双 bin）已记入调研报告 §7。
