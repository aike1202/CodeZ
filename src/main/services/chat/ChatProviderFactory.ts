import { IChatProvider, ChatRequestConfig } from './types'
import { OpenAIProvider } from './OpenAIProvider'
import { GeminiProvider } from './GeminiProvider'
import { AnthropicProvider } from './AnthropicProvider'

export class ChatProviderFactory {
  static createProvider(config: ChatRequestConfig): IChatProvider {
    if (config.apiFormat === 'gemini') {
      return new GeminiProvider()
    } else if (config.apiFormat === 'anthropic' || config.apiFormat === 'claude') {
      return new AnthropicProvider()
    }
    return new OpenAIProvider()
  }
}
