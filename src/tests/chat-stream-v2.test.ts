import { describe, expect, it } from 'vitest'
import type { StreamRequestV2 } from '../shared/types/context'

describe('Chat Stream V2 contract', () => {
  it('sends provider, model, session, and one current input', () => {
    const request: StreamRequestV2 = {
      streamId: 'stream-1',
      providerId: 'p1', model: 'm1', sessionId: 's1',
      input: { text: 'continue', commandMetadata: { commandName: 'goal' } }
    }
    expect(request).toEqual({
      streamId: 'stream-1',
      providerId: 'p1', model: 'm1', sessionId: 's1',
      input: { text: 'continue', commandMetadata: { commandName: 'goal' } }
    })
    expect(request).not.toHaveProperty('messages')
  })
})
