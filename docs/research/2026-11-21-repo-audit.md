# dsharp 全仓代码审计 — 设计问题 / 早期 dsh API 误用 / 更优实现

Status: Audit (2026-11-21) · 三路并行审计，全部 API 断言对照 dsh 0.2.2-rc.5 源码（/home/ramuz/deepseek-harness）验证；发布前对 4 个最重发现做了独立抽查复核（gitlab clone 丢 exec、feishu messageChunkLimit 包装对象、airboard 硬编码源、feishu watchdog 死代码——全部坐实）。

严重度分布：**Critical 0 · Important 11（含 1 条仓库级规则证伪）· Minor ~15 · Info/裁定若干**。

## 修复优先级建议（Top 6）

| # | 插件 | 问题 | 一句话修法 |
|---|---|---|---|
| 1 | gitlab | `gitlab_git_clone` 丢失 `exec`：沙箱策略按部署默认解析（非会话），clone 目的地可落在错误根；`exec.signal` 取消失效；零测试覆盖 | 两次调用透传 `exec`（对齐 `gitlab_git_fetch`）+ 补测试 |
| 2 | airboard | 未配置时 agent 工具静默回退**硬编码第三方源** `http://ab.antaresy.cc`（含 create/update 的内容外发）——与自身浏览器半边的 503 行为和 README 矛盾 | 删默认值，返回既有 `airboard/not-configured` 错误码 |
| 3 | feishu-gateway | `messageChunkLimit` 对**反应式包装对象**做 `Number()` → 恒 NaN → 恒 8000，用户配置死亡（AGENTS.md §3 首号陷阱的存活样本） | 经解包助手读取 |
| 4 | feishu-gateway | `driver.js` watchdog 读取 `config.watchdogMs`，但 **schema 无此字段、apply 未接线** → 安全特性静默失效 | 补 schema 字段并接线，或删除死代码 |
| 5 | engram | 取消/超时（AbortError/5s timeout）被映射为 `engram/unreachable` → 污染就绪记忆 → 一次用户取消触发完整重拉起循环（含重复 spawn） | 区分 `engram/timeout|aborted` 与连接拒绝 |
| 6 | feishu-gateway | 两个失败 spec 的真因：`@deepseek-ai/dsh-typert-protocol` 只在 peerDependencies，未入 devDependencies → 仓库状态即红 | 加入 devDependencies |

## 按插件明细

### gitlab (v0.2.4)
- **[I] agent-tools.js:125-128** — clone 丢 exec（见上）。
- **[I] git-exec.js:20,70-76** — 裸 `node:child_process.spawn` 而非 `ctx.subprocess` 服务缝：绕过进程域管理/输出收集/诊断。dsh 自家参考实现（client-ui-forge/src/git.ts:232）已改走 subprocess.spawn；**同仓的 engram 已是新范式**。修法：注入 `subprocess` 服务，保留 confinement/redaction。
- **[M] gitlab-api.js:91** — `signal ?? AbortSignal.timeout(t)`：调用方传 signal 时超时**整体失效**（所有 agent 调用都传 exec.signal）。对照 engram-api.js:85-87 的 `AbortSignal.any` 组合。
- **[M] agent-tools.js:382-383** — `gitlab_stale_branches` 分页静默截断（>50 分支时谎报"无未合并"）→ 违反 AGENTS.md "silent filtering is a defect"。分页或加 truncated 标记。
- **[M] git-exec.js:80,89-106** — 超时路径报 "git exited null"，不提超时。
- **[M] index.js:94-97** — 状态文件跨 host 实例共享单记录覆盖（与 engram 同病，见下）。
- **[Info·裁定] 硬编码 section order 2360 **不是** API 误用**：dsh 的 `SECTION_ORDERS` 是核心闭环表（system-prompt/src/index.ts:136-173），无插件锚点 API，硬编码仍是唯一方式。`sandboxPolicy.resolve + sandbox.confine` 也仍是钦定模式（forge git.ts 同款）。
- **[Info·优化] 39 个工具全常驻提示词**：dsh `defineTool` 已支持 `deferLoading`（core/tools/src/schema.ts:500-501；llm-deepseek 序列化为 defer_loading）——gitlab 的 prompt section 已满足"可发现性"要求，标记低频面（releases/milestones/schedule 变更/mr_reviews）为 deferred 可显著降 token 成本。

### engram (v0.1.2)
- **[I] engram-api.js:97-102 + index.js:190-199** — 取消/超时与守护进程死亡混淆（见 Top5）。
- **[I] agent-tools.js:105-108 + index.js:174-189** — 停驻项确认**未修**：守护进程死亡时每次工具调用全量 ensure（5 探测 + 1 spawn + 延迟 ≈1.2s+）；spawn 成功但健康不过（端口错位）时反复起进程。修法：失败记忆 + 退避窗口（如 30s）。
- **[M] context-injection.js:125-139** — 停驻项确认**未修**：注入 refresh 持续失败则每轮提示组装重踢一次 resolve+fetch。加负缓存窗口。
- **[M] status.js /（gitlab 同）** — 停驻项确认**未修**：`~/.dsh/engram-status.json` 跨实例共享。
- **[M] agent-tools.js:111-122** — "save 重试会话注册一次"是**死路径**：bridge 的 ensureSession 从不 reject；注册静默失败后 save 仍 POST 未注册的 session_id。要么让失败可传，要么删死分支并记录守护进程容忍度。
- **[M] context-injection.js:70-73,161-164** — agent 消亡后 cache 项滞留至插件卸载（长寿命 host 内存缓慢累积）。effect disposer 里 `cache.delete(agent)`。
- **[Info·裁定] 同步 section + 后台刷新是对当前 dsh 的正确形态**（PromptSection.text 契约、AssembleContext 无会话身份、agent/created 载荷、subprocess seam 用法均与源码核对一致）。

### feishu-gateway (v0.1.3)
- **[I] index.js:130** — messageChunkLimit 死配置（见 Top3）。
- **[I] driver.js:557-560 vs lib/config.js** — watchdog 死代码（见 Top4）。
- **[I] tests** — 两个红 spec 是真缺陷：缺 devDependency（见 Top6）。
- **[M] driver.js:656-673** — `/status` 每次全量冷读 durable log 扫 `sandbox/mode`/`approval/policy`。**更优**：`ctx.sessionProjections.register` + O(1) 读取（session-controller/src/list.ts:66 是官方用法）。
- **[Info·裁定·推翻 AGENTS.md §3 一条]** "scoped waterfall 只达 ROOT 监听器、插件 fiber 的 {global:true} 被静默忽略" **与 rc.5 源码矛盾**：dsh-scope 的过滤器放行**未打标签**的监听器（core/scope/src/index.ts:170-185 + README），且 loader 不给插件 fiber 打 scope 标签 → 插件 fiber 上的 approval/request 监听器**会被送达**。feishu 的 `ctx.root ?? ctx` 写法依旧安全且仍是推荐，但 AGENTS.md 的理由陈述对当前版本不成立，应改写（可能源自旧版 cordis/dsh-scope）。
- **[Info·裁定] client.js require ui-primitives 是钦定模式**：该包在冻结的 `PLATFORM_MODULES` 共享模块表内（client/web/src/platform.ts:13），动态 bundle 按表身份解析、不会漂移。practices.md:35 的禁令过时，应收窄为"禁止 require 表外包"。
- **[Info] 其余核对通过**：waterfall 礼仪（next() 委托）、containment（safely + transport effect 内结清）、错误码全部存在于 host、steer/queue+requestId 与 Remote 面一致、configForms/credential-ref 均为当前范式。

### chrome-cdp (v0.1.1)
- **[M] mount.js:22** — 忙会话静默得不到浏览器工具（无日志/无信号）→ "silent filtering" 类。修法：记日志并在 status() 暴露 holder。
- **[M] mount.js:24-27** — 并发 agent/created 交错时输家已挂载的 MCP 子进程**泄漏且破坏独占不变量**。修法：输家 dispose 自己的挂载，或先串行化认领再挂载。
- **[Info·裁定] per-agent 挂载就是当前 dsh 的一等模式**：`ctx.mcpManager.register` 是全局舰队（无每会话变体）；钦定的 agent 作用域挂载是 `agentCtx.plugin(McpClient, config)`（ACP 同款，acp/src/mcp.ts:23-28）——chrome-cdp 正是这么做的，无需迁移。审批门（tools/pre-execute ask 形态、fail-closed、next() 委托）全部合规。

### workspace-env (v0.2.1)
- **[I] index.js:95-112** — `spawnTerminal` 猴子补丁是当前唯一横切缝（已核实：shellEnv 只收 DSH_* 前缀；TerminalService 只有会抛 DUPLICATE_BACKEND 的 registerBackend；backend 的注入点是私有构造期接线）——但 **disposer 有真缺陷**：他人叠层补丁时强行还原 original，静默禁用叠加者。修法：仅当当前值是自己的包装时还原；并按 AGENTS §2b 向上游提"终端 env 贡献钩子"特性请求，而非无限期带补丁。
- **[Info·裁定] 替换 bash-sandbox 行 + 子类化 executor 本身合规**（dsh 自家 SandboxBashExecutor 同构；bash-local 的 env 叠层顺序与文档一致；`disabled: !!js` 是 Loader 钦定求值）。`additionalWritableRoots`/`registerWritableRoot` 是授权宿主目录的**另一种目的**，不优于 env 重定向设计。
- **[M] tests** — executor 子类零直测、真实缝（scrubbedParentEnv 合并、terminal-bash 传 cwd）未被 fake 覆盖。

### airboard (v0.2.3)
- **[I] index.js:256** — 硬编码第三方源回退（见 Top2）。
- **[I] index.js:229-238** — 状态文件三连违：跨实例共享单文件、单记录覆盖**销毁失败证据**（下一个挂载的 apply/tools-registered 抹掉 tools-failed）、把可能为包装对象的 config 值直接 JSON.stringify（catch 吞掉）。修法：按 profile 命名、追加/键控记录、嵌入前 readString。
- **[M] index.js:164-174** — 响应体全量缓冲后才检查 MAX_RESPONSE_BYTES（恶意源可先吃满内存）。先查 content-length / 流式截断。
- **[M] index.js:268-278** — legacy `token` 配置项热编辑不生效（挂载时冻结）。
- **[M] client.js:103** — `projectListCache` 模块级、跨重挂载不失效。
- **[M] client.js:563-572** — mr-binding 无键行被静默丢弃（计数/日志可满足规则）。
- **[Info] 大量核对通过**：webServer 路由/containment、defineTool/信号、SECTION_ORDERS 闭环表注、credentials 形状、slot 名、`!!js` 求值链、remote.credentials 的 `{ok,value}` 包装（真实消费方一致）。

## 方法与覆盖

- 三路并行审计（airboard+workspace-env / feishu+chrome-cdp / gitlab+engram），每路要求：通读插件全量源码+测试、对每条 API 断言给出 dsh 源码 file:line、无证据不立案。
- 覆盖盲区（各审计者自报）：两插件的 client.js UI 细节未逐行（feishu/chrome-cdp 路只读到依赖契约）；live-host 行为未驱动（只读审计）；engram 守护进程真实 HTTP 行为以插件镜像注释为准；airboard mr-binding 真实载荷未钉死（相关 finding 为建议级）；AGENTS.md §3 旧版真伪未考古（仅裁定当前版本）。
