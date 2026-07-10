import type { ModelContextItem, NormalizedModelMessage } from '../../../shared/types/context'
import type { ChatMessage } from '../../../shared/types/provider'

function normalizedToChatMessage(message: NormalizedModelMessage): ChatMessage {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
        ...(call.thoughtSignature ? { thought_signature: call.thoughtSignature } : {})
      }))
    }
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name
    }
  }
  return { role: 'user', content: message.content }
}

export class ProviderMessageAdapter {
  static toChatMessages(items: ModelContextItem[]): ChatMessage[] {
    return items.map((item) => {
      if (item.message.role === 'system') {
        return { role: 'system', content: item.message.content }
      }
      return normalizedToChatMessage(item.message)
    })
  }
}
