# 四个平台 SubAgent 输入、输出与主子交互

## 结论

三个平台都有结构化的“启动输入”和“生命周期输出”，但子 Agent 的业务报告通常是自由文本/Markdown。也就是说：

```text
强类型 envelope + 自由文本 payload
```

它们都不是让主 Agent 和子 Agent 共享同一个实时聊天上下文。子 Agent 有独立 session/transcript；主 Agent 通过 tool call、完成事件、状态查询、mailbox 或 resume/follow-up 与之交互。

## 总览

| 平台 | 启动工具 | 核心输入 | 完成输出 | 运行中交互 | 继续同一 Agent |
|---|---|---|---|---|---|
| Claude Code | `Agent` | prompt、description、type、model、background、isolation/cwd；team 模式另有 name/team/mode | `completed` + agent result，或 async ID/output file；team 返回 teammate metadata | task notification、TaskOutput、`SendMessage`/mailbox | Agent resume/fork 或对 teammate 发消息 |
| Codex | `spawn_agent` | task_name、message、fork_turns、可选 model/effort | Agent id/path，完成后 mailbox final/status | `send_message`、`wait_agent`、`interrupt_agent` | `followup_task` |
| Grok Build | `task` | prompt、description、type、background、capability、isolation、resume、cwd、model | output + id/type/tool_calls/turns/duration/worktree | completion notification、`get_task_output`、`kill_task` | `resume_from` |
| CodeZ | `spawn_agent` | role、taskName、message、context、expectations、scope、depth、write/shell fields | AgentRecord；终态 mailbox report + optional conclusion | `send_message`、`wait_agent`、root auto-wait、`interrupt_agent` | `followup_task` |

## Claude Code

### 输入

```json
{
  "description": "3-5 word task",
  "prompt": "complete task brief",
  "subagent_type": "Explore",
  "model": "haiku|sonnet|opus",
  "run_in_background": true,
  "isolation": "worktree",
  "cwd": "/absolute/path",
  "name": "optional teammate name",
  "team_name": "optional team",
  "mode": "optional teammate permission mode"
}
```

字段会受 feature gate 裁剪；`cwd` 与 worktree 互斥。普通 subagent 不需要 name/team，带 name 和 team context 时走 teammate 分支。

### 输出

同步完成是 discriminated union 的 `status="completed"`，包含 prompt 和 agent result。异步启动：

```json
{
  "status": "async_launched",
  "agentId": "...",
  "description": "...",
  "prompt": "...",
  "outputFile": "...",
  "canReadOutputFile": true
}
```

team 模式内部还返回 teammate id/name/model/tmux/team 等 metadata。业务答案仍主要是子 Agent 最终文本。

### 交互

普通后台 Agent 完成后产生 task notification，主 Agent 可 Read output file；旧 TaskOutput 可查询。Coordinator/team 模式可用 `SendMessage` 和 mailbox 给指定 teammate 发消息。父 Agent 不应持续轮询，完成通知负责重新唤醒。

## OpenAI Codex

### 输入

```json
{
  "task_name": "frontend_lint",
  "message": "self-contained task brief",
  "fork_turns": "none|all|N",
  "model": "optional",
  "reasoning_effort": "optional"
}
```

`fork_turns` 决定复制多少父对话；它不改变共享文件系统。全历史 fork 继承父 model/effort。

### 输出

spawn 返回 Agent id/canonical task path。Agent 完成时，父 mailbox 收到 final/status notification。当前工具没有要求 final answer 必须符合统一 JSON findings schema，所以主 Agent 的 brief 应明确要求需要的字段。

### 交互

```text
spawn_agent -> 独立 child rollout
send_message -> 投递信息，不主动触发 idle turn
followup_task -> 对已有 Agent 发新任务并触发 turn
interrupt_agent -> 停止当前 turn，保留 Agent
wait_agent -> 等 mailbox/完成/超时
```

这是最完整的运行中 mailbox 模型。父 Agent 负责等待和综合，子 Agent 只返回证据摘要。

## Grok Build

### 输入

```json
{
  "prompt": "complete task brief",
  "description": "3-5 word task",
  "subagent_type": "general-purpose|explore|plan|custom",
  "run_in_background": true,
  "capability_mode": "read-only|read-write|execute|all",
  "isolation": "none|worktree",
  "resume_from": null,
  "cwd": null,
  "model": null
}
```

### 输出

```json
{
  "output": "child final writeup",
  "subagent_id": "...",
  "subagent_type": "explore",
  "tool_calls": 8,
  "turns": 3,
  "duration_ms": 12000,
  "worktree_path": null,
  "resume_from_hint": "..."
}
```

模型文本还带 `<subagent_meta>` 和 `<subagent_result>`。后台启动只返回 ID/type/description 和查询提示。

### 交互

主 Agent 通过 `get_task_output(task_ids, timeout_ms)` 获取 snapshot 或等待完成，通过 `kill_task` 取消。完成后使用 `resume_from` 延续原 transcript/tool state。当前 task 协议没有 Codex/Claude team 那种通用运行中任意消息 mailbox。

## CodeZ 当前事实

当前 Durable Agent 输入是严格 JSON Schema，角色只有 Explore/Reviewer。Child 的首条 user message 是 durable mailbox payload；System 为完整主 Prompt 加 role addendum。Explore 有 8 个只读/协作工具，Reviewer 增加 2 个受白名单限制的 shell 工具。

Runtime 强制终态结构目前只有：

```json
{ "report": "string", "conclusion": "optional string" }
```

Registry 中 Explore/Reviewer 的 confidence、filesExamined、verdict、findings 等丰富 outputSpec 尚未接入当前 Chat finalization parser。并发硬上限是 8 active attempts；真实异常会话创建 4 个 Task，但只 spawn 3 个 Explore，没有“一次派 4 个 Agent”的框架规则。

## 应如何继续设计 CodeZ

建议把协议分成两层：

```json
{
  "lifecycle": {
    "agent_id": "...",
    "role": "Explore",
    "status": "completed",
    "tool_calls": 12,
    "duration_ms": 18000,
    "resume_handle": "..."
  },
  "report": {
    "conclusion": "...",
    "confidence": "medium",
    "findings": [],
    "files_examined": [],
    "unresolved": []
  },
  "raw_report_ref": "artifact://..."
}
```

生命周期必须强类型；报告优先结构化，但保留原始文本引用。运行中消息限制大小，完整 tool transcript 留在 child ledger，不自动注入主上下文。

## 一个完整时序

```text
主 Agent 理解问题并判断是否值得委派
-> 发送自包含 spawn brief
-> 子 Agent 获得独立 system/tool/project context
-> 子 Agent 调用 Read/Grep/Shell 等工具
-> 可选进度/状态事件，不回传原始洪流
-> 子 Agent 提交 final report + lifecycle metadata
-> 主 Agent验证关键证据并综合
-> 有增量问题时 resume/follow-up 原 Agent
-> 主 Agent向用户给最终答案
```

Task/Todo 数量不参与此时序的 Agent 数量计算。
