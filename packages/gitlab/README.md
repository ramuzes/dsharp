# dsh-gitlab

Agent-facing GitLab operations: REST API (MRs, issues, milestones, releases,
pipelines & schedules) plus token-injected git over HTTPS (clone/fetch/push/
pull, branch management, merged stale-branch cleanup). The token stays
host-side, so no per-call sandbox approvals are needed.

## Config

| Field | Default | Notes |
|---|---|---|
| `baseUrl` | `GITLAB_URL` env | GitLab instance root URL (self-hosted or gitlab.com). |
| Token (secret control) | `GITLAB_TOKEN` ref | Written to the dsh credential store, never echoed back. |
| `tokenEnv` | `GITLAB_TOKEN` | Credential-store reference name. |
| `apiTimeoutMs` | 20000 | REST request timeout. |
| `gitTimeoutMs` | 120000 | Per git-command timeout. |

## Behavior notes

- Git processes follow the **calling session's own sandbox policy**
  (`sandboxPolicy.resolve` + `sandbox.confine` — the same confinement bash
  uses); the plugin keeps no permission system of its own. Repo paths resolve
  against the session workspace root.
- Remote transport is HTTPS only (Basic-auth extraHeader via env, never in
  argv or on-disk config); ssh origins are rewritten on the fly for fetch.
- Branch deletion is merged-only: local `git branch -d` (never -D), remote
  deletes verified via the compare API first; no force-push.
- All output is redacted against the token and its base64 forms.

## Development

`node --test tests/*.spec.js`; follow the root AGENTS.md loop for live-host
verification. Mount stages land in `~/.dsh/gitlab-status.json`. After
browser-half changes verify the served boot graph via
`curl -N <host>/plugins/events` (see AGENTS.md §3). Chinese README:
`README.zh-CN.md`.
