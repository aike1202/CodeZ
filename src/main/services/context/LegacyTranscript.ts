import type { SessionData } from '../../../shared/types/session'

export function serializeLegacyTranscript(messages: SessionData['messages']): string {
  return messages
    .filter((message) => typeof message.content === 'string' && message.content.trim())
    .map((message) => {
      if (message.role === 'user') return `User: ${message.content}`
      if (message.role === 'agent' || message.role === 'assistant') return `Agent: ${message.content}`
      return `System note: ${message.content}`
    })
    .join('\n\n')
}
