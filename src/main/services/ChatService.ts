import type { ChatMessage, ToolDefinition, ThinkingConfig } from '../../shared/types/provider'

import { ChatRequestConfig, StreamCallbacks } from './chat/types'
import { buildThinkingPayload } from './chat/utils'
import { ChatProviderFactory } from './chat/ChatProviderFactory'
import log from '../logger'

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

    log.info('[ChatService] streamChat start', { model: config.model, apiFormat: config.apiFormat, msgCount: config.messages?.length ?? 0 })

    try {
      const provider = ChatProviderFactory.createProvider(config)
      await provider.streamChat(config, callbacks, signal)
    } catch (err) {
      log.error('[ChatService] streamChat exception', { model: config.model, error: err instanceof Error ? err.message : String(err) })
      throw err
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
