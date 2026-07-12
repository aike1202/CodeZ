import type { ChatMessage } from '../../stores/chatStore'
import type { PromptPredictionContextMessage } from '@shared/types/promptPrediction'

const MAX_CONTEXT_MESSAGES = 12

export function buildPromptPredictionContext(
  messages: ChatMessage[]
): PromptPredictionContextMessage[] {
  return messages
    .filter((message) => (
      (message.role === 'user' || message.role === 'agent')
      && !message.streaming
      && message.content.trim().length > 0
    ))
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => ({
      role: message.role === 'agent' ? 'assistant' : 'user',
      content: message.content
    }))
}

export function canPredictNextPrompt(messages: ChatMessage[]): boolean {
  const latest = [...messages].reverse().find((message) => (
    message.role !== 'system' && message.content.trim().length > 0
  ))
  return latest?.role === 'agent' && !latest.streaming && !latest.interrupted
}

export function getPromptPredictionSuffix(draft: string, suggestion: string): string {
  const normalizedSuggestion = suggestion.trim()
  if (!normalizedSuggestion) return ''
  if (!draft) return normalizedSuggestion
  if (normalizedSuggestion.length <= draft.length) return ''

  const predictedPrefix = normalizedSuggestion.slice(0, draft.length)
  if (predictedPrefix !== draft && predictedPrefix.toLocaleLowerCase() !== draft.toLocaleLowerCase()) {
    return ''
  }
  return normalizedSuggestion.slice(draft.length)
}
