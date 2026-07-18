# OpenAI Codex 工具系统

## 证据边界

本目录使用两类证据：

1. 本机 rollout 中真实的 `custom_tool_call`、`function_call`、结果和 `session_meta.dynamic_tools`。
2. 当前 Codex Desktop 会话实际暴露给本 Agent 的工具契约。

本机没有 OpenAI 内部 Read/Edit/Grep 实现源码。Codex 当前工具面也不一定有独立 `Read`、`Edit`、`Grep`：本次桌面运行时主要通过 `exec` 编排 `exec_command`、`apply_patch` 等底层工具。文档只记录可观察契约，不推测隐藏实现。

## 当前工具分层

| 层 | 代表工具 | 作用 |
|---|---|---|
| 编排元工具 | `exec` | 在受限 JS isolate 中并发/组合底层工具调用 |
| Shell | `exec_command`、`write_stdin`、`wait` | 启动命令、交互、等待长任务 |
| 编辑 | `apply_patch` | 结构化文件 patch |
| 计划/目标 | `update_plan`、`create_goal`、`get_goal`、`update_goal` | 当前任务计划与持久目标 |
| 子智能体 | `spawn_agent`、`followup_task`、`send_message`、`wait_agent`、`interrupt_agent`、`list_agents` | 父子 Agent 协作 |
| MCP | resource list/read tools | 读取外部结构化资源 |
| App | `codex_app::*` | task/thread、automation、app terminal 等宿主能力 |
| 视觉 | `view_image` | 本地图片检查 |

`dynamic_tools` 只记录宿主动态 namespace；核心工具可能由运行时固定注入，因此不能把该字段当作完整 tool catalog。

## 文件

- `read-search.md`：通过 shell/rg 的读取与搜索契约，以及缺失的内部保证。
- `edit.md`：`apply_patch` 的可见协议、真实 rollout 调用和边界。
- `shell.md`：`exec`、`exec_command`、长任务 session 和 PowerShell 分类问题。
- `agent-and-task.md`：SubAgent 输入/输出、mailbox、follow-up 和等待。
- `planning-and-extensions.md`：plan/goal、MCP、App thread 和其他工具。
- `runtime-evidence.md`：rollout 能保存什么、不能保存什么。

## 版本差异

工具 catalog 会随 Codex CLI/Desktop 版本、插件、MCP、skills、permission profile、collaboration mode 和宿主功能变化。任何“完整工具列表”都必须带 session/version 快照。
