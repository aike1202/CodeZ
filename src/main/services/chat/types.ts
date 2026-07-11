import type {
  AgentStopReason,
  ChatMessage,
  ChatProviderErrorCode,
  ProviderTokenUsage,
  ThinkingConfig,
  ToolDefinition
} from '../../../shared/types/provider'
import type { ResolveImageAttachment } from '../../../shared/types/attachment'

export interface ChatRequestConfig {
  baseUrl: string
  apiKey: string
  model: string
  apiFormat?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  thinking?: ThinkingConfig
  resolveImage?: ResolveImageAttachment
}

export interface StreamCallbacks {
  onChunk: (delta: string, reasoningDelta?: string, toolCalls?: any[], thoughtSignature?: string) => void
  onDone: (fullContent: string, stopReason?: AgentStopReason, txId?: string) => void
  onError: (error: string, code?: ChatProviderErrorCode) => void
  onUsage?: (usage: ProviderTokenUsage) => void
}

export interface IChatProvider {
  streamChat(config: ChatRequestConfig, callbacks: StreamCallbacks, signal: AbortSignal): Promise<void>
}
