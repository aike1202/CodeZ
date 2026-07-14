import { describe, expect, it } from 'vitest'
import { ModelHistoryNormalizer } from '../main/services/context/ModelHistoryNormalizer'
import type { NormalizedModelMessage } from '../shared/types/context'

let id = 0
function message(value: Partial<NormalizedModelMessage>): NormalizedModelMessage {
  return {
    id: value.id || `m${++id}`,
    turnId: value.turnId || 't1',
    role: value.role || 'user',
    content: value.content || '',
    status: value.status || 'complete',
    createdAt: '2026-07-10T00:00:00.000Z',
    ...value
  }
}

describe('ModelHistoryNormalizer', () => {
  it('adds explicit interrupted results for durable incomplete tool calls', () => {
    const history = [
      message({ role: 'user', content: 'read' }),
      message({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }] })
    ]

    const normalized = ModelHistoryNormalizer.normalizeRecoveredHistory(history)

    expect(normalized.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'c1',
      name: 'Read',
      status: 'interrupted'
    })
    expect(() => ModelHistoryNormalizer.assertProtocolInvariant(normalized)).not.toThrow()
  })

  it('does not split assistant tool calls from their tool results', () => {
    const history = [
      message({ id: 'u1', role: 'user', content: 'old', turnId: 't1' }),
      message({ id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }], turnId: 't1' }),
      message({ id: 'r1', role: 'tool', toolCallId: 'c1', name: 'Read', content: 'ok', turnId: 't1' }),
      message({ id: 'a2', role: 'assistant', content: 'done', turnId: 't1' })
    ]

    const tail = ModelHistoryNormalizer.selectProtocolSafeTail(history, 2, () => 1)

    expect(tail.map((item) => item.id)).toEqual(['a1', 'r1', 'a2'])
  })

  it('drops complete protocol rounds during compaction overflow backoff', () => {
    const history = [
      message({ id: 'u1', role: 'user', content: 'start', sourceSequence: 1 }),
      message({ id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }], sourceSequence: 2 }),
      message({ id: 'r1', role: 'tool', toolCallId: 'c1', name: 'Read', content: 'old', sourceSequence: 3 }),
      message({ id: 'a2', role: 'assistant', toolCalls: [{ id: 'c2', name: 'Edit', arguments: '{}' }], sourceSequence: 4 }),
      message({ id: 'r2', role: 'tool', toolCallId: 'c2', name: 'Edit', content: 'new', sourceSequence: 5 })
    ]

    const truncated = ModelHistoryNormalizer.truncateOldestProtocolRounds(
      history,
      () => 1
    )

    expect(truncated?.messages.map((item) => item.id)).toEqual(['a2', 'r2'])
    expect(truncated?.truncatedThroughSequence).toBe(3)
  })

  it('rejects orphan and duplicate tool results', () => {
    const orphan = [message({ role: 'tool', toolCallId: 'missing', name: 'Read', content: 'x' })]
    expect(() => ModelHistoryNormalizer.assertProtocolInvariant(orphan)).toThrow('orphan tool result')

    const duplicate = [
      message({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }] }),
      message({ role: 'tool', toolCallId: 'c1', name: 'Read', content: 'one' }),
      message({ role: 'tool', toolCallId: 'c1', name: 'Read', content: 'two' })
    ]
    expect(() => ModelHistoryNormalizer.assertProtocolInvariant(duplicate)).toThrow('duplicate tool result')
  })
})
