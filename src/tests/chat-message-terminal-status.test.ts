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
      sessionId: 's1', mainRunnerActive: true
    })
    expect(active.changed).toBe(false)
    expect(active.messages).toBe(messages)

    const inactive = interruptPendingRequests(messages, {
      sessionId: 's1', mainRunnerActive: false
    })
    expect(inactive.changed).toBe(true)
    expect(inactive.messages[0].permissionRequests?.[0]?.status).toBe('interrupted')
    expect(inactive.messages[0].askUserRequests?.[0]?.status).toBe('interrupted')
  })

})
