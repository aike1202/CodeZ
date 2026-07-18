# 07 用户消息、会话历史与工具结果

## Durable Ledger

每个 session 在：

```text
C:\Users\asus\.codez\session-runtime\<session-id>\ledger.jsonl
C:\Users\asus\.codez\session-runtime\<session-id>\snapshot.json
```

Ledger 事件至少覆盖：

```text
user_message
assistant_message
tool_result
skill_state_updated
compaction
interruption / completion state
```

`assistant_message` 保存 tool call 的 ID、name、arguments、thought signature、token usage 和 request fingerprint。`tool_result` 保存 model-visible content、status 和可选 full result hash。

## Provider protocol

历史被规范化为：

```text
user -> assistant(tool_calls) -> tool(tool_call_id) -> assistant ...
```

在预算修剪时，当前 turn 的未消费 tool result 和协议安全尾部受保护。超大的旧 tool output 可被替换为保留 Unicode 边界的 head/tail 摘要。

## Ledger 不保存什么

选定真实会话保存了消息和 fingerprint，但没有逐字保存 outbound：

```text
system prompt
tools array
stream options
完整 HTTP request body
```

所以不能仅凭 Ledger 还原 byte-identical request。`context-requests` 中的真实样例均明确标为 C 级重建。

## Agent scope

主会话使用 `contextScopeId = main`。每个 child 使用独立的：

```text
subagent:<agent-id>
```

它们拥有独立 history、usage、skill state、compaction state 和 request fingerprint，但共用 session-owned Agent runtime mailbox。
