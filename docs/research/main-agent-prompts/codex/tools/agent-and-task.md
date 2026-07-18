# Codex SubAgent 工具协议

## Spawn 输入

当前协作工具的模型可见参数：

```json
{
  "task_name": "bounded_task_name",
  "message": "self-contained child brief",
  "fork_turns": "none | all | positive integer string",
  "model": "optional explicit override",
  "reasoning_effort": "optional explicit override"
}
```

全历史 fork 继承父模型/effort，不能同时 override；只有 `none` 或有限 turn fork 才允许显式覆盖。模型/effort 通常只在用户明确要求时选择。

## Spawn 输出

启动返回 Agent id 和 canonical task path，之后 Agent 在独立 rollout 运行。完成消息进入父 Agent mailbox，包含 child 的 final answer/status；并不把全部 tool transcript 自动拼入父上下文。

公开工具协议没有强制所有 child final answer 使用统一 JSON 业务 schema。结构化部分是生命周期 envelope，具体 findings 通常是自由 Markdown/text，由 brief 约定输出格式。

## 运行中交互

| 工具 | 作用 |
|---|---|
| `send_message` | 给运行中或现有 Agent 投递消息，不触发新 turn |
| `followup_task` | 给 idle/completed Agent 新任务并触发 turn |
| `interrupt_agent` | 中断当前 turn，Agent 仍可继续复用 |
| `wait_agent` | 等待 mailbox update、完成或超时 |
| `list_agents` | 查看当前树和状态 |

主子交互因此是 mailbox/event 模式，不是两边同时写同一个 message array。

## 上下文与文件系统

子 Agent 上下文可选择不继承、有限继承或完整继承；文件系统始终共享。消息隔离不等于文件隔离。并行写任务必须按文件/模块分区，或使用宿主 worktree，而不是只给不同 task name。

## 返回格式建议

CodeZ 可要求 child 最终提交：

```json
{
  "conclusion": "...",
  "confidence": "high|medium|low",
  "findings": [],
  "files_examined": [],
  "unresolved": [],
  "budget": { "tool_calls": 0, "output_chars": 0 }
}
```

但应保留一个自由文本 fallback，防止 schema 解析失败吞掉有效结果。生命周期 metadata 与业务报告应分层保存。
