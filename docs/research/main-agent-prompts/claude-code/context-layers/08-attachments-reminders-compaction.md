# 08 附件、提醒与压缩摘要

## 动态附件类型

真实 transcript 和源码可确认：

- `agent_listing_delta`
- `skill_listing`
- `command_permissions`
- `task_reminder`
- `queued_command`
- CLAUDE.md/rules `<system-reminder>`
- 图片/用户文件 content block
- 外部文件变化 attachment
- compact summary 与 post-compact file attachments

这些内容常以 user role 或 attachment 进入，但其中 `<system-reminder>` 仍是运行时生成的高权重提示；role 名称不能完整表达来源。

## Compact

传统完整 compact：生成 summary，清空/重建部分客户端状态，再从文件状态候选中选择最多 5 个文件重新 Read 磁盘最新版。选择依据通常是 mtime，不是真实访问时间。

Microcompact：清除较老 tool result 内容，保留 tool_use 结构。若 Read unchanged stub 仍引用已清除内容，客户端必须确保两种机制一致。

## Queued/Reminder

用户在模型工作期间发送的新消息可能先成为 queued command，再进入下一轮。Task/background completion 也可用 reminder 唤醒主循环。日志必须记录注入时机和目标 turn，不能只按创建时间排序。
