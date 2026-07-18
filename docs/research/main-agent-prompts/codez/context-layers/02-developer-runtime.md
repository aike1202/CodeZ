# 02 Developer 与运行时指令

## 结论

CodeZ 当前 Provider 请求没有单独的 `developer` role。所谓 Developer/运行时层被分散在以下位置：

1. 主 System Prompt 的 Engineering、Editing、Verification、Communication。
2. 动态 System Prompt 的环境、权限、规则、skills、工具和任务策略。
3. 工具 schema 的 description、JSON Schema、exposure、effect planning 和 permission pipeline。
4. 子 Agent 的 `agent_system_addendum`。
5. 不进入模型上下文、但由宿主强制执行的上限、取消、授权和 workspace authority。

## 模型可见的运行时原文

```text
# Context continuity

Conversation history may be summarized as it grows. Preserve the current objective, completed and pending work, modified files, decisions, and blockers. After a context trim, continue from the summary without repeating completed work and re-read source needed for the next change.
```

当 `update_resume_state` 可见时还会追加：

```text
When warned that context is being trimmed, use `update_resume_state` to persist the active objective and handoff state.
```

当前 Rust catalog 没有 `update_resume_state`，所以第二段不会出现。

任务工具可见时追加：

```text
# Task tracking

Task tools are optional bookkeeping. Use them when substantial work benefits from durable progress tracking or has meaningful dependencies. Do not create a task list for a simple request merely because it contains several actions or files. If you use tasks, keep statuses current and continue through executable work without repeatedly asking whether to proceed.
```

委派门控成功时理论上追加：

```text
# Subagents

Use a subagent when a specialist matches the work, independent tasks can run in parallel, or substantial intermediate output is better kept out of the main context. Do the work directly for simple requests, directed lookups, or tightly sequential changes. File count alone is never a reason to delegate.

Understand the task before delegating, give the subagent a self-contained brief, and do not duplicate its work. The parent remains responsible for interpreting the result, resolving failures, and completing the user's request.
```

但当前门控只查 `SubAgentRunner` 或 `DelegateTasks`，不会因真实的 `spawn_agent` 开启，因此最后这段在当前主会话中缺失。

## 模型不可见但宿主强制执行

```yaml
max_provider_tool_calls_per_response: 32
max_tool_rounds_per_run: 64
max_active_agent_attempts: 8
max_agents_per_session: 200
max_agent_messages_per_session: 512
max_chat_input_bytes: 1048576
max_agent_message_bytes: 131072
max_agent_context_bytes: 262144
context_preparation_attempts: 2
```

这些不是 prompt 文本，但会实际拒绝、取消或截断行为。工具 capability 不等于授权：模型即使构造隐藏工具调用，也会在 exposure/validation/permission 阶段被拒绝。
