# 05 环境与权限

## Environment Context

选定 rollout 在实际任务前有独立 user-role `environment_context`，包含 cwd、shell、日期、时区、workspace roots、filesystem permission profile 和 Git 信息。它是 Codex 对“首条 user prefix”的近似实现，但与真实 user task 分成两条记录。

## Turn Context 与 World State

Rollout 还保存：

- model、reasoning effort、context window。
- approval/sandbox/runtime override。
- Git branch/commit 和工作区状态。
- skills/plugins/environment resolved state。

`world_state` 和 `turn_context` 是运行时日志结构，不保证逐字作为普通 user message 发送；应分别标记 `logged_state` 和 `model_message`。

## 权限

选定样本：`sandbox_mode=danger-full-access`、network enabled、`approval_policy=never`，并禁止传 escalation 参数。子 Agent 继承父 turn 的 live sandbox/approval override。

## PowerShell 分类

权限日志必须区分：模型请求、parser/classifier decision、授权结果和 process start。`shellunparsed` 表示命令未执行，不是业务命令返回非零。编码 bootstrap 应由可信 runtime 注入，不与业务命令共同分类。
