# Grok Build 完整上下文分层

本目录基于源码 revision `8adf9013a0929e5c7f1d4e849492d2387837a28d`。未找到同 revision 本机真实 runtime transcript，因此模板和算法为 B，完整请求为 source-derived D。

## 九层索引

| 层 | 文件 | 形态 |
|---:|---|---|
| 1 | `01-system.md` | MiniJinja system template |
| 2 | `02-developer-runtime.md` | 没有固定 developer role；分布式运行时层 |
| 3 | `03-tools.md` | finalized ToolRegistry definitions |
| 4 | `04-project-rules.md` | AGENTS/Claude rules reminder |
| 5 | `05-environment-permissions.md` | user prefix + runtime capabilities |
| 6 | `06-skills-agents-mcp.md` | catalogs/reminders/dynamic tools |
| 7 | `07-history-tool-results.md` | conversation + tool outputs |
| 8 | `08-attachments-reminders-compaction.md` | synthetic reminders/compact/resume |
| 9 | `09-current-request-and-prefix.md` | `<user_info>`、VCS、`<user_query>` |

`10-resolved-request.md` 合并以上各层。

## 重要边界

源码可以确定渲染算法，但不能证明某个线上 host 当时启用了哪些 tools、plugins、MCP、rules 或 feature flags。所有实例值必须标为模拟或宿主配置快照。
