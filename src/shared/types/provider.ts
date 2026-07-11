import type { ImageAttachment } from './attachment'

export type ThinkingMode = 'auto' | 'none' | 'openai' | 'deepseek' | 'qwen' | 'anthropic' | 'gemini' | 'grok' | 'openrouter'

export type ThinkingEffort = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'custom'

export interface ThinkingConfig {
  enabled: boolean
  mode: ThinkingMode
  effort?: ThinkingEffort
  budgetTokens?: number
}

export interface ModelConfig {
  id: string
  name: string
  /** 最大上下文长度（tokens），0 表示不限制 */
  maxContextTokens: number
  maxInputTokens?: number
  maxOutputTokens?: number
  reasoningCountsAgainstContext?: boolean
  supportsVision?: boolean
  /** 单独覆盖该模型使用的接口协议 */
  apiFormat?: ApiFormat
  /** 单独覆盖该模型使用的思考模式 */
  thinkingMode?: ThinkingMode
  /** 单独覆盖该模型使用的推理强度 */
  thinkingEffort?: ThinkingEffort
  /** 单独覆盖该模型使用的思考 Token 预算 */
  thinkingBudgetTokens?: number | null
}

export interface ModelContextCapabilities {
  contextWindowTokens: number
  maxInputTokens?: number
  maxOutputTokens?: number
  reasoningCountsAgainstContext?: boolean
}

export interface ProviderTokenUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  totalTokens?: number
}

export type ChatProviderErrorCode =
  | 'CONTEXT_OVERFLOW'
  | 'AUTHENTICATION'
  | 'RATE_LIMIT'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'UNKNOWN'

export type ApiFormat = 'openai' | 'anthropic' | 'gemini'

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
  /** API Key 明文 */
  apiKey: string
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
  attachments?: ImageAttachment[]
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

export type AgentStopReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown'

export interface ToolResult {
  ok: boolean
  data?: any
  error?: string
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
  usage?: ProviderTokenUsage
}
