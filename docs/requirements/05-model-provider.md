# 05. 模型 Provider 与 API 接入

> 模块：多模型厂商配置、模型选择、流式响应、API Key 安全存储

---

## 1. 模型 Provider 管理

### 功能编号

F4

系统必须支持多个模型厂商配置。

每个 Provider 包含：

- Provider 名称；
- API Base URL；
- API Key；
- 默认模型；
- 是否启用；
- 是否 OpenAI-compatible；
- 请求超时时间；
- 最大上下文长度；
- 最大输出长度。

---

## 2. 推荐支持的 Provider

第一版建议至少支持：

1. OpenAI-compatible API；
2. DeepSeek；
3. Qwen / 阿里云百炼；
4. GLM / 智谱；
5. Ollama 本地模型，可选；
6. Claude，可选。

其中 OpenAI-compatible Provider 是最重要的第一优先级，因为很多国内外模型厂商都兼容 OpenAI API 格式。

---

## 3. Provider 抽象接口

```ts
interface ModelProvider {
  id: string
  name: string
  listModels(): Promise<ModelInfo[]>
  chat(request: ChatRequest): Promise<ChatResponse>
  streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>
}
```

Provider Adapter 需要负责：

- 请求 URL 拼接；
- 鉴权 header；
- 请求格式转换；
- 响应格式转换；
- 错误标准化；
- 流式响应解析；
- token 用量提取，可选。

---

## 4. 模型选择

### 功能编号

F5

用户可以在会话中选择当前使用的模型。

### 要求

- 支持默认模型；
- 支持按任务切换模型；
- 支持模型可用性测试；
- 支持流式输出；
- 支持失败重试；
- 支持展示 token 用量，可选；
- 支持设置最大上下文长度和最大输出长度；
- 支持不同任务使用不同模型，例如快速问答、复杂规划、代码修改。

---

## 5. API Key 安全存储

### 功能编号

F6

API Key 不能明文展示在 UI 中。

### 要求

- UI 中默认脱敏显示；
- 支持修改和删除；
- 本地存储时至少避免直接出现在普通配置文件；
- 优先使用系统 Keychain，或 Electron `safeStorage`；
- 如果使用本地加密文件，需要说明风险；
- 日志中不得记录 API Key；
- IPC 通信中尽量只传递 `apiKeyRef`，而非明文 API Key。

---

## 6. 连接测试

用户保存 Provider 前或保存后可以点击“测试连接”。

### 测试流程

1. 读取 Provider 配置；
2. 使用一个短 prompt 发起请求；
3. 设置较短超时时间；
4. 返回成功或失败原因；
5. 不保存测试 prompt 到普通会话中。

### 验收标准

- API Key 错误时显示鉴权失败；
- Base URL 错误时显示网络或地址错误；
- 模型名错误时显示模型不可用；
- 测试成功时显示 Provider 可用。

---

## 7. 模型错误标准化

不同厂商错误格式不同，需要统一为：

```ts
interface ModelError {
  providerId: string
  model?: string
  code: string
  message: string
  retryable: boolean
  raw?: unknown
}
```

常见错误类型：

- unauthorized；
- rate_limited；
- model_not_found；
- context_length_exceeded；
- network_error；
- timeout；
- invalid_request；
- provider_error。
