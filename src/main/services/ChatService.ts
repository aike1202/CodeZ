import type { ChatMessage, ToolDefinition, ThinkingConfig } from '../../shared/types/provider'

import { ChatRequestConfig, StreamCallbacks } from './chat/types'
import { buildThinkingPayload } from './chat/utils'
import { ChatProviderFactory } from './chat/ChatProviderFactory'

export type { ChatRequestConfig, StreamCallbacks } from './chat/types'
export { buildThinkingPayload } from './chat/utils'

export class ChatService {
  private currentAbortController: AbortController | null = null

  async streamChat(config: ChatRequestConfig, callbacks: StreamCallbacks, externalSignal?: AbortSignal): Promise<void> {
    this.currentAbortController = new AbortController()
    
    const signal = externalSignal || this.currentAbortController.signal
    const abortHandler = () => this.currentAbortController?.abort()
    
    if (externalSignal) {
      externalSignal.addEventListener('abort', abortHandler)
    }

    try {
      const provider = ChatProviderFactory.createProvider(config)
      await provider.streamChat(config, callbacks, signal)
    } finally {
      if (externalSignal) {
        externalSignal.removeEventListener('abort', abortHandler)
      }
    }
  }

  abort(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
    }
  }
}
