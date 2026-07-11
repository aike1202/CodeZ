import { describe, expect, it } from 'vitest'
import { removeMessagesFromState } from '../renderer/src/stores/chatStore/slices/messageSlice'
import type { ChatState } from '../renderer/src/stores/chatStore/types'

describe('image message state', () => {
  it('removes a failed user/agent pair from root and active session projections', () => {
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'inspect' },
      { id: 'a1', role: 'agent' as const, content: '', streaming: true }
    ]
    const state = {
      activeSessionId: 's1',
      messages,
      sessions: [{ id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now', messages }]
    } as ChatState
    const next = removeMessagesFromState(state, new Set(['u1', 'a1']))
    expect(next.messages).toEqual([])
    expect(next.sessions[0].messages).toEqual([])
  })
})
