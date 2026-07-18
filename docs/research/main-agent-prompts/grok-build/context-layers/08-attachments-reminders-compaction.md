# 08 附件、提醒与压缩

## Synthetic Reminders

Grok 可注入：

- Project instructions `<system-reminder>`。
- MCP server Full/Delta reminder。
- background task/subagent completion reminder。
- date rollover reminder。
- plan/goal/session lifecycle reminder。

它们通常是 synthetic/user context，不是模板原始 system 文本。

## Deferred Prefix

Session 可后台计算 `deferred_prefix`，在第一条 prompt 前注入；MCP handshakes 也可延后直到 templated prefix ready。日志应记录 prefix 生成时间和实际注入 turn。

## Compaction/Resume

源码提供 compact system prompt 与 user query extraction。Prefix 在 compaction 和 resume 时重建并重新写入当地日期；长会话跨午夜还会单独注入 date rollover reminder。

具体线上 summary 内容、服务端缓存和 token 阈值取决于 host/config。本次无真实 transcript，不能把源码能力描述成某次实际发生事件。

## 附件

图片、PDF、PPTX、Notebook 和 inline base64 image 可由 Read 转换为多模态 parts。媒体原始 bytes、模型可见压缩版本和 artifact reference 应分别记录。
