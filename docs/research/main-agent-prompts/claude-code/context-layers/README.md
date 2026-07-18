# Claude Code 完整上下文分层

本目录记录一次 Claude Code 模型请求中除基础 system prompt 之外的全部重要逻辑层。选定真实 transcript 为 2.1.197；隐藏 system 与工具 schema 使用恢复源码 revision `b78dd22a091b717c8938ab98c736bc04825a8ee8` 重建。

## 九层索引

| 层 | 文件 | 证据 | 模型可见性 |
|---:|---|---|---|
| 1 | `01-system.md` | 源码重建 B/C | 可见 |
| 2 | `02-developer-runtime.md` | 源码 + transcript B/C | 可见，但没有独立 developer role |
| 3 | `03-tools.md` | 工具源码 B | schema/description 可见；内部状态不可见 |
| 4 | `04-project-rules.md` | 源码 + transcript B/C | 以 system 动态段或 reminder 可见 |
| 5 | `05-environment-permissions.md` | 源码 + transcript A/B | 部分可见，执行状态部分不可见 |
| 6 | `06-skills-agents-mcp.md` | transcript A + 源码 B | 目录和已加载正文可见 |
| 7 | `07-history-tool-results.md` | transcript A | 可见，直到清理/compact |
| 8 | `08-attachments-reminders-compaction.md` | transcript A + 源码 B | 动态可见 |
| 9 | `09-current-request.md` | transcript A | 可见 |

`10-resolved-request.md` 将九层合并成一个协议中立的完整逻辑请求，并明确哪些字段只是运行时控制状态。

## 关键边界

Claude transcript 不保存隐藏 system prompt 和完整 tools array，因此不能生成 byte-complete HTTP body。这里的“完整”指所有逻辑层、装配顺序、来源和可见性完整；逐字无法恢复的层使用内容引用和 evidence 标记。
