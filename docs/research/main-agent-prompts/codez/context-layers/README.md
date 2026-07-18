# CodeZ 上下文分层

CodeZ 当前没有独立 Developer message。产品政策、运行时上下文和项目规则大多进入 System；Skills 状态、压缩摘要、附件上下文和 durable history 则按 `build_model_context_items` 追加。

| 文件 | 内容 |
|---|---|
| `01-system.md` | 静态 System 基座及动态模块 |
| `02-developer-runtime.md` | 没有 Developer role 时运行时政策放在哪里 |
| `03-tools.md` | Provider tools、曝光和 schema |
| `04-project-rules.md` | 全局/工作区/目录规则 |
| `05-environment-permissions.md` | 环境、Provider、权限 |
| `06-skills-agents-mcp.md` | 三类扩展目录及当前接线状态 |
| `07-history-tool-results.md` | Ledger、历史和 tool protocol |
| `08-attachments-reminders-compaction.md` | 图片、skill/file context、压缩 |
| `09-current-request.md` | 当前用户消息的位置 |
| `10-resolved-request.md` | 最终 Provider request 的确定形状 |
