# CodeZ 子智能体总览

## 当前运行时与遗留实现

| 运行时 | Agent | 当前 Provider 主链可启动 |
|---|---|---:|
| Tauri/Rust Durable Agent | Explore | 是 |
| Tauri/Rust Durable Agent | Reviewer | 是 |
| Electron/TypeScript SubAgent | Explore | 否，遗留链 |
| Electron/TypeScript SubAgent | Reviewer | 否，遗留链 |
| Electron/TypeScript SubAgent | ExecutionPlanner | 否，遗留链 |
| Electron/TypeScript SubAgent | Executor | 否，遗留链 |

## 当前子 Agent Prompt 公式

```text
PromptPipeline 生成的完整主 Agent Prompt
+ agent_system_addendum(AgentAttemptRequest)
```

不是“只把一句 role instruction 发给模型”。因此主 Prompt 的所有规则、Skills catalog、环境、Git 状态和工具目录也会出现在子 Agent system 中，只是 available tools 按角色缩小。

## 当前输入

`spawn_agent` 的模型输入契约：

```json
{
  "role": "Explore | Reviewer",
  "taskName": "stable-name",
  "description": "optional",
  "message": "required delegated task",
  "context": "optional durable context",
  "expectations": {
    "questions": ["optional"],
    "outOfScope": ["optional"]
  },
  "scope": {
    "directories": ["optional"],
    "excludeGlobs": ["optional"]
  },
  "depth": "quick | normal | exhaustive",
  "allowedWriteFiles": ["contract field, not currently implemented as write capability"],
  "allowShell": false
}
```

Runtime 将 `message` 写成 child scope 的首条 user message，并把其余字段渲染到 system addendum 或保存到 Agent record。

## 当前输出

执行器真正接收的终态只有：

```rust
AgentAttemptOutput {
    report: String,
    conclusion: Option<String>,
}
```

`AgentAttemptOutput` 的类型允许 `conclusion`，Durable Agent runtime 也具备把
report/conclusion 组合为 `final_answer` mailbox message 的逻辑；但当前生产执行路径
`ChatRuntime::execute_agent_attempt` 始终返回 `conclusion: None`。Registry 中更丰富的
Explore/Reviewer `outputSpec` 是目录/UI 契约，当前 Chat executor 没有强制模型调用
`submit_result`，也没有按该完整 schema 解析终态。

## 父子通信

```text
parent spawn_agent
  -> child new_task mailbox
  -> child independent Provider/tool loop
  -> child send_message(/root) 可发中间消息
  -> child final answer 自动进入 parent mailbox
  -> parent wait_agent 或主 loop 结束时 auto-wait
  -> parent 下一轮把 mailbox 消息作为 user-role history 消费
```

父会话正常结束不会立刻杀掉刚创建的 child。`wait_for_root_agent_results` 每 30 秒检查 root direct children，直到得到未读消息、没有 active child 或主 run 被取消。

## 深度与并发

- `MAX_ACTIVE_ATTEMPTS = 8`，不是 4。
- `MAX_AGENTS_PER_SESSION = 200` 是累计记录，不是同时并发数。
- 子 Agent provider tool allowlist 不含 `spawn_agent`，所以当前模型工具面只允许一层委派。
- 数据结构仍支持 path/tree 和 descendant cancellation。
- `depth` 被持久化并写进 record，但当前 Chat loop 没有把 quick/normal/exhaustive 映射到 8/16/32；真正循环上限仍是 64 tool rounds。这是 registry 与执行器的漂移。

## 为什么 Explore 容易误触发

主 Prompt 当前缺失两组信息：

1. `WorkerDelegationModule` 中“简单请求、定向查找、紧密顺序任务直接做”的正文。
2. Explore registry 中“直接 Glob/Grep/Read 可回答时不要用、答案已在父上下文时不要用”的正文。

同时 `spawn_agent` description 只强调“Start a durable Explore or Reviewer Agent”，这会使模型把 Agent 当成普通并行搜索工具。真实日志一次派 3 个 Explore 是模型决策，不是框架要求一次派 4 个。
