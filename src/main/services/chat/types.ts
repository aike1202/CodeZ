import type { ChatMessage, ToolDefinition, ThinkingConfig, AgentStopReason } from '../../../shared/types/provider'

export interface ChatRequestConfig {
  baseUrl: string
  apiKey: string
  model: string
  apiFormat?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  thinking?: ThinkingConfig
}

export interface StreamCallbacks {
  onChunk: (delta: string, reasoningDelta?: string, toolCalls?: any[], thoughtSignature?: string) => void
  onDone: (fullContent: string, stopReason?: AgentStopReason, txId?: string) => void
  onError: (error: string) => void
}

export interface IChatProvider {
  streamChat(config: ChatRequestConfig, callbacks: StreamCallbacks, signal: AbortSignal): Promise<void>
}
