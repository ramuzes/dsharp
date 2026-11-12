# dsh-gitlab

面向 agent 的 GitLab 操作工具：REST API（MR、Issue、里程碑、版本、流水线与定时
流水线）加注入令牌的 HTTPS git（clone/fetch/push/pull、分支管理、已合并陈旧分支
清理）。令牌只存在于宿主进程内，全程无需逐次授权。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `GITLAB_URL` 环境变量 | GitLab 实例地址（自建或 gitlab.com）。 |
| 访问令牌（密钥控件） | `GITLAB_TOKEN` 引用 | 写入 dsh 凭据存储，永不回显。 |
| `tokenEnv` | `GITLAB_TOKEN` | 凭据引用名。 |
| `apiTimeoutMs` | 20000 | REST 超时。 |
| `gitTimeoutMs` | 120000 | 单条 git 命令超时。 |

## 行为要点

- git 进程**完全跟随发起会话的沙箱策略**（与该会话的 bash 同边界），插件不自设
  权限；仓库路径基于会话工作区根解析。
- 远端仅 HTTPS（Basic 认证头经环境变量注入，不进 argv 与磁盘配置）；SSH origin
  在 fetch 时即时改写。
- 分支删除仅限已合并：本地 `git branch -d`（永不 -D），远端删除先经 compare API
  验证；无 force push。
- 所有输出对令牌及其 base64 形式统一消毒。

## 开发

`node --test tests/*.spec.js`；按仓库根 AGENTS.md 的循环做真实 host 验证。挂载
阶段记录在 `~/.dsh/gitlab-status.json`。浏览器半件改动后用
`curl -N <host>/plugins/events` 验证 boot graph（见 AGENTS.md §3）。
