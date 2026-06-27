# 📋 需求文档 - 聊天协议格式的封装与优化

> 迭代：iteration-8
> 创建时间：2026-06-26 20:35
> 最后更新：2026-06-26 20:35
> 存放位置：.continue/current/阶段7聊天协议格式的封装与优化-requirements.md

## 需求概述

**一句话描述**：重构 `ChatService.ts`，引入 Provider / Strategy 设计模式，将不同模型协议（OpenAI 格式、Gemini 格式）的请求与流式解析逻辑独立封装，实现高内聚低耦合的工业级架构。

**业务背景**：随着项目接入的模型越来越多（如 OpenAI 兼容代理、Gemini Native 等），它们各自具有独特的流式传输机制、函数调用格式以及“思考过程”呈现方式（如 Gemini 的 `part.thought` 和 `thought_signature`）。当前 `ChatService.ts` 中的大泥球式（Monolithic）实现包含了所有这些复杂的 `if-else` 分支，难以维护，且容易引发如“无法正确解析思考过程”的 Bug。为了支持长期的工业级应用和后续快速接入新模型厂商，需要对其进行彻底解耦和封装。

**预期价值**：
1. **提升可维护性**：各协议（OpenAI、Gemini、Anthropic）的组装与解析逻辑分离，互不干扰，降低代码复杂度。
2. **便于扩展**：目前接入 OpenAI、Gemini 和 Claude，未来接入新协议格式只需新增一个 `Provider` 实现类，无需修改核心调度逻辑。
3. **消除 Bug**：可以更精准地处理每个协议特有的字段（尤其是 Gemini 的 `thought_signature` 和 Claude 的特殊结构及流处理）。

## 功能需求

### 核心功能（必须实现）

- [ ] **F1**: 抽象 `IChatProvider` 接口
  - 定义统一的 `streamChat(config, callbacks, signal)` 签名。
  - 规定统一的回调行为（如何返回 `delta`, `reasoningDelta`, `toolCalls`, `thoughtSignature`）。
  
- [ ] **F2**: 实现 `OpenAIProvider`
  - 将现有的 OpenAI 请求构建逻辑封装。
  - 处理标准的 SSE (`data: [...]`) 解析。
  - 提取 OpenAI 格式的 `reasoning_content` 以及由于兼容性考虑的 `<think>` 标签解析。
  
- [ ] **F3**: 实现 `GeminiProvider`
  - 将原生 Gemini API 的请求构建封装（URL 的 `?key=` 参数、结构化的 `contents`）。
  - 精确处理 Gemini 流式响应数组。
  - 正确解析 Gemini 2.0 的原生推理（`part.thought`）以及函数调用必选的 `thoughtSignature`。

- [ ] **F4**: 实现 `AnthropicProvider`
  - 将原生 Claude/Anthropic API 的请求构建封装（`x-api-key`、`anthropic-version` 等 headers，及特定 `messages` 结构）。
  - 处理 Anthropic 独有的 Server-Sent Events (SSE) 事件类型（如 `message_start`, `content_block_delta`, `message_delta`）。
  - 解析 Claude 返回的文本内容和特定的工具调用流。

- [ ] **F5**: 实现 `ChatProviderFactory`
  - 根据 `ChatRequestConfig` 中的 `apiFormat` 或 URL 规则，动态实例化并返回对应的 Provider。

- [ ] **F6**: 重构 `ChatService`
  - 移除 `ChatService` 内部所有硬编码的 Provider 判断及流式处理逻辑。
  - 将其职责简化为通过工厂获取 Provider，并调用接口方法。

### 扩展功能（可选实现）

- [ ] **E1**: 独立抽离 Payload Builder，例如将 `buildThinkingPayload` 根据 Provider 进行各自定制，而不是由全局统一生成。

## 非功能需求

### 质量要求
- **代码规范**：严格遵循 TypeScript 的接口定义和类型推断。
- **无破坏性更新**：重构后对 `AgentRunner` 以及前端所有的 UI 组件透明，原有的对话和 Tool 调用不可出现回退问题。

## 约束条件

### 技术栈限制
- 后端（Main Process）：Node.js, TypeScript

## 验收标准

### 功能验收
- [ ] **AC1**: 使用 OpenAI / DeepSeek / 任何兼容 OpenAI 代理格式的模型发起请求，能够正常流式输出、显示思考过程、触发并返回工具调用。
- [ ] **AC2**: 使用原生 Gemini API（如 `gemini-2.0-flash-thinking-exp`）发起请求，能够正常流式输出 `part.thought` 的思考过程。
- [ ] **AC3**: 原生 Gemini API 发起带有 Tool Call 的请求时，必须正确提取到 `thought_signature` 并能回传。
- [ ] **AC4**: 使用 Anthropic API（如 Claude 3.5 Sonnet）发起请求，能够正常解析其独有的事件流并输出文本与工具调用。

### 质量验收
- [ ] **Q1**: `npm run typecheck` 通过。
- [ ] **Q2**: `npm run build` 构建成功且各项功能没有退化。
- [ ] **Q3**: `ChatService.ts` 代码行数大幅缩减，不再包含底层流的 `TextDecoder` 和分行解析逻辑，流处理均位于各自的 Provider 中。
