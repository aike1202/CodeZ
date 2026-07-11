import { describe, expect, it } from 'vitest'
import { ProviderMessageAdapter } from '../main/services/chat/ProviderMessageAdapter'
import type { ModelContextItem, NormalizedModelMessage } from '../shared/types/context'

const createdAt = '2026-07-10T00:00:00.000Z'
const normalized = (value: Partial<NormalizedModelMessage>): NormalizedModelMessage => ({
  id: value.id || 'm', turnId: value.turnId || 't', role: value.role || 'user',
  content: value.content || '', status: value.status || 'complete', createdAt, ...value
})

describe('ProviderMessageAdapter', () => {
  it('preserves user attachment references without changing content', () => {
    const attachment = {
      id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
      width: 800, height: 600, sizeBytes: 123, storageKey: 'attachment:sessions/s1/img1',
      scope: 'session' as const, sessionId: 's1'
    }
    const items: ModelContextItem[] = [
      { kind: 'user', message: normalized({ role: 'user', content: 'inspect', attachments: [attachment] }) }
    ]
    expect(ProviderMessageAdapter.toChatMessages(items)).toEqual([
      { role: 'user', content: 'inspect', attachments: [attachment] }
    ])
  })

  it('preserves assistant tool calls followed by matching tool results', () => {
    const items: ModelContextItem[] = [
      { kind: 'system', message: { role: 'system', content: 'system' } },
      { kind: 'assistant', message: normalized({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}' }] }) },
      { kind: 'tool', message: normalized({ role: 'tool', toolCallId: 'c1', name: 'Read', content: 'ok' }) }
    ]
    expect(ProviderMessageAdapter.toChatMessages(items)).toEqual([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1', name: 'Read' }
    ])
  })
})
