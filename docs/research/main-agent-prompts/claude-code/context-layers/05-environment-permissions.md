# 05 环境与权限

## 环境内容

默认 system 动态段可包含 cwd、平台、日期、shell、Git/仓库信息和语言设置。真实 transcript 还保存 `cwd`、`gitBranch`、`permissionMode`、`version` 和 `entrypoint` metadata。

选定样本：

```yaml
cwd: F:\MyProjectF\CodeZ
git_branch: main
permission_mode: bypassPermissions
entrypoint: claude-desktop-3p
runtime_version: 2.1.197
```

## 权限内容

- Tool allow/deny/ask rules。
- `command_permissions` 动态 attachment。
- 文件路径、Bash 子命令、重定向和 network/sandbox 限制。
- 用户本轮批准、拒绝或修改后的 permission context。

## 模型可见与硬执行

模型可能看到 sandbox/权限说明和 permission result，但规则匹配、AST 安全解析、path constraint 和 sandbox enforcement 在运行时执行。`bypassPermissions` 也不等于所有安全检查、工具 schema 和平台限制消失。

## 日志要求

需要保存 effective permission mode、匹配规则来源、决策 `allow/ask/deny`、解析结果、sandbox 是否启用和命令是否真正启动。只记录模型发出的 Bash 文本无法判断测试是否执行。
