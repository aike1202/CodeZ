# CodeZ Prompt 与请求装配图

## 当前 Tauri 主链

```text
chat_start / AgentAttemptExecutor
  -> ConversationLedger
  -> ChatToolRuntime.provider_tool_definitions_for_run
  -> prepare_provider_request
      -> load durable scope
      -> normalize history
      -> ChatPromptAssembler.build
          -> PromptContext
          -> PromptPipeline.run
      -> budget / prune / optional compaction
      -> build_model_context_items
      -> model_context_items_to_chat_messages
      -> hydrate images
      -> fingerprint request
  -> open_provider_stream
  -> OpenAI / Anthropic / Gemini adapter
```

## System Prompt 顺序

`PromptPipeline` 先按 `PromptLayer`，再按 priority 排序。输出时 Core 和 Execution 被归为静态段，其余层被归为动态段：

```text
Identity                          Core 0
Engineering Philosophy           Core 3
Editing                          Execution 1
Verification                     Execution 2
Output Policy                    Execution 9

<codez_dynamic_capabilities>

Memory                           Context 0, disabled
Context continuity               Context 1
Repository rules                 Context 2, conditional
Environment                      Context 3
Git status                       Context 4
Skills                           Context 5, conditional
Verification strategy            Context 6, conditional
Available tools                  Dynamic 2
SubAgents catalog                Dynamic 3, disabled
Task tracking                    Dynamic 6, tool-gated
Worker delegation                Dynamic 7, stale-name-gated

Agent system addendum            appended after the pipeline for child runs
```

模块注册顺序不是最终文本顺序。`Editing` 和 `Verification` 虽然注册得较晚，仍因 layer 被放到 boundary 之前。

## Model-visible context 顺序

`build_model_context_items` 的顺序是：

```text
1. 主 System Prompt
2. instructions[]，每项一个 system message
3. compaction summary，system
4. resume state，system
5. durable history
   - 在当前输入前可插入 post-compaction skill context
   - 在当前输入前可插入 session skill state
   - 在当前输入前可插入 post-compaction file context
   - 当前用户消息
```

OpenAI adapter 随后发出：

```json
{
  "model": "<model.name>",
  "messages": ["<上述顺序>"],
  "tools": ["<本轮 eager tool schemas>"],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

`max_tokens`/`max_completion_tokens` 只在 model 明确配置 `maxOutputTokens` 时出现。当前本机 `gpt-5.6-sol` 未配置该字段，所以不会发送。thinking 为 `enabled=true, mode=auto, effort=auto` 时，OpenAI adapter 也不会增加额外字段。

## 每一轮都会重建的内容

- 规则文件
- permission mode
- Git snapshot
- Skills catalog 与 active skill state
- package.json 中可识别的验证脚本
- 当前 Provider tool schemas
- System Prompt 与 request fingerprint

因此 Agent 执行工具后进入下一 Provider round 时，规则、Git 状态、skill 状态和 deferred tool 激活结果都可能变化。

## 当前装配漂移

| 漂移 | 当前后果 |
|---|---|
| `WorkerDelegationModule` 不识别 `spawn_agent` | 主 Prompt 缺少委派门控正文 |
| `SubAgentsModule.is_enabled()` 固定 `false` | Agent 注册表不进主 Prompt |
| `deferred_tools: Some(Vec::new())` | 4 个 deferred tools 不在 Prompt 中展示 |
| Context continuity 只检测 `update_resume_state` | 当前 catalog 无该工具，无法按提示主动保存 resume state |
| Agent registry 的 `max_loops` 未接入当前 Chat loop | 当前 Provider loop 实际由全局 `MAX_TOOL_ROUNDS_PER_RUN = 64` 限制 |
| MCP catalog 未并入 ChatToolRuntime catalog | MCP 可在设置/命令层使用，但模型工具上下文中不可见 |

## 规则优先级的实际表达

CodeZ 自己没有单独 Developer role。运行时政策、工程行为和工具说明主要进入同一个 System message。项目规则段声称：

```text
global < workspace < closest directory < current explicit user request
```

同时保留“安全和运行时权限不能被覆盖”的例外。当前 `directory_rules` 始终为 `None`，所以“closest directory”只是协议预留，尚未由 `ChatPromptAssembler` 提供。
