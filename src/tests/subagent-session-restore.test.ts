import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../renderer/src/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspace: null })
  }
}))

describe('chat store sub-agent session restore', () => {
  beforeEach(async () => {
    vi.resetModules()
    ;(globalThis as any).window = {
      api: {
        chat: {
          getRuntimeStatus: vi.fn()
        },
        session: {
          list: vi.fn(),
          get: vi.fn(),
          save: vi.fn(),
          delete: vi.fn()
        }
      }
    }
  })

  it('uses main-process authority before classifying a running sub-agent as interrupted', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const session = {
      id: 's1',
      projectId: 'p1',
      summary: 'Interrupted sub-agent session',
      relativeTime: 'now',
      messages: [
        {
          id: 'm1',
          role: 'agent',
          content: '',
          streaming: true,
          subAgents: [
            {
              id: 'subagent_Research_df42308184e13ef3_tool_1',
              type: 'Research',
              description: '分析项目进度',
              prompt: '请分析当前项目进度并汇总风险。',
              context: '只分析当前实现，不考虑旧版目录。',
              scope: { directories: ['src'], excludeGlobs: ['**/*.test.ts'] },
              parentToolCallId: 'tool_1',
              status: 'running',
              startedAt: 1000,
              content: '已读取 package.json',
              toolCalls: [],
              executionTimeline: []
            }
          ]
        }
      ]
    }

    ;(window as any).api.session.get.mockResolvedValue(session)
    ;(window as any).api.chat.getRuntimeStatus.mockResolvedValue({
      sessionId: 's1',
      mainRunnerActive: true,
      activeSubAgentIds: ['subagent_Research_df42308184e13ef3_tool_1']
    })
    useChatStore.setState({
      sessions: [session as any],
      activeSessionId: null,
      messages: [],
      pendingPrompt: null,
      pendingInternalContinuation: null
    })

    await useChatStore.getState().selectSession('s1')

    expect(useChatStore.getState().messages[0].subAgents![0].status).toBe('running')
    expect(useChatStore.getState().messages[0].streaming).toBe(true)
    expect(useChatStore.getState().pendingPrompt).toBeNull()

    ;(window as any).api.chat.getRuntimeStatus.mockResolvedValue({
      sessionId: 's1',
      mainRunnerActive: false,
      activeSubAgentIds: []
    })
    useChatStore.setState({ activeSessionId: null, messages: [], sessions: [session as any] })
    await useChatStore.getState().selectSession('s1')

    const restored = useChatStore.getState().messages[0].subAgents![0]
    expect(restored.status).toBe('interrupted')
    expect(useChatStore.getState().messages[0].streaming).toBe(false)
    expect(useChatStore.getState().messages[0].interrupted).toBe(true)
    expect(useChatStore.getState().pendingPrompt).toBeNull()
    expect(useChatStore.getState().pendingInternalContinuation).toMatchObject({ sessionId: 's1' })
    expect(useChatStore.getState().pendingInternalContinuation?.text).toContain(
      '"resume_subagent_id":"subagent_Research_df42308184e13ef3_tool_1"'
    )
    expect(useChatStore.getState().pendingInternalContinuation?.text).toContain(
      'Do not restart, re-plan, re-inspect completed work'
    )
    expect(useChatStore.getState().pendingInternalContinuation?.text).toContain(
      '"context":"只分析当前实现，不考虑旧版目录。"'
    )
    expect(useChatStore.getState().pendingInternalContinuation?.text).toContain(
      '"scope":{"directories":["src"],"excludeGlobs":["**/*.test.ts"]}'
    )
    expect((window as any).api.session.save).toHaveBeenCalled()

    const savedSession = (window as any).api.session.save.mock.calls.at(-1)[0]
    useChatStore.getState().consumeInternalContinuation('s1')
    ;(window as any).api.session.get.mockResolvedValue(savedSession)
    useChatStore.setState({
      activeSessionId: null,
      messages: [],
      sessions: [savedSession],
      pendingInternalContinuation: null
    })

    await useChatStore.getState().selectSession('s1')

    expect(useChatStore.getState().pendingInternalContinuation?.text).toContain(
      '"resume_subagent_id":"subagent_Research_df42308184e13ef3_tool_1"'
    )
  })
})
