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
        session: {
          list: vi.fn(),
          get: vi.fn(),
          save: vi.fn(),
          delete: vi.fn()
        }
      }
    }
  })

  it('marks running sub-agents as interrupted and prepares a continuation prompt on session select', async () => {
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
              id: 'subagent_tool_1',
              type: 'Research',
              description: '分析项目进度',
              prompt: '请分析当前项目进度并汇总风险。',
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
    useChatStore.setState({
      sessions: [session as any],
      activeSessionId: null,
      messages: [],
      pendingPrompt: null
    })

    await useChatStore.getState().selectSession('s1')

    const restored = useChatStore.getState().messages[0].subAgents![0]
    expect(restored.status).toBe('interrupted')
    expect(useChatStore.getState().messages[0].streaming).toBe(false)
    expect(useChatStore.getState().messages[0].interrupted).toBe(true)
    expect(useChatStore.getState().pendingPrompt).toContain('继续刚才中断的子智能体任务')
    expect(useChatStore.getState().pendingPrompt).toContain('分析项目进度')
    expect(useChatStore.getState().pendingPrompt).toContain('请分析当前项目进度并汇总风险。')
    expect((window as any).api.session.save).toHaveBeenCalled()
  })
})
