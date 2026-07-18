# 02 Developer 与运行时指令

## 没有独立 Developer Role

选定 Claude Code transcript 使用 Anthropic 风格的 system/messages/tool 协议，没有 Codex 那种单独 `role=developer` 记录。功能等价的运行时指令分布在：

这里没有遗漏一段可复制的 Developer 原文：选定 JSONL 中不存在这种 role，源码装配也没有生成一条固定 Developer message。强行补一段正文会把分析伪装成日志证据。

- system prompt 的 `session_guidance`、output style、language、token budget、brief 等动态段。
- 每个工具的 description/prompt。
- user-role attachment 或 `<system-reminder>`。
- permission hook、mode 和 feature flag 对工具 catalog/执行器的裁剪。

因此“Claude Developer Prompt”不能被记录成一个并不存在的固定字符串。

## 运行模式

| 模式 | 上下文影响 |
|---|---|
| Simple | system 缩减为身份、cwd 和日期 |
| Proactive/Kairos | 使用 autonomous identity/work sections、brief 和提醒 |
| Coordinator | system 替换为调度/综合职责，worker 承担执行 |
| Custom main agent | agent prompt 可替换默认 system |
| Plan mode | 工具面和 reminders 转为只读探索/计划提交 |

## 动态开关

Feature flags 可控制 Explore/Plan/Verification、background Agent、cached microcompact、function-result clearing、MCP delta、scratchpad 等。最终请求若不记录 feature snapshot，只保存 prompt 文本仍难以复盘为什么某工具出现或消失。

## 优先级

用户显式要求仍受最高层安全/system 约束；项目规则低于 system/显式用户要求。工具权限和 sandbox 是执行时硬边界，即使模型文本要求执行，也可能被 deny/ask 阻止。
