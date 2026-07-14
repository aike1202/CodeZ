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
          streamPhase: 'starting',
          responseWaitWarning: true,
          subAgents: [
            {
              id: 'subagent_Explore_df42308184e13ef3_tool_1',
              type: 'Explore',
              description: '分析项目进度',
              prompt: '请分析当前项目进度并汇总风险。',
              context: '只分析当前实现，不考虑旧版目录。',
              scope: { directories: ['src'], excludeGlobs: ['**/*.test.ts'] },
              parentToolCallId: 'tool_1',
              status: 'running',
              startedAt: 1000,
              content: '已读取 package.json',
              toolCalls: [{
                id: 'write-1',
                name: 'Write',
                args: JSON.stringify({ file_path: 'src/recovered.ts', content: 'export {}' }),
                status: 'success',
                result: JSON.stringify({ ok: true, data: 'Wrote src/recovered.ts' }),
                startedAt: 1100,
                completedAt: 1200,
                sequence: 0
              }, {
                id: 'edit-running',
                name: 'Edit',
                args: JSON.stringify({
                  file_path: 'src/maybe.ts',
                  edits: [{ old_string: 'a', new_string: 'b' }]
                }),
                status: 'running',
                startedAt: 1300,
                sequence: 1
              }, {
                id: 'shell-running',
                name: 'PowerShell',
                args: JSON.stringify({ command: 'npm run generate' }),
                status: 'running',
                startedAt: 1400,
                sequence: 2
              }],
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
      activeSubAgentIds: ['subagent_Explore_df42308184e13ef3_tool_1']
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
    expect(restored.result?.handoff).toMatchObject({
      reasonCode: 'runtime_missing',
      filesModified: ['src/recovered.ts'],
      filesPossiblyModified: ['src/maybe.ts'],
      workspaceMayHaveUntrackedChanges: true,
      recentTools: expect.arrayContaining([expect.objectContaining({
        name: 'Write', status: 'success', target: 'src/recovered.ts'
      })]),
      canResume: true
    })
    expect(useChatStore.getState().messages[0].streaming).toBe(false)
    expect(useChatStore.getState().messages[0].interrupted).toBe(true)
    expect(useChatStore.getState().pendingPrompt).toBeNull()
    expect(useChatStore.getState().messages[0]).toMatchObject({
      streaming: false,
      interrupted: true,
      executionStatus: 'interrupted'
    })
    expect(useChatStore.getState().messages[0].streamPhase).toBeUndefined()
    expect(useChatStore.getState().messages[0].responseWaitWarning).toBeUndefined()
    expect(useChatStore.getState().pendingInternalContinuation).toBeNull()
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

    expect(useChatStore.getState().pendingInternalContinuation).toBeNull()
  })

  it('restores a stale starting message as interrupted when runtime status is unavailable', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = {
      id: 's-runtime-unavailable',
      projectId: 'p1',
      summary: 'Stale starting session',
      relativeTime: 'now',
      messages: [{
        id: 'agent-starting',
        role: 'agent',
        content: '',
        streaming: true,
        streamPhase: 'starting',
        responseWaitWarning: true
      }]
    }
    ;(window as any).api.session.get.mockResolvedValue(session)
    ;(window as any).api.chat.getRuntimeStatus.mockRejectedValue(new Error('IPC unavailable'))
    useChatStore.setState({
      sessions: [session as any],
      activeSessionId: null,
      messages: [],
      pendingInternalContinuation: null
    })

    await useChatStore.getState().selectSession(session.id)

    expect(useChatStore.getState().messages[0]).toMatchObject({
      streaming: false,
      interrupted: true,
      executionStatus: 'interrupted'
    })
    expect(useChatStore.getState().messages[0].streamPhase).toBeUndefined()
    expect(useChatStore.getState().messages[0].responseWaitWarning).toBeUndefined()
    expect(useChatStore.getState().pendingInternalContinuation).toBeNull()
    expect((window as any).api.session.save).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('bridges a terminal subagent whose result may not have reached the parent ledger', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const session = {
      id: 's2',
      projectId: 'p1',
      summary: 'Undelivered completed subagent',
      relativeTime: 'now',
      messages: [{
        id: 'agent-undelivered',
        role: 'agent',
        content: '',
        streaming: true,
        subAgents: [{
          id: 'subagent_Explore_df42308184e13ef3_tool_2',
          type: 'Explore',
          description: '分析项目进度',
          prompt: '请分析当前项目进度并汇总风险。',
          context: '只分析当前实现，不考虑旧版目录。',
          scope: { directories: ['src'], excludeGlobs: ['**/*.test.ts'] },
          parentToolCallId: 'tool_2',
          status: 'completed',
          startedAt: 1000,
          completedAt: 2000,
          content: '分析已经完成。',
          toolCalls: [],
          executionTimeline: [],
          result: {
            output: '风险位于上下文恢复路径。',
            toolCallCount: 3,
            filesExamined: ['src/main.ts']
          }
        }]
      }]
    }
    ;(window as any).api.session.get.mockResolvedValue(session)
    ;(window as any).api.chat.getRuntimeStatus.mockResolvedValue({
      sessionId: 's2', mainRunnerActive: false, activeSubAgentIds: []
    })
    useChatStore.setState({
      sessions: [session as any],
      activeSessionId: null,
      messages: [],
      pendingInternalContinuation: null
    })

    await useChatStore.getState().selectSession('s2')

    const restored = useChatStore.getState().messages[0].subAgents?.[0]
    expect(restored).toMatchObject({
      status: 'completed',
      interruptionReason: 'parent_delivery_missing',
      result: {
        output: '风险位于上下文恢复路径。',
        handoff: {
          reasonCode: 'parent_delivery_missing',
          originalTask: '请分析当前项目进度并汇总风险。',
          filesExamined: ['src/main.ts'],
          canResume: true
        }
      }
    })
    expect(useChatStore.getState().pendingInternalContinuation).toBeNull()
  })
})
