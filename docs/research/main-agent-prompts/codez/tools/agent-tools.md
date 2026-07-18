# Agent 工具核心算法

## spawn

```text
parse strict SpawnArguments
-> validate role/task/message/context/list sizes
-> resolve requester context to parent Agent/path
-> enforce MAX_ACTIVE_ATTEMPTS=8 and MAX_AGENTS_PER_SESSION=200
-> create agent_<uuid>, attempt_<uuid>, child scope, /parent/taskName path
-> persist AgentRuntimeSnapshot revision atomically
-> create unread new_task mailbox message
-> register cancellation token linked to parent
-> start supervised AgentAttemptExecutor asynchronously
-> return AgentRecord immediately
```

框架没有“凑满 4 个”逻辑。一次响应最多可返回 32 个 Provider tool calls，但 Agent runtime 同时只允许 8 个 active attempts。

## attempt execution

```text
load mailbox for attempt
-> begin child ConversationLedger in subagent:<agent-id>
-> build full prompt + role addendum
-> expose role allowlist tools
-> run the same Provider/tool loop
-> on success create AgentAttemptOutput(report=full_content, conclusion=None)
-> persist agent status completed
-> append final_answer mailbox to parent
-> notify waiters
```

失败/取消会更新 terminal status；interrupt 会取消选中 attempt 和 descendant attempt tokens。

## followup_task

只能由允许的 parent/owner 对已完成的 direct child 开新 attempt。它复用同一 Agent record/path/context scope，产生新 attempt ID 和新 mailbox input。运行中的 child 不能被 followup；sibling context 不能 follow up 另一个 sibling。

## send_message

解析 sender scope 和 target ID/path/`/root`，验证 session ownership，创建 durable mailbox message并持久化 revision。普通消息会在接收者下一轮包装为：

```text
Message from <author>:

<payload>
```

## wait_agent

```text
resolve targets; empty means all relevant direct updates
-> inspect unread messages for recipient
-> if present: mark delivered/read and return Updated
-> if no target active: NoActiveAgents
-> otherwise wait on Notify until revision changes or timeout
-> repeat without losing concurrent wakeup
```

最大显式 timeout 300 秒。主 conversation 还有独立的 root auto-wait，每次 slice 30 秒。

## list/interrupt

`list_agents` 返回 session-owned durable records 和 active attempt IDs。`interrupt_agent` 只解析同 session target，取消 attempt tree并让监督任务收敛到 terminal state。

## 持久化上限

```yaml
agent_snapshot_max_bytes: 4MiB
messages_per_session: 512
general_messages_per_session: 500
message_max_bytes: 128KiB
context_max_bytes: 256KiB
list_items: 128
list_item_max_bytes: 4KiB
```

超过普通 mailbox 容量时，runtime 只会淘汰已读消息；没有可淘汰项则返回 mailbox full conflict。
