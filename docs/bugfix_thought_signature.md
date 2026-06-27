# Bug 修复记录：Gemini Function Call 缺失 thought_signature 错误

## 1. 缺陷描述 (Bug Description)
在使用 Gemini API 开启 Thinking/Reasoning 功能时，如果在无状态模式下（每次请求由前端发送完整历史消息）大模型调用了工具（Function Call / Tool Call），且用户紧接着发起新一轮对话，应用服务端与 API 通信时会抛出如下错误拦截：
> `Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance.`

## 2. 根本原因 (Root Cause)
根据 Gemini API 官方文档关于 Thinking 签名的规定，由模型生成的内部思维块（包含工具调用）在通过历史消息传回给 API 时，**必须 (MUST) 携带由 Google 生成并加密的原始 `thought_signature`（思维签名）**，用于跨请求维持多轮推理的连贯性。

在项目之前的代码流转中，主进程的 `AgentRunner` 确实成功解析到了模型返回的签名，但是在将其通过 IPC 传递给前端渲染进程保存到 `chatStore` 的过程中发生了**字段丢失**。由于前端未能保存该签名，当用户输入下一句话时，前端在拼接 `chatMessages` 历史记录交还给 `ChatService` 时只能采用 `'skip_thought_signature_validator'` 作为硬编码的回退值 (Fallback)。Gemini 后端在校验该轮新请求时判定该签名无效/缺失，直接熔断并抛出异常。

## 3. 影响范围 (Impact)
**受影响的模块包括：**
- 共享类型定义 (`provider.ts`)
- 核心代理层 (`AgentRunner.ts`)
- 进程间通信层 (`chat.handlers.ts`, `preload/index.ts`)
- 前端状态管理及视图层 (`chatStore.ts`, `App.tsx`)

## 4. 修复方案 (Resolution)
彻底打通了前后端对于 `thought_signature` 字段的传递和储存链路。主要修改详情如下：

### 4.1. 类型定义 (`src/shared/types/provider.ts`)
为 `ToolCall` 接口增设了可选的 `thought_signature?: string` 属性，规范化数据解构。

### 4.2. 主进程转发 (`src/main/agent/AgentRunner.ts` & `src/main/ipc/chat.handlers.ts`)
- 在 `AgentRunnerCallbacks` 中的 `onToolStart` 钩子增加 `thoughtSignature` 形参。
- `AgentRunner` 内部流式解析并拼装工具调用时，一并将其附带的 `acc.thought_signature` 透传触发。
- 在 `chat.handlers.ts` 的事件转发中，通过 `IPC_CHANNELS.CHAT_STREAM_TOOL_START` 携带该签名发送至渲染进程。

### 4.3. 渲染进程接收 (`src/preload/index.ts` & `src/renderer/src/stores/chatStore.ts`)
- Preload IPC 桥接层在监听 `toolStartHandler` 时新增对第 6 个参数（即 signature）的拦截处理。
- `chatStore.ts` 的 `ToolCallState` 中增设 `thoughtSignature?: string` 字段，并在 `startToolCall` Action 发生时把从后端拿到的签名合入该工具调用状态。

### 4.4. 前端拼接与回传 (`src/renderer/src/App.tsx`)
重构了 `handleSendMessage` 方法构建发送给后端的 `chatMessages` 列表的历史消息装配逻辑。彻底移除原有的 `'skip_thought_signature_validator'` 硬编码，替换为动态获取前一轮被保存到内存状态的真实的 `tc.thoughtSignature` 以及回合全局签名 `finalSig`。

## 5. 验证结果 (Verification)
- 启动应用，选用支持 Tool Call 及 Thinking 的 Gemini 模型进行测试。
- 模型成功调用工具。
- 查看下一轮请求的网络 Payload 或本地临时文件日志，历史数组里已经成功附带了正确的 `thought_signature`。
- 模型能够继续稳定的进行新一轮推理响应，错误日志不再出现。

## 6. 修复日期
2026-06-26
