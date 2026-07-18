# Grok Build `task`、`get_task_output` 与 `kill_task`

子智能体完整 prompt 和目录见 `../subagents/`。本页聚焦工具协议。

## Spawn 输入

```json
{
  "prompt": "self-contained task brief",
  "description": "3-5 word summary",
  "subagent_type": "explore",
  "run_in_background": true,
  "capability_mode": "read-only",
  "isolation": "none",
  "resume_from": null,
  "cwd": null,
  "model": null
}
```

`run_in_background` 默认 true，`subagent_type` 省略时 Rust 类型默认 general-purpose，但动态工具描述同时要求主模型明确指定类型。

## Spawn 返回

后台立即返回：

```text
Subagent started in background.
subagent_id: <id>
type: <type>
description: <description>
Use get_task_output with task_ids=["<id>"] ...
```

完成返回 envelope：

```json
{
  "output": "child final writeup",
  "subagent_id": "...",
  "subagent_type": "explore",
  "tool_calls": 12,
  "turns": 4,
  "duration_ms": 18000,
  "worktree_path": null,
  "resume_from_hint": "..."
}
```

模型可见文本还附加 `<subagent_meta>` 和 `<subagent_result>`，明确如何恢复。

## `get_task_output`

输入 `task_ids: string[]`，`timeout_ms` 省略或 0 时非阻塞快照；正数时等待，多 ID 为 wait-all。一次最多 20 个 ID，阻塞上限默认约 10 分钟。它先查 Terminal task，再查 SubagentBackend；大输出返回 output file 并建议 Read。

## `kill_task`

统一终止 bash、monitor 或 subagent。Unix 命令走 signal/process group，Windows 走 Job Object；subagent 走 Cancel+Shutdown。已经结束也可返回成功语义，便于幂等清理。

## 主子交互

主 Agent 与 child 不共享实时 message list。交互路径是：

```text
task(prompt) -> child 独立 session
background completion notification / get_task_output
-> child final output 回到主 Agent tool result
-> resume_from=<id> 创建继续会话
```

Grok 没有在这个协议中提供通用的运行中任意 mailbox 消息工具；主要依靠启动 brief、状态查询、取消和完成后的 resume。
