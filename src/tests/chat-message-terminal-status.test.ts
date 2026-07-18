import { beforeEach, describe, expect, it, vi } from 'vitest'
import { interruptPendingRequests } from '../renderer/src/stores/chatStore/slices/sessionSlice'

vi.mock('../renderer/src/stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ workspace: null }) }
}))

const saveSession = vi.hoisted(() => vi.fn())
vi.mock('../renderer/src/shared/desktop/api', () => ({
  desktopApi: { session: { save: saveSession } }
}))

describe('chat message terminal status', () => {
  beforeEach(() => {
    vi.resetModules()
    saveSession.mockReset()
  })

  it('stores a structured terminal status on the selected agent message', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const messages = [
      { id: 'user-1', role: 'user', content: 'run' },
      { id: 'agent-1', role: 'agent', content: 'failed' }
    ] as any
    useChatStore.setState({
      sessions: [{ id: 's1', projectId: 'p1', summary: 'run', relativeTime: 'now', messages }],
      activeSessionId: 's1',
      messages
    })

    useChatStore.getState().setMessageExecutionStatus('agent-1', 'error')
    expect(useChatStore.getState().messages[1].executionStatus).toBe('error')

    useChatStore.getState().setMessageExecutionStatus('agent-1', 'completed')
    expect(useChatStore.getState().messages[1].executionStatus).toBe('completed')
  })

  it('interrupts orphaned pending requests only for an inactive runtime', () => {
    const messages = [{
      id: 'agent-1',
      role: 'agent',
      content: '',
      permissionRequests: [{ id: 'permission-1', status: 'pending' }],
      askUserRequests: [{ id: 'question-1', status: 'pending' }]
    }] as any

    const active = interruptPendingRequests(messages, {
      sessionId: 's1', mainRunnerActive: true, activeSubAgentIds: []
    })
    expect(active.changed).toBe(false)
    expect(active.messages).toBe(messages)

    const inactive = interruptPendingRequests(messages, {
      sessionId: 's1', mainRunnerActive: false, activeSubAgentIds: []
    })
    expect(inactive.changed).toBe(true)
    expect(inactive.messages[0].permissionRequests?.[0]?.status).toBe('interrupted')
    expect(inactive.messages[0].askUserRequests?.[0]?.status).toBe('interrupted')
  })

  it('does not mark a wrapped tool error as a successful subagent edit', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const messages = [{
      id: 'agent-1',
      role: 'agent',
      content: '',
      subAgents: [{
        id: 'subagent-1',
        type: 'Executor',
        description: 'edit',
        prompt: 'edit',
        parentToolCallId: 'tool-parent',
        status: 'running',
        startedAt: 1,
        content: '',
        toolCalls: [{
          id: 'write-1', name: 'Write', args: '{"file_path":"src/a.ts"}',
          status: 'running', startedAt: 2, sequence: 0
        }],
        executionTimeline: []
      }]
    }] as any
    useChatStore.setState({
      sessions: [{ id: 's1', projectId: 'p1', summary: 'run', relativeTime: 'now', messages }],
      activeSessionId: 's1',
      messages
    })

    useChatStore.getState().finishSubAgentToolCall(
      'agent-1',
      'subagent-1',
      'write-1',
      JSON.stringify({ ok: true, data: 'Error: write failed' })
    )

    expect(useChatStore.getState().messages[0].subAgents?.[0].toolCalls[0].status).toBe('error')
  })
})
