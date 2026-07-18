# 主 Agent 看到的 `task` 工具

证据等级：B，来源为 `crates/common/xai-tool-types/src/task.rs` 和 `crates/codegen/xai-grok-tools/src/implementations/grok_build/task/`。

## 动态描述

`build_task_description()` 将有效 Agent 目录渲染为：

```text
Start a subagent that works on a task independently and reports back.

Agent types:

- **general-purpose**: General purpose agent for multi-step tasks. Has access to all tools: ...
- **explore**: Fast, read-only agent specialized for codebase exploration. Read-only — has access to: ...
- **plan**: Software architect for planning implementation strategies. Read-only — has access to all tools except file editing: ...

## Usage notes
- When the agent is done, it returns a single message with its agent ID. Use that ID to resume the agent later for follow-up work.
- run_in_background: Returns immediately with a subagent_id. Use get_task_output to retrieve results. This is set to true by default.
- Subagents receive a compacted version of project instructions (AGENTS.md). If the task requires detailed conventions (e.g., build rules, testing patterns), include the relevant rules directly in the prompt.
- When using the task tool, you must specify a subagent_type parameter to select which agent type to use.

Resuming a previous agent (resume_from):
- Use resume_from to continue a previously completed subagent's conversation. Pass the subagent_id returned by a prior task call. A resumed agent keeps its full transcript and tool state, so you only need to describe what changed since the last run — don't re-explain the original task.
- The resumed agent must use the same subagent_type as the source.

Isolation mode:
- Use isolation to control the child's execution environment. With "worktree", the child runs in an isolated git worktree whose edits don't affect the parent workspace; the worktree is preserved after completion and its path is returned in the output.
```

具体工具名和参数名可以按产品配置改名，上面是 canonical 名称的展开。

## 输入 schema

| 字段 | 类型 | 默认 | 规则 |
|---|---|---|---|
| `prompt` | string | 必填 | 完整、可独立执行的子任务 brief |
| `description` | string | 必填 | 3 到 5 个词 |
| `subagent_type` | string | `general-purpose` | built-in 或用户定义类型 |
| `run_in_background` | bool | `true` | 后台时立即返回 ID |
| `capability_mode` | enum | 由角色决定 | `read-only`、`read-write`、`execute`、`all` |
| `isolation` | enum | `none` | `none` 或 `worktree` |
| `resume_from` | string | 无 | 同父 session、已完成、同类型 |
| `cwd` | string | 无 | 必须存在且为目录；与 worktree 互斥 |
| `model` | string | 继承父模型 | 只应响应用户显式要求；resume 时忽略 |

## 核心执行算法

```text
检查 depth < 1
-> 清洗 resume/model/cwd 哨兵值
-> 校验 cwd/worktree 互斥和 cwd 存在性
-> 向 coordinator 预校验 subagent_type
-> 校验显式 model
-> 生成 UUIDv7 task id
-> 构造 SubagentRequest
-> 后台：tokio::spawn 后立即返回 id
-> 前台：等待 coordinator；超预算则自动转后台
-> 成功：返回 output + id/type/tool_calls/turns/duration/worktree
```

Coordinator 通过 `SubagentBackend` trait 隔离。当前实现是 in-process `tokio::mpsc` + `oneshot`；类型校验超时默认 2 秒。查询、取消和类型描述使用同一 backend。

## 值得借鉴与不足

值得借鉴的是 Agent 目录、能力、隔离、persona 和模型均正交；恢复操作保留原上下文但重新渲染当前策略。需要补强的是主 Agent 描述没有像 Claude 那样列出明确的 “When NOT to use”，因此仅凭此工具说明仍可能为简单任务过度委派。

还有一处版本漂移：工具描述写“compacted version of project instructions”，而当前 `PromptContext::agents_md_user_reminder()` 源码与测试要求主、子会话收到完整 AGENTS.md block。报告同时保留这两项事实，不能用工具文案替代实际执行路径。
