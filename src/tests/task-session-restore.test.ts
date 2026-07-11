import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskItem } from '../shared/types/task'

vi.mock('../renderer/src/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspace: null })
  }
}))

function imageAttachmentFixture() {
  return {
    id: 'img1',
    kind: 'image' as const,
    name: 'photo.jpg',
    mimeType: 'image/jpeg' as const,
    width: 800,
    height: 600,
    sizeBytes: 123,
    storageKey: 'attachment:sessions/s1/img1',
    scope: 'session' as const,
    sessionId: 's1'
  }
}

describe('chat store task session restore', () => {
  const unfinishedTasks: TaskItem[] = [
    { id: 't1', subject: 'Continue persistence work', description: '', status: 'in_progress' },
    { id: 't2', subject: 'Verify restore', description: '', status: 'pending' }
  ]

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

  it('selectSession loads persisted unfinished tasks and expands task capsule', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const session = {
      id: 's1',
      projectId: 'p1',
      summary: 'Task session',
      relativeTime: 'now',
      messages: [],
      tasks: unfinishedTasks
    }

    ;(window as any).api.session.get.mockResolvedValue(session)
    useChatStore.setState({
      sessions: [{ ...session, tasks: [] } as any],
      activeSessionId: null,
      messages: [],
      tasks: [],
      expandedCapsule: null
    })

    await useChatStore.getState().selectSession('s1')

    expect(useChatStore.getState().tasks).toEqual(unfinishedTasks)
    expect(useChatStore.getState().expandedCapsule).toBe('task')
  })

  it('selectSession loads completed tasks without auto-expanding task capsule', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const completedTasks: TaskItem[] = [
      { id: 't1', subject: 'Done', description: '', status: 'completed' }
    ]
    const session = {
      id: 's1',
      projectId: 'p1',
      summary: 'Done session',
      relativeTime: 'now',
      messages: [],
      tasks: completedTasks
    }

    ;(window as any).api.session.get.mockResolvedValue(session)
    useChatStore.setState({
      sessions: [{ ...session, tasks: [] } as any],
      activeSessionId: null,
      messages: [],
      tasks: [],
      expandedCapsule: null
    })

    await useChatStore.getState().selectSession('s1')

    expect(useChatStore.getState().tasks).toEqual(completedTasks)
    expect(useChatStore.getState().expandedCapsule).toBeNull()
  })

  it('createSession clears task presentation state and invalidates a pending selection', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    let resolveSelection: ((session: any) => void) | undefined
    ;(window as any).api.session.get.mockReturnValue(new Promise((resolve) => {
      resolveSelection = resolve
    }))

    useChatStore.setState({
      sessions: [
        {
          id: 'old',
          projectId: 'p1',
          summary: 'Old session',
          relativeTime: 'now',
          messages: [],
          tasks: unfinishedTasks
        } as any
      ],
      activeSessionId: 'old',
      messages: [],
      tasks: unfinishedTasks,
      expandedCapsule: 'task'
    })

    const pendingSelection = useChatStore.getState().selectSession('old')
    const newSessionId = useChatStore.getState().createSession('p1')
    resolveSelection?.({
      id: 'old',
      projectId: 'p1',
      summary: 'Old session',
      relativeTime: 'now',
      messages: [],
      tasks: unfinishedTasks
    })
    await pendingSelection

    const state = useChatStore.getState()
    expect(state.activeSessionId).toBe(newSessionId)
    expect(state.tasks).toEqual([])
    expect(state.expandedCapsule).toBeNull()
    expect(state.sessions.find((session) => session.id === newSessionId)?.tasks).toEqual([])
  })

  it('createSession remains active when an older selection rejects after creation', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let rejectSelection: ((error: Error) => void) | undefined
    ;(window as any).api.session.get.mockReturnValue(new Promise((_resolve, reject) => {
      rejectSelection = reject
    }))

    useChatStore.setState({
      sessions: [
        {
          id: 'old',
          projectId: 'p1',
          summary: 'Old session',
          relativeTime: 'now',
          messages: [],
          tasks: unfinishedTasks
        } as any
      ],
      activeSessionId: 'old',
      messages: [],
      tasks: unfinishedTasks,
      expandedCapsule: 'task'
    })

    const pendingSelection = useChatStore.getState().selectSession('old')
    const newSessionId = useChatStore.getState().createSession('p1')
    rejectSelection?.(new Error('selection failed'))
    await pendingSelection

    const state = useChatStore.getState()
    expect(state.activeSessionId).toBe(newSessionId)
    expect(state.tasks).toEqual([])
    expect(state.expandedCapsule).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      '[sessionSlice.selectSession] Failed to load from disk:',
      expect.any(Error)
    )
    errorSpy.mockRestore()
  })

  it('selectSession closes an inherited task capsule when the target has no active tasks', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const terminalTasks: TaskItem[] = [
      { id: 't1', subject: 'Done', description: '', status: 'completed' },
      { id: 't2', subject: 'Stopped', description: '', status: 'cancelled' }
    ]
    const session = {
      id: 'done',
      projectId: 'p1',
      summary: 'Terminal tasks',
      relativeTime: 'now',
      messages: [],
      tasks: terminalTasks
    }

    ;(window as any).api.session.get.mockResolvedValue(session)
    useChatStore.setState({
      sessions: [session as any],
      activeSessionId: 'other',
      messages: [],
      tasks: unfinishedTasks,
      expandedCapsule: 'task'
    })

    await useChatStore.getState().selectSession('done')

    expect(useChatStore.getState().tasks).toEqual(terminalTasks)
    expect(useChatStore.getState().expandedCapsule).toBeNull()
  })

  it('setTasks also updates the active session so persisted session data stays current', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    useChatStore.setState({
      sessions: [
        {
          id: 's1',
          projectId: 'p1',
          summary: 'Task session',
          relativeTime: 'now',
          messages: [],
          tasks: []
        } as any
      ],
      activeSessionId: 's1',
      messages: [],
      tasks: []
    })

    useChatStore.getState().setTasks(unfinishedTasks)

    expect(useChatStore.getState().sessions[0].tasks).toEqual(unfinishedTasks)
  })

  it('revert restores text and images as one pending composer draft', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const attachment = imageAttachmentFixture()
    const message = {
      id: 'u1',
      role: 'user' as const,
      content: 'inspect',
      attachments: [attachment]
    }
    const session = {
      id: 's1',
      projectId: 'p1',
      summary: 'x',
      relativeTime: 'now',
      messages: [message]
    }
    useChatStore.setState({
      sessions: [session],
      activeSessionId: 's1',
      messages: [message],
      pendingPrompt: null
    } as any)

    await useChatStore.getState().revertToMessage('u1')

    expect(useChatStore.getState().pendingPrompt).toEqual({
      text: 'inspect',
      attachments: [attachment]
    })
    expect(useChatStore.getState().messages).toEqual([])
    expect(useChatStore.getState().sessions[0].messages).toEqual([])
  })
})
