# Claude Code Agent、Task 与 Todo 工具

## `Agent`

`AgentTool` 的 schema 包含独立 task prompt、简短 description、`subagent_type`，并按入口/feature 支持后台、resume/fork/worktree 等变化。主模型看到的 Agent 列表来自动态目录，内置类型和完整提示词已记录在 `../subagents/`。

核心原则：

- 简单定向搜索直接使用 Glob/Grep。
- Explore 适合需要多轮、预计超过约 3 次查询的开放式代码定位。
- Agent brief 必须自包含，不能假设子 Agent 能看到所有父上下文。
- 主 Agent 负责综合和最终答案，不能把“理解需求”整体委派出去。
- 多个 Agent 只有在任务相互独立时才应并行。

## 后台 Agent 与结果

后台 Agent 注册为 task state。旧 `TaskOutputTool` 可用 `task_id` 阻塞或非阻塞查询，轮询间隔约 100 ms；当前源码把它标为 deprecated，优先 Read 后台任务的 output file。对 local Agent，结果读取优先使用内存里的最终 assistant 文本，而不是把完整 JSONL transcript 当结果返回。

## Durable Task 工具

| 工具 | 主要输入/作用 |
|---|---|
| `TaskCreate` | subject、description、active form、metadata/依赖 |
| `TaskGet` | 读取单个 task |
| `TaskList` | 列出任务状态和依赖 |
| `TaskUpdate` | subject/description/status/owner/blocks/blockedBy/metadata |
| `TaskStop` | 停止后台 task |
| `TaskOutput` | 获取 shell/agent/remote task 输出，已弱化 |

`TaskUpdate.status` 支持完成、进行中等状态，并额外把 `deleted` 作为动作。团队模式还会处理 owner/mailbox/hooks。

## `TodoWrite`

输入是完整 todo list，不是单项 patch。状态全部 completed 时运行时把列表清空。Todo 以 `agentId` 或 session ID 分区，子 Agent 与主 Agent 不共享同一 checklist key。

feature-gated verification 逻辑会在主线程关闭 3 个以上 todo 且没有 verification 项时，在 tool result 中追加 verifier nudge。这说明 Task/Todo 工具本身也会注入行为提示，不能只分析主 system prompt。

## 关键产品结论

Task 是进度数据，Agent 是计算实例。创建 4 个 Task 不应自动派发 4 个 Agent；一个 Agent 可覆盖多个相关 Task，一个 Task 也可由主 Agent完成。
