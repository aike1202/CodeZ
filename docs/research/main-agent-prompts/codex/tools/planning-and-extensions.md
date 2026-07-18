# Codex 计划、目标与扩展工具

## `update_plan`

输入是完整计划数组，每项包含 `step` 和 `pending/in_progress/completed`；同一时刻最多一个 in-progress。它是当前任务的协作 UI 状态，不应自动触发 Agent 或持久 Goal。

## Goal

`create_goal/get_goal/update_goal` 管理跨 turn 的持久目标、预算和 complete/blocked。只有用户或系统明确请求 Goal 时创建；`update_goal` 只用于真正完成或满足严格重复阻塞条件。

## MCP Resources

`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` 读取 server 暴露的结构化资源。优先使用 resource/template 而不是通过 shell/web 猜测同一数据。MCP tool catalog 随 server 配置动态变化。

## Codex App 工具

本机 `session_meta.dynamic_tools` 保存 `codex_app` namespace，包括 automation、thread list/read/send、pin/archive/title 等。大 schema 可以 `deferLoading`，说明动态工具目录不必全量进入首轮 prompt。

创建用户可见 task/thread 与当前 turn 内部子 Agent 是两个概念：前者进入侧边栏，由用户继续；后者用协作工具完成当前请求。

## App Terminal 与视觉

`codex_app__read_thread_terminal` 读取当前 app terminal；`view_image` 加载本地图片。文档/表格/幻灯片还可通过 workspace dependency runtime 和对应 skills 扩展，但这些不是每次 session 的固定 core tools。
