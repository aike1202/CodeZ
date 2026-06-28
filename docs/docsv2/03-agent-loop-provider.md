# 03 AgentLoop 与 ProviderAdapter 稳定化

## 1. 用户需求

用户需要 Agent 能稳定执行多轮任务：

```text
模型思考
→ 调用工具
→ 工具返回真实结果
→ 模型继续判断
→ 修改 / 验证
→ 最终结束
```

不能出现：

- tool call 丢失。
- 工具失败后模型不知道。
- 多 Provider 行为不一致。
- 无限循环。
- 用户停止后仍继续执行。

## 2. 当前项目依据

当前核心文件：

- `src/main/agent/AgentRunner.ts`
- `src/main/agent/ContextManager.ts`
- `src/main/services/chat/types.ts`
- `src/main/services/chat/ChatProviderFactory.ts`
- `src/main/services/chat/AnthropicProvider.ts`
- `src/main/services/chat/OpenAIProvider.ts`
- `src/main/services/chat/GeminiProvider.ts`
- `src/main/services/chat/utils.ts`
- `src/main/ipc/chat.handlers.ts`

当前已有：

- `MAX_LOOPS = 30` 的循环限制。
- 流式响应。
- 多工具并发执行。
- AbortController。
- Provider 抽象。
- Anthropic / OpenAI-compatible / Gemini 工具格式转换。
- ContextManager 裁剪历史。

## 3. 最终目的

形成稳定 Agent Runtime：

```text
AgentRunner 负责任务循环
ProviderAdapter 负责模型差异
ToolManager 负责工具定义
ToolExecutor 负责执行工具
ContextManager 负责上下文裁剪
IPC 负责 UI 事件
```

## 4. 需求拆解

### 4.1 统一停止原因

不同 Provider 的结束原因需要转换成统一枚举：

```ts
type AgentStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'pause_turn'
  | 'refusal'
  | 'error'
  | 'aborted'
```

### 4.2 Tool call 标准化

统一结构：

```ts
type NormalizedToolCall = {
  id: string
  name: string
  input: unknown
}
```

要求：

- OpenAI tool_calls 转换为该结构。
- Anthropic tool_use 转换为该结构。
- Gemini functionCall 转换为该结构。
- 工具结果统一加入下一轮消息。

### 4.3 循环保护

要求：

- max loop。
- max runtime。
- 连续工具失败次数限制。
- 无工具调用但也无最终文本时停止。
- abort 后停止全部后续工具执行。

### 4.4 错误传递

工具错误必须变成模型可理解的 observation：

```ts
type ToolResult<T> = {
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
    recoverable: boolean
    suggestion?: string
  }
}
```

## 5. 实施顺序

1. 给 Provider 输出建立统一内部事件类型。
2. 梳理 `AgentRunner.ts` 中 tool call 聚合逻辑。
3. 将工具执行结果包装成统一 ToolResult。
4. 增加 stop reason 标准化。
5. 增加连续失败保护。
6. 增加 AgentRunner 单元测试。
7. 增加 provider tool-call adapter 测试。

## 6. 验证方式

### 6.1 单元验证

- OpenAI-compatible 工具调用能被正确聚合。
- Anthropic `tool_use` 能被转换并回传 `tool_result`。
- Gemini function call 能进入同一执行路径。
- 工具失败时下一轮模型能看到错误内容。
- 超过 max loop 后返回明确错误。
- abort 后不会继续执行工具。

### 6.2 行为验证

构造一个假 Provider：

1. 第一轮要求调用 `search`。
2. 第二轮要求调用 `read_files`。
3. 第三轮输出最终回答。

期望 AgentRunner 能完整跑完。

### 6.3 命令验证

- `npm test -- AgentRunner`
- `npm test`
- `npm run typecheck`

## 7. 完成标准

- AgentLoop 可测试。
- Provider 差异被隔离。
- 工具失败不会吞掉。
- 多轮工具调用行为稳定。
