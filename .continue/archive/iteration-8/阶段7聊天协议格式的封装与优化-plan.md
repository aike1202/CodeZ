# 📝 开发计划 - 阶段7聊天协议格式的封装与优化

> 关联需求：阶段7聊天协议格式的封装与优化-requirements.md
> 迭代：iteration-8
> 全局进度参阅：.continue/index.md

## 整体技术与架构总览
当前 `ChatService.ts` 存在大段的 if-else 流处理代码，将 OpenAI、Gemini 的逻辑糅合在一起，可维护性差。
本次迭代将应用 **Strategy (策略) 模式**：
- 定义 `IChatProvider` 接口统一调度。
- 分别实现 `OpenAIProvider`、`GeminiProvider`、`AnthropicProvider`，使其各自负责自己协议的 fetch 构建和 Stream 解析。
- 使用 `ChatProviderFactory` 根据用户的 `apiFormat` 或模型特征分配具体的执行策略。

## 阶段与任务大纲

**目标**：重构并解耦模型协议的请求格式和流式解析，实现 OpenAI、Gemini、Claude(Anthropic) 协议格式的分离封装。

⏳ 第一阶段 · 接口定义与基础结构
  ⏳ 1、创建接口定义与目录结构
     - 极简说明：在 `src/main/services/chat/` 下创建 `IChatProvider.ts` 及基础结构定义。
  ⏳ 2、实现 ChatProviderFactory
     - 极简说明：根据传入的 `apiFormat` (openai, gemini, anthropic) 路由至对应的 Provider 实例。

⏳ 第二阶段 · 封装具体 Provider
  ⏳ 1、实现 OpenAIProvider
     - 极简说明：迁移并封装原有针对 OpenAI 代理的流式解析、思考链降级逻辑及 Tool Calls 提取。
  ⏳ 2、实现 GeminiProvider
     - 极简说明：迁移并封装原生 Gemini API 解析，支持 `part.thought` 与 `thought_signature` 提取。
  ⏳ 3、实现 AnthropicProvider
     - 极简说明：新增对 Claude 官方 API 格式的支持，解析 SSE 下的 `message_start`, `content_block_delta` 等事件。

⏳ 第三阶段 · 重构调度层
  ⏳ 1、重构 ChatService.ts
     - 极简说明：移除旧有的解析代码，代理调用 `ChatProviderFactory.createProvider(config).streamChat(...)`。
  ⏳ 2、调整前端模型配置项支持 Anthropic (如需)
     - 极简说明：确保 `apiFormat` 配置中包含 `anthropic` 的支持选项。

### 验收&测试点
  ⏳ 1、验证 OpenAI 兼容协议：确保普通的 Chat 和带 Tool Call 的问答正常进行。
  ⏳ 2、验证 Gemini 原生协议：确保 Gemini 2.0 Thinking 模型不仅能输出思考过程，且其 Tool Calls 的上下文签名流转依然有效。
  ⏳ 3、验证 Anthropic 协议：若配置 Claude 密钥与模型，能准确回显普通对话。
