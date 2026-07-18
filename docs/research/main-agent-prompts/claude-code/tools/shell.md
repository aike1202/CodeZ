# Claude Code `Bash` / `PowerShell`

来源：`src/tools/BashTool/`，重点是 `BashTool.tsx`、`bashPermissions.ts`、`bashSecurity.ts`、`readOnlyValidation.ts`、`pathValidation.ts`、`shouldUseSandbox.ts`。Windows 还有独立 `PowerShellTool` 与 parser/classifier 路径。

## Bash 输入 schema

| 字段 | 类型 | 说明 |
|---|---|---|
| `command` | string | 必填业务命令 |
| `timeout` | number，可选 | 毫秒，受运行时最大值约束 |
| `description` | string，可选 | 面向用户的简短动作描述 |
| `run_in_background` | bool，可选 | 后台运行；feature 关闭时不出现在 schema |
| `dangerouslyDisableSandbox` | bool，可选 | 请求绕过 sandbox，仍受 policy/approval |

内部 `_simulatedSedEdit` 被显式从模型 schema 删除，防止模型伪造预览结果绕过权限。

## Prompt 级工具路由

Bash prompt 要求：文件发现用 Glob、内容搜索用 Grep、读文件用 Read、编辑用 Edit、整文件写入用 Write，沟通直接输出文本。Shell 保留给系统命令、Git、构建、测试和没有专用工具的操作。

## 安全/权限核心流程

恢复源码的实际流程比“判断只读命令”复杂得多：

```text
schema + sleep/background 基础校验
-> hooks/permission mode 与显式 Bash 规则
-> tree-sitter AST 安全解析；不可用时 legacy splitter/regex
-> compound command / pipe / redirection 分析
-> 每个 subcommand 的 deny/ask/allow 决策
-> 原始命令重做输出重定向路径检查
-> cd+git、cd+write、process substitution 等组合防护
-> exact/prefix allow 规则和注入安全复核
-> 可选 classifier pending check
-> sandbox 选择与执行
```

明确的 deny 规则优先于路径检查产生的 ask。源码特别修复了 split 后重定向丢失问题：即使每个管道段看似允许，也必须在原始命令上重新校验 `>`, `>>` 等目标路径。

## AST 与 fail-closed

优先使用 tree-sitter 解析 shell 结构并提取 subcommands、commands 和 redirects。AST 不可用时走 legacy splitter 和约 20 类安全检查；legacy 拆分超过 50 个子命令时直接 ask，避免解析复杂度和事件循环耗尽。不能证明安全时的默认是 ask，而不是 allow。

高风险组合包括：

- 同一 compound command 有多个 `cd`。
- `cd` 与 Git 组合，防止恶意 bare repo 配置执行。
- `cd` 后写入敏感配置目录。
- 重定向目标含 command substitution/backticks。
- wrapper、env assignment、引号或 xargs 隐藏真正命令。

## Read-only 不是字符串白名单

`readOnlyValidation.ts` 会考虑命令及子命令、参数、管道、重定向和 Git 子命令。一个 `cat`/`printf` 出现在写重定向前并不使整个命令只读。对复合命令必须所有相关部分都满足只读条件。

## 后台和输出

`run_in_background` 返回 task ID 和输出文件路径；完成通知避免模型轮询。Assistant mode 对长阻塞命令可自动转后台，`sleep >= 2s` 作为首命令在 Monitor feature 下会被阻止。大输出持久化到 tool-results，inline 结果只保留预算内内容。

## 与用户日志中的授权失败

日志里把 UTF-8 初始化和业务命令拼成一段 PowerShell 文本，分类器无法完整解析，产生 `shellunparsed` 并要求授权，命令实际没有执行。设计上应把可信的编码初始化放进 runtime shell bootstrap，权限分类器只接收 `npm run typecheck` 之类的业务 AST；编码前缀不应由模型每次重复生成。
