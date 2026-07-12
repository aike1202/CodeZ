import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStreamUpdateBatcher } from '../renderer/src/components/chat/hooks/streamUpdateBatcher'
import { updateMessageInState } from '../renderer/src/stores/chatStore/slices/messageSlice'
import type { ChatMessage, ChatSession, ChatState } from '../renderer/src/stores/chatStore'

const message = (id: string, content = ''): ChatMessage => ({
  id,
  role: 'agent',
  content
})

afterEach(() => {
  vi.useRealTimers()
})

describe('chat stream rendering performance', () => {
  it('coalesces a burst of main-agent chunks into one render update', () => {
    vi.useFakeTimers()
    const appendMain = vi.fn()
    const batcher = createStreamUpdateBatcher({
      appendMain,
      appendSubAgent: vi.fn()
    }, 40)

    for (let index = 0; index < 100; index++) {
      batcher.pushMain(String(index % 10), index % 2 === 0 ? 'r' : '')
    }

    expect(appendMain).not.toHaveBeenCalled()
    vi.advanceTimersByTime(40)
    expect(appendMain).toHaveBeenCalledTimes(1)
    expect(appendMain.mock.calls[0][0]).toHaveLength(100)
    expect(appendMain.mock.calls[0][1]).toHaveLength(50)
  })

  it('flushes main and sub-agent chunks before terminal events', () => {
    vi.useFakeTimers()
    const appendMain = vi.fn()
    const appendSubAgent = vi.fn()
    const batcher = createStreamUpdateBatcher({ appendMain, appendSubAgent }, 40)

    batcher.pushMain('hello', 'think')
    batcher.pushSubAgent('worker-1', 'result', 'reasoning')
    batcher.flush()

    expect(appendMain).toHaveBeenCalledWith('hello', 'think')
    expect(appendSubAgent).toHaveBeenCalledWith('worker-1', 'result', 'reasoning')
    vi.advanceTimersByTime(40)
    expect(appendMain).toHaveBeenCalledTimes(1)
    expect(appendSubAgent).toHaveBeenCalledTimes(1)
  })
})

describe('active chat message update path', () => {
  it('does not inspect messages belonging to unrelated sessions', () => {
    const activeMessage = message('target')
    const unrelatedSession = {
      id: 'other',
      projectId: 'project',
      summary: 'other',
      relativeTime: 'now',
      get messages(): ChatMessage[] {
        throw new Error('unrelated messages were scanned')
      }
    } as ChatSession
    const activeSession: ChatSession = {
      id: 'active',
      projectId: 'project',
      summary: 'active',
      relativeTime: 'now',
      messages: [activeMessage]
    }
    const state = {
      activeSessionId: 'active',
      messages: [activeMessage],
      sessions: [unrelatedSession, activeSession]
    } as ChatState

    const result = updateMessageInState(state, 'target', (current) => ({
      ...current,
      content: current.content + 'updated'
    }))

    expect(result.messages?.[0].content).toBe('updated')
    expect(result.sessions?.[1].messages[0]).toBe(result.messages?.[0])
  })

  it('updates an inactive session without replacing active messages', () => {
    const activeMessage = message('active-message', 'active')
    const backgroundMessage = message('background-message', 'before')
    const state = {
      activeSessionId: 'active',
      messages: [activeMessage],
      sessions: [
        { id: 'active', messages: [activeMessage] },
        { id: 'background', messages: [backgroundMessage] }
      ]
    } as ChatState

    const result = updateMessageInState(state, 'background-message', (current) => ({
      ...current,
      content: 'after'
    }))

    expect(result.messages).toBeUndefined()
    expect(result.sessions?.[0]).toBe(state.sessions[0])
    expect(result.sessions?.[1].messages[0].content).toBe('after')
  })
})
