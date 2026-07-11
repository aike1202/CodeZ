import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../shared/types/provider'

const chatMock = vi.hoisted(() => ({
  streamChat: vi.fn()
}))

vi.mock('../main/services/ChatService', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    streamChat: chatMock.streamChat
  }))
}))

describe('SubAgentManager parent abort propagation', () => {
  it('returns interrupted and removes the session handle when the parent aborts', async () => {
    const { SubAgentManager } = await import('../main/agent/SubAgentManager')

    SubAgentManager.register({
      type: 'ParentAbortTest',
      description: 'Parent abort test agent',
      whenToUse: 'test',
      maxLoops: 2,
      getTools: (): ToolDefinition[] => [],
      systemPromptBuilder: () => 'test subagent'
    })

    chatMock.streamChat.mockImplementationOnce(async (_config, callbacks) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      callbacks.onChunk('should not complete', '', undefined)
      callbacks.onDone('should not complete')
    })

    const parent = new AbortController()
    const resultPromise = SubAgentManager.spawn(
      'ParentAbortTest',
      {
        workspaceRoot: process.cwd(),
        sessionId: 'parent-abort-session',
        task: 'wait for parent abort',
        parentPrompt: 'wait for parent abort',
        subAgentId: 'subagent-parent-abort',
        parentSignal: parent.signal,
        apiConfig: {
          baseUrl: 'https://example.invalid',
          apiKey: 'key',
          apiFormat: 'openai',
          model: 'test-model'
        },
        contextCapabilities: { contextWindowTokens: 65_536, maxOutputTokens: 4_096 }
      },
      {
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn()
      }
    )

    await vi.waitFor(() => {
      expect(SubAgentManager.listActiveForSession('parent-abort-session')).toEqual([
        'subagent-parent-abort'
      ])
    })
    parent.abort()

    const result = await resultPromise
    expect(result.status).toBe('interrupted')
    expect(result.output).toContain('interrupted')
    expect(SubAgentManager.listActiveForSession('parent-abort-session')).toEqual([])
  })
})
