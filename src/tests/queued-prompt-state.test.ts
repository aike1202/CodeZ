import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { ChatState } from '../renderer/src/stores/chatStore/types'
import { createSessionSlice } from '../renderer/src/stores/chatStore/slices/sessionSlice'

const save = vi.fn()

function createSessionStore() {
  return createStore<ChatState>()((...args) => ({
    ...createSessionSlice(...args),
    messages: []
  } as unknown as ChatState))
}

describe('queued prompt session state', () => {
  beforeEach(() => {
    save.mockReset()
    ;(globalThis as any).window = {
      api: {
        session: {
          list: vi.fn().mockResolvedValue([]),
          get: vi.fn(),
          save
        }
      }
    }
  })

  it('keeps FIFO order and persists queue edits', () => {
    const store = createSessionStore()
    store.setState({
      sessions: [{
        id: 's1', projectId: 'p1', summary: 'Session', relativeTime: 'now',
        messages: [], queuedPrompts: []
      }],
      activeSessionId: 's1'
    })

    const first = store.getState().enqueueQueuedPrompt('s1', {
      text: 'first', modelName: 'm1', attachments: []
    })
    const second = store.getState().enqueueQueuedPrompt('s1', {
      text: 'second', modelName: 'm1', attachments: []
    })
    store.getState().updateQueuedPrompt('s1', first.id, { text: 'edited' })

    expect(store.getState().sessions[0].queuedPrompts?.map((prompt) => prompt.text))
      .toEqual(['edited', 'second'])
    expect(store.getState().removeQueuedPrompt('s1', first.id)?.text).toBe('edited')
    expect(store.getState().sessions[0].queuedPrompts?.[0].id).toBe(second.id)
    expect(save).toHaveBeenCalled()
  })

  it('restores in-flight steering entries as queued after reload', async () => {
    const store = createSessionStore()
    ;(window as any).api.session.list.mockResolvedValue([{
      id: 's1', projectId: 'p1', summary: 'Session', relativeTime: 'now', messages: [],
      queuedPrompts: [{
        id: 'q1', text: 'resume me', modelName: 'm1', attachments: [],
        createdAt: 1, status: 'steering'
      }]
    }])

    await store.getState().loadSessions()

    expect(store.getState().sessions[0].queuedPrompts?.[0].status).toBe('queued')
  })
})
