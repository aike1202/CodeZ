export type ThinkingMode = 'auto' | 'none' | 'openai' | 'deepseek' | 'qwen' | 'anthropic' | 'gemini' | 'openrouter'

export interface ThinkingConfig {
  enabled: boolean
  mode: ThinkingMode
}

/** 单个模型配置 */
export interface ModelConfig {
  id: string
  name: string
  /** 最大上下文长度（tokens），0 表示不限制 */
  maxContextTokens: number
}

export type ApiFormat = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'azure'

/** Provider 持久化配置（含加密后的 API Key） */
export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  /** 接口格式协议 */
  apiFormat?: ApiFormat
  /** 加密后的 API Key 引用（safeStorage 或 base64） */
  apiKeyRef: string
  /** 加密方式标识 */
  encryption: 'safeStorage' | 'base64' | 'none'
  /** 该 Provider 下配置的模型列表 */
  models: ModelConfig[]
  /** Thinking/reasoning 输出配置 */
  thinking: ThinkingConfig
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** 前端展示用的 Provider 信息（不含 API Key 明文） */
export interface ProviderInfo {
  id: string
  name: string
  baseUrl: string
  apiFormat?: ApiFormat
  /** 脱敏后的 API Key 片段（如 sk-****abc） */
  apiKeyMasked: string
  models: ModelConfig[]
  thinking: ThinkingConfig
  enabled: boolean
  createdAt: string
}

/** Provider 新建/编辑表单数据 */
export interface ProviderFormData {
  name: string
  baseUrl: string
  apiFormat?: ApiFormat
  apiKey: string
  models: ModelConfig[]
  thinking: ThinkingConfig
}

/** /v1/models 返回的模型信息 */
export interface ModelInfo {
  id: string
  object: string
  created: number
  owned_by: string
}

/** 连接测试结果 */
export interface ConnectionTestResult {
  success: boolean
  message: string
  models?: string[]
}

/** 聊天消息（与 OpenAI 格式对齐） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
  thought_signature?: string
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any> // JSON Schema
  }
}

/** 流式 chunk */
export interface ChatStreamChunk {
  /** 本次增量文本 */
  delta: string
}

/** 流式结束 */
export interface ChatStreamEnd {
  /** 完整消息内容 */
  fullContent: string
  /** token 用量（可选） */
  usage?: {
    promptTokens: number
    completionTokens: number
  }
}
