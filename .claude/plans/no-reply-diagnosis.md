# 消息无回复诊断与修复方案

## 背景与根因

用户反馈：给 CodeZ 发送消息后，AI 没有任何回复。需增加日志/前端状态显示来诊断。

已追踪完整链路：`useSendMessage` → preload `chat.stream` → IPC `CHAT_STREAM_START` → `AgentRunner.run` → `ChatService.streamChat` → Provider `streamChat`。

定位到 4 个静默失败点：

1. **SSE 流无超时保护（系统性根因，最可能）** — 三个 provider（OpenAI/Anthropic/Gemini）全部用 `while(true){await reader.read()}` 无超时；`ChatService` 与 `AgentRunner` 的 Promise 也无超时。SSE 挂起（网络中断但 TCP 未断、代理 keep-alive 无数据、上游挂起）→ `reader.read()` 永久挂起 → `AgentRunner` 第 230 行 Promise 永不 resolve → 前端 `streaming:true` 永不结束 → 用户看到“转圈无回复”。
2. **日志缺失** — `chat.handlers.ts` 完全无日志，`ChatService` 无日志，`AgentRunner` 仅零星 `console.log`。`CodeZlogs` 文件无法判断卡在哪一步。
3. **`activeStreamId` 竞态** — preload 第 186-189 行在 `invoke` 返回后才赋 `activeStreamId`，而后端在 handler `return streamId` 之前就启动了 `runner.run()`，快速响应的 chunk 会被前端因 `streamId !== activeStreamId`(null) 丢弃。
4. **前端无 watchdog** — streaming 卡住时无超时提示，无重试入口。

## 方案（分层，P0 必做 → P2 可选）

### P0-A：后端结构化日志（诊断基础）

复用现有 `electron-log`（已配置写 `CodeZlogs` 文件，`setupLogger` 已覆盖 `console`）。

- **`src/main/ipc/chat.handlers.ts`**：`import log from '../logger'`
  - 收到 `CHAT_STREAM_START`：`log.info('[Chat] start', { providerId, model, sessionId, msgCount })`
  - 生成 streamId：`log.info('[Chat] stream', { streamId })`
  - 校验失败（provider/apiKey/workspace）：`log.warn('[Chat] reject', { reason })`
  - runner 启动：`log.info('[Chat] runner start', { streamId })`
  - 回调：onChunk 仅首次 `log.info('[Chat] first chunk', { streamId })`；onDone `log.info('[Chat] done', { streamId, stopReason, len })`；onError `log.error('[Chat] error', { streamId, error })`；onToolStart/End `log.info('[Chat] tool', { streamId, name })`
  - `.catch`：`log.error('[Chat] runner crashed', { streamId, error })`
- **`src/main/services/ChatService.ts`**：streamChat 开始/结束/异常打日志（model、apiFormat、msgCount）。
- **`src/main/agent/AgentRunner/index.ts`**：run 开始、loop 计数、streamChat 调用前后、工具执行、验证拦截、最终 onDone 打日志。
- **三个 Provider**：补充首字节到达、流结束日志（OpenAI 已有 `log.info`，补 Anthropic/Gemini）。

### P0-B：流式超时 watchdog（修复静默死锁根因）

在 **`src/main/agent/AgentRunner/index.ts`** 第 230 行 `streamChat` Promise 包裹处加 watchdog（不侵入 provider，通用且低风险）：

- 常量：`FIRST_BYTE_TIMEOUT = 30_000`（无任何 chunk）、`IDLE_TIMEOUT = 60_000`（收到过 chunk 但无新数据）。
- 启动 `firstByteTimer`；onChunk 内：首次清 `firstByteTimer`，每次重置 `idleTimer`；onDone/onError/超时触发时清所有 timer。
- 超时触发：`log.error('[AgentRunner] stream timeout', { type, loopCount })` → `callbacks.onError(友好文案)` → `this.abortController.abort()`（让 provider 的 `fetch` 抛错退出）→ `resolve()`。
- 文案：首字节超时 → “等待首个响应超时（30s），请检查网络 / Provider / 模型是否可用”；空闲超时 → “响应流已超时中断（60s 无新数据），已自动停止”。
- 效果：无论 provider 如何卡死，前端必在 30/60s 内收到 onError → `finishStreaming` → 用户看到明确错误而非无限转圈。

### P1：前端状态显示（让“无回复”有视觉反馈）

- **`src/renderer/src/components/chat/AgentMessageContent.tsx`**（或 `ChatMessageList`）：streaming 且 `content` 为空时显示“正在思考…”指示器，区分“等首字节”与“接收中”。
- **`useSendMessage.ts`**：onError 时把错误以更醒目的样式呈现（当前仅追加 `错误：…` 文本，可加错误态标记）；可选前端兜底 watchdog（90s 无 chunk 且未结束 → 追加“⚠️ 长时间无响应，建议停止后重试”，防 IPC 也失效）。

### P2：修复 `activeStreamId` 竞态（可选增强）

- **`chat.handlers.ts`**：`setImmediate(() => runner.run(...))` 让 handler 先 `return streamId`，确保前端先拿到 `activeStreamId` 再收 chunk。

## 不改动

- 不改 IPC 通道结构、不改 provider 的 SSE 解析逻辑。
- 超时阈值先用常量（30s/60s）；后续如需可配置再加到 `GeneralSettings`。

## 验证

1. `npm run typecheck` 通过。
2. `npm run dev` 手动测试：
   - 正常对话 → 确认日志齐全（`CodeZlogs`）且回复正常流式。
   - 配置错误 Provider/Key → 确认 30s 内 onError + 前端错误提示。
   - 模拟网络中断（断网/改错 baseUrl 指向可连接但不响应的地址）→ 确认 30/60s 内 onError 而非无限转圈。
3. 查 `CodeZlogs` 确认日志可读、能定位卡点。

## 建议执行范围

推荐 **P0-A + P0-B + P1**（诊断 + 修复根因 + UX），P2 视情况追加。如只想先定位问题，可只做 P0-A；但根因（无超时）不修则问题会复发。
