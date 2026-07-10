import type { NormalizedModelMessage } from '../../../shared/types/context'

const INTERRUPTED_RESULT = JSON.stringify({
  ok: false,
  error: {
    code: 'EXECUTION_INTERRUPTED',
    message: 'Tool execution was interrupted before a durable result was recorded.'
  }
})

interface PendingCall {
  callId: string
  name: string
  turnId: string
  createdAt: string
}

export class ModelHistoryNormalizer {
  static normalizeRecoveredHistory(messages: NormalizedModelMessage[]): NormalizedModelMessage[] {
    const result: NormalizedModelMessage[] = []
    const pending = new Map<string, PendingCall>()

    const flushInterrupted = (): void => {
      for (const call of pending.values()) {
        result.push({
          id: `interrupted:${call.callId}`,
          turnId: call.turnId,
          role: 'tool',
          content: INTERRUPTED_RESULT,
          toolCallId: call.callId,
          name: call.name,
          status: 'interrupted',
          createdAt: call.createdAt
        })
      }
      pending.clear()
    }

    for (const original of messages) {
      const message = { ...original, toolCalls: original.toolCalls?.map((call) => ({ ...call })) }
      if (message.role !== 'tool' && pending.size > 0) flushInterrupted()
      result.push(message)

      if (message.role === 'assistant') {
        for (const call of message.toolCalls || []) {
          pending.set(call.id, {
            callId: call.id,
            name: call.name,
            turnId: message.turnId,
            createdAt: message.createdAt
          })
        }
      } else if (message.role === 'tool' && message.toolCallId) {
        pending.delete(message.toolCallId)
      }
    }

    flushInterrupted()
    return result
  }

  static assertProtocolInvariant(messages: NormalizedModelMessage[]): void {
    const calls = new Map<string, { resolved: boolean }>()
    let unresolved = 0

    for (const message of messages) {
      if (message.role === 'user' && unresolved > 0) {
        throw new Error('new user message before pending tool results')
      }
      if (message.role === 'assistant') {
        if (unresolved > 0) throw new Error('assistant message before pending tool results')
        for (const call of message.toolCalls || []) {
          if (calls.has(call.id)) throw new Error(`duplicate tool call: ${call.id}`)
          calls.set(call.id, { resolved: false })
          unresolved++
        }
      }
      if (message.role === 'tool') {
        const callId = message.toolCallId || ''
        const call = calls.get(callId)
        if (!call) throw new Error(`orphan tool result: ${callId}`)
        if (call.resolved) throw new Error(`duplicate tool result: ${callId}`)
        call.resolved = true
        unresolved--
      }
    }

    if (unresolved > 0) throw new Error('incomplete tool protocol group')
  }

  static selectProtocolSafeTail(
    messages: NormalizedModelMessage[],
    tokenBudget: number,
    estimate: (message: NormalizedModelMessage) => number
  ): NormalizedModelMessage[] {
    if (messages.length === 0 || tokenBudget <= 0) return []

    let start = messages.length
    let tokens = 0
    while (start > 0 && tokens < tokenBudget) {
      start--
      tokens += Math.max(0, estimate(messages[start]))
    }

    if (messages[start]?.role === 'tool') {
      const needed = new Set<string>()
      for (let index = start; index < messages.length && messages[index].role === 'tool'; index++) {
        if (messages[index].toolCallId) needed.add(messages[index].toolCallId!)
      }
      for (let index = start - 1; index >= 0; index--) {
        const calls = messages[index].toolCalls || []
        if (messages[index].role === 'assistant' && calls.some((call) => needed.has(call.id))) {
          start = index
          break
        }
      }
    }

    return messages.slice(start).map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map((call) => ({ ...call }))
    }))
  }
}
