# 08 UI 交互、可观测性与用户确认体验

## 1. 用户需求

用户需要看得见 Agent 在做什么，并能在关键点干预。尤其是：

- Agent 正在调用什么工具。
- 修改了哪些文件。
- 哪些操作需要批准。
- 验证是否通过。
- 失败在哪里。
- 如何停止或回滚。

## 2. 当前项目依据

相关文件：

- `src/main/ipc/chat.handlers.ts`
- `src/preload/index.ts`
- `src/renderer/src/stores/chatStore.ts`
- `src/renderer/src/components/*`
- `src/main/services/EditTransactionService.ts`

当前已有：

- 流式消息。
- tool start / tool end 事件。
- agentStates / tool timeline 状态。
- txId 记录。
- accept/reject file 操作入口。

主要缺口：

- Diff 展示不够明确。
- 权限审批卡片不完整。
- 验证结果不是一等 UI 状态。
- Trace / audit 日志不足。

## 3. 最终目的

UI 能支持完整 Coding Agent 工作流：

```text
任务开始
→ 计划展示
→ 工具调用轨迹
→ 修改 Diff
→ 审批操作
→ 验证结果
→ 最终总结
→ 可回滚
```

## 4. UI 状态需求

建议状态模型：

```ts
type AgentRunState =
  | 'idle'
  | 'planning'
  | 'searching'
  | 'reading'
  | 'editing'
  | 'awaiting_approval'
  | 'running_command'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'aborted'
```

工具调用应包含：

```ts
type ToolCallView = {
  id: string
  name: string
  status: 'running' | 'success' | 'error' | 'denied'
  startedAt: number
  endedAt?: number
  summary?: string
  error?: string
}
```

## 5. 交互需求

### 5.1 审批卡片

用于：

- 删除文件。
- 覆盖文件。
- 安装依赖。
- 联网。
- 高风险 Git 操作。
- MCP 外部写操作。

审批结果：

- allow
- deny
- allow once
- always allow for this session，后续可选

### 5.2 Diff 面板

MVP：

- 文件级 Diff。
- 接受文件。
- 拒绝文件。

后续：

- hunk 级接受 / 拒绝。
- inline diff。
- diff 搜索。

### 5.3 验证面板

展示：

- 命令。
- 状态。
- 耗时。
- stdout / stderr。
- 是否通过。
- 是否被截断。

## 6. 可观测性需求

每次 Agent run 应记录：

- run id。
- session id。
- provider。
- model。
- request url / protocol。
- request body size。
- response text 或流式 chunks。
- tool calls。
- tool results。
- failed tool calls and recovery action。
- changed files。
- approvals。
- commands。
- token usage。
- errors。

## 6.1 日志审计要求

`proxy_logs.db` 的分析暴露出一个关键问题：如果只保存 token usage 而不保存完整响应文本，后续无法审计最终报告内容。

因此 v2 日志至少需要：

```sql
request_logs: 保存请求元数据、请求体、状态、token、耗时
response_chunks: 保存流式响应正文、工具调用片段、错误片段
run_events: 保存工具调用、工具结果、审批、验证、恢复动作
```

要求：

- 能从日志完整还原一次 Agent run。
- 能看到每个工具调用的输入、输出、耗时、失败原因。
- 能看到失败后的恢复动作。
- 能导出一份项目分析报告的依据链。

## 7. 实施顺序

1. 梳理 `chatStore.ts` 当前消息和 tool call 状态。
2. 增加 AgentRunState。
3. 增加 approval pending 状态。
4. 增加 changedFiles / diff 状态。
5. 增加 verification 状态。
6. 增加 main → renderer IPC 事件。
7. UI 展示审批、Diff、验证面板。
8. 后续增加持久 trace。

## 8. 验证方式

### 8.1 UI 行为验证

执行一个会写文件的任务，期望：

- tool timeline 显示 read/search/edit。
- 修改后 UI 显示 changed files。
- 拒绝文件后内容恢复。
- 验证命令显示运行结果。

### 8.2 IPC 验证

- tool start / end 事件能成对出现。
- approval request 能暂停执行。
- approval response 能继续或拒绝执行。
- stop 能中断 AgentRunner。

### 8.3 命令验证

- `npm test`
- `npm run typecheck`
- UI 改动后运行 `npm run build`

## 9. 完成标准

- 用户能看懂 Agent 当前状态。
- 高风险操作不会悄悄执行。
- Diff 和验证结果有 UI 呈现。
- 用户可以停止、接受、拒绝、回滚。
