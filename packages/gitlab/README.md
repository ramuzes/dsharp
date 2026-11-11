# dsh-gitlab

面向 agent 的 GitLab 工具插件（Host 半件，无浏览器半件）：把 GitLab 的日常操作变成
一组显式命名的工具 —— REST API（MR、Issue、里程碑、版本、流水线与定时流水线）加
上注入令牌的 HTTPS git（clone / fetch / push / pull、本地分支管理、rebase /
cherry-pick、已合并陈旧分支清理）。

解决的问题：在 dsh 的工作区权限限制下，会话 shell 里跑 `glab` 或带凭据的 `git`
每次都要请求网络与授权；本插件把这些操作放进 Host 进程执行，令牌只存在于 Host 内，
工具结果中永不出现，从而一次配置、全程免弹窗。

## 安装

```sh
dsh plugin --profile <name> add dsh-gitlab          # 从索引安装
dsh plugin --profile <name> add ./dsh-gitlab-0.1.0.tgz
dsh plugin --profile <name> add github:ramuzes/dsharp#path:packages/gitlab
```

## 配置（Plugins 页 / 配置层）

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `GITLAB_URL` 环境变量 | GitLab 实例地址（自建或 gitlab.com）。 |
| `tokenEnv` | `GITLAB_TOKEN` | 凭据引用名。令牌本身写入 dsh 凭据存储（Plugins 页密钥控件），或由启动环境 `GITLAB_TOKEN` 提供；永不落入 patch 层。 |
| `apiTimeoutMs` | 20000 | REST 请求超时。 |
| `gitTimeoutMs` | 120000 | 单条 git 命令超时。 |

Reload semantics：以上字段全部 volatile，Plugins 页编辑实时生效（baseUrl 快照在下次
重载后更新）。令牌热更新：凭据写入触发 `credentials/reference-updated` 即时重解析。

## 工具面（38 个）

- **仓库/远端**：`gitlab_repo_info`、`gitlab_git_clone/fetch/push/pull`
- **本地分支与历史**：`gitlab_git_status/log/checkout/branch/rebase/cherry_pick/merge/tag`
- **陈旧分支清理**：`gitlab_stale_branches`、`gitlab_delete_branch`
- **流水线**：`gitlab_pipeline_trigger/list/get/cancel/retry`、`gitlab_job_get`（日志尾部）、`gitlab_schedule_list/create/update`
- **MR**：`gitlab_mr_create/list/get/update/comment/reviews`
- **Issue/里程碑/版本**：`gitlab_issue_create/list/get/update`、`gitlab_milestone_list/create`、`gitlab_release_create/list`

## 安全基线

- 令牌只存在于 Host 进程：REST 走 `PRIVATE-TOKEN` 头，git 走每条命令注入的
  `http.extraHeader`（Basic auth），不落盘、不进仓库 remote、不进工具输出（输出对
  令牌原文与其 base64 形式做了统一消毒）。
- **git 权限完全跟随会话**：每次调用经 `ctx.sandboxPolicy.resolve({ session })` 取
  发起会话自己的权限配置（`workspace-write` / `read-only` / `danger-full-access`），
  非全权限模式下 git 进程由 `ctx.sandbox.confine` 以同一套沙箱约束执行——与该会话的
  bash 完全同边界，插件不自设任何路径白名单；沙箱拦截时会明确提示是会话策略所致。
- git 远端传输仅 HTTPS；SSH remote 在 fetch 时即时改写为 HTTPS，push 需要仓库先配置
  https origin。
- **分支删除只允许已合并**：本地 `git branch -d`（永不 -D），远端删除前经 compare API
  验证分支无未合并提交，默认分支与受保护分支一律拒绝；push 无 force。
- 无审批门（设计决策）：信任 agent，权限边界由 token 作用域与上述硬性拒绝承担。

## 开发

`node --test tests/*.spec.js`（严格 fake）；改动后按 AGENTS.md 循环在专用 profile 的
真实 host 上验证。挂载阶段记录在 `~/.dsh/gitlab-status.json`（`GITLAB_STATUS_FILE`
可覆盖）：apply → tools-inject → tools-registered / tools-failed。

含浏览器半件的改动（配置卡）额外验证 boot graph：`curl -N http://127.0.0.1:3080/plugins/events`
的 `entries` 里必须出现 `dsh-gitlab`；缺失时用 plugin_manager 对该行 disable→enable
强制 clientModules 重组（见 AGENTS.md §3 的 dsh-gitlab 0.1.1 事故记录），再刷新页面。

## Live-host verification (AGENTS.md loop)

- 2026-11-11 · dsh-gitlab 0.1.0 · 专用测试 profile 安装 tgz，host 启动后
  `~/.dsh/gitlab-status.json` 报 `tools-registered`（38 个工具 + prompt section），
  `Tool.listTools` 可见 `gitlab_repo_info` 等工具，host 无 fatal/crash。（详见仓库根
  验证记录。）
