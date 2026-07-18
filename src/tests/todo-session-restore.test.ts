import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TodoItem } from '../shared/types/todo'

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

describe('chat store Todo session restore', () => {
  const unfinishedTodos: TodoItem[] = [
    { id: 't1', subject: 'Continue persistence work', description: '', status: 'in_progress' },
    { id: 't2', subject: 'Verify restore', description: '', status: 'pending' }
  ]

  beforeEach(async () => {
    vi.resetModules()
    ;(globalThis as any).window = {
      electron: {
        ipcRenderer: {
          invoke: vi.fn().mockResolvedValue({ historyVersion: 1 })
        }
      },
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

  it('selectSession loads persisted unfinished Todos and expands the Todo capsule', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const session = {
      id: 's1',
      projectId: 'p1',
      summary: 'Todo session',
      relativeTime: 'now',
      messages: [],
      tasks: unfinishedTodos
    }

    ;(window as any).api.session.get.mockResolvedValue(session)
    useChatStore.setState({
      sessions: [{ ...session, todos: [] } as any],
      activeSessionId: null,
      messages: [],
      todos: [],
      expandedCapsule: null
    })

    await useChatStore.getState().selectSession('s1')

    expect(useChatStore.getState().todos).toEqual(unfinishedTodos)
    expect(useChatStore.getState().expandedCapsule).toBe('todo')
  })

  it('selectSession loads completed Todos without auto-expanding the Todo capsule', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const completedTodos: TodoItem[] = [
      { id: 't1', subject: 'Done', description: '', status: 'completed' }
    ]
    const session = {
      id: 's1',
      projectId: 'p1',
      summary: 'Done session',
      relativeTime: 'now',
      messages: [],
      tasks: completedTodos
    }

    ;(window as any).api.session.get.mockResolvedValue(session)
    useChatStore.setState({
      sessions: [{ ...session, todos: [] } as any],
      activeSessionId: null,
      messages: [],
      todos: [],
      expandedCapsule: null
    })

    await useChatStore.getState().selectSession('s1')

    expect(useChatStore.getState().todos).toEqual(completedTodos)
    expect(useChatStore.getState().expandedCapsule).toBeNull()
  })

  it('createSession clears Todo presentation state and invalidates a pending selection', async () => {
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
          todos: unfinishedTodos
        } as any
      ],
      activeSessionId: 'old',
      messages: [],
      todos: unfinishedTodos,
      expandedCapsule: 'todo'
    })

    const pendingSelection = useChatStore.getState().selectSession('old')
    const newSessionId = useChatStore.getState().createSession('p1')
    resolveSelection?.({
      id: 'old',
      projectId: 'p1',
      summary: 'Old session',
      relativeTime: 'now',
      messages: [],
      tasks: unfinishedTodos
    })
    await pendingSelection

    const state = useChatStore.getState()
    expect(state.activeSessionId).toBe(newSessionId)
    expect(state.todos).toEqual([])
    expect(state.expandedCapsule).toBeNull()
    expect(state.sessions.find((session) => session.id === newSessionId)?.todos).toEqual([])
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
          todos: unfinishedTodos
        } as any
      ],
      activeSessionId: 'old',
      messages: [],
      todos: unfinishedTodos,
      expandedCapsule: 'todo'
    })

    const pendingSelection = useChatStore.getState().selectSession('old')
    const newSessionId = useChatStore.getState().createSession('p1')
    rejectSelection?.(new Error('selection failed'))
    await pendingSelection

    const state = useChatStore.getState()
    expect(state.activeSessionId).toBe(newSessionId)
    expect(state.todos).toEqual([])
    expect(state.expandedCapsule).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      '[sessionSlice.selectSession] Failed to load from disk:',
      expect.any(Error)
    )
    errorSpy.mockRestore()
  })

  it('selectSession closes an inherited Todo capsule when the target has no active Todos', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const terminalTodos: TodoItem[] = [
      { id: 't1', subject: 'Done', description: '', status: 'completed' },
      { id: 't2', subject: 'Stopped', description: '', status: 'cancelled' }
    ]
    const session = {
      id: 'done',
      projectId: 'p1',
      summary: 'Terminal Todos',
      relativeTime: 'now',
      messages: [],
      tasks: terminalTodos
    }

    ;(window as any).api.session.get.mockResolvedValue(session)
    useChatStore.setState({
      sessions: [session as any],
      activeSessionId: 'other',
      messages: [],
      todos: unfinishedTodos,
      expandedCapsule: 'todo'
    })

    await useChatStore.getState().selectSession('done')

    expect(useChatStore.getState().todos).toEqual(terminalTodos)
    expect(useChatStore.getState().expandedCapsule).toBeNull()
  })

  it('setTodos also updates the active session so persisted session data stays current', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    useChatStore.setState({
      sessions: [
        {
          id: 's1',
          projectId: 'p1',
          summary: 'Todo session',
          relativeTime: 'now',
          messages: [],
          todos: []
        } as any
      ],
      activeSessionId: 's1',
      messages: [],
      todos: []
    })

    useChatStore.getState().setTodos(unfinishedTodos)

    expect(useChatStore.getState().sessions[0].todos).toEqual(unfinishedTodos)
  })

  it('setSessionTodos updates a background session without replacing visible Todos', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const backgroundTodos: TodoItem[] = [
      { id: 't9', subject: 'Background Executor', description: '', status: 'in_progress' }
    ]
    const activeUpdateTodos: TodoItem[] = [
      { id: 't1', subject: 'Active Executor completed', description: '', status: 'completed' }
    ]
    useChatStore.setState({
      sessions: [
        { id: 's1', projectId: 'p1', summary: 'Active', relativeTime: 'now', messages: [], todos: unfinishedTodos } as any,
        { id: 's2', projectId: 'p1', summary: 'Background', relativeTime: 'now', messages: [], todos: [] } as any
      ],
      activeSessionId: 's1',
      todos: unfinishedTodos
    })

    useChatStore.getState().setSessionTodos('s2', backgroundTodos)

    expect(useChatStore.getState().todos).toEqual(unfinishedTodos)
    expect(useChatStore.getState().sessions.find(session => session.id === 's2')?.todos).toEqual(backgroundTodos)

    useChatStore.getState().setSessionTodos('s1', activeUpdateTodos)
    expect(useChatStore.getState().todos).toEqual(activeUpdateTodos)
  })

  it('does not write legacy Executor state back through the Todo compatibility field', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const session = {
      id: 's1',
      projectId: 'p1',
      summary: 'Legacy Todo session',
      relativeTime: 'now',
      messages: [],
      tasks: [{
        ...unfinishedTodos[0],
        executorRuntime: { executionId: 'legacy-execution' }
      }]
    }
    ;(window as any).api.session.get.mockResolvedValue(session)
    useChatStore.setState({
      sessions: [{ ...session, todos: [] } as any],
      activeSessionId: null,
      messages: [],
      todos: []
    })

    await useChatStore.getState().selectSession('s1')
    await useChatStore.getState().persistCurrentSession()

    const savedSession = (window as any).api.session.save.mock.calls.at(-1)?.[0]
    expect(savedSession.tasks[0]).not.toHaveProperty('executorRuntime')
    expect(savedSession).not.toHaveProperty('todos')
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
    expect((window as any).electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'chat:revert-messages', 's1', 'u1', []
    )
  })

  it('previews a revert through the desktop facade with newest transactions first', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'retry from here' },
      { id: 'a1', role: 'agent' as const, content: 'first answer', txId: 'tx-1' },
      { id: 'u2', role: 'user' as const, content: 'follow up' },
      { id: 'a2', role: 'agent' as const, content: 'second answer', txId: 'tx-2' }
    ]
    const preview = { toDelete: ['created.ts'], toRestore: ['changed.ts'] }
    ;(window as any).electron.ipcRenderer.invoke.mockResolvedValue(preview)
    useChatStore.setState({
      sessions: [{
        id: 's1', projectId: 'p1', summary: 'x', relativeTime: 'now', messages
      }],
      activeSessionId: 's1',
      messages
    } as any)

    await expect(useChatStore.getState().previewRevertMessage('u1')).resolves.toEqual(preview)
    expect((window as any).electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'chat:preview-revert-messages', 's1', 'u1', ['tx-2', 'tx-1']
    )
  })

  it('finishes a pending revert against its original session after switching sessions', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    let resolveRevert: ((value: unknown) => void) | undefined
    ;(window as any).electron.ipcRenderer.invoke.mockReturnValue(new Promise((resolve) => {
      resolveRevert = resolve
    }))
    const aMessages = [
      { id: 'a-user', role: 'user' as const, content: 'retry me' },
      { id: 'a-agent', role: 'agent' as const, content: 'answer', txId: 'tx-a' }
    ]
    const bMessages = [{ id: 'b-user', role: 'user' as const, content: 'keep B' }]
    useChatStore.setState({
      sessions: [
        { id: 'a', projectId: 'p', summary: 'A', relativeTime: 'now', messages: aMessages },
        { id: 'b', projectId: 'p', summary: 'B', relativeTime: 'now', messages: bMessages }
      ],
      activeSessionId: 'a', messages: aMessages, pendingPrompt: null, composerDrafts: {}
    } as any)

    const pending = useChatStore.getState().revertToMessage('a-user')
    useChatStore.setState({ activeSessionId: 'b', messages: bMessages })
    resolveRevert?.({ historyVersion: 3 })
    await pending

    const state = useChatStore.getState()
    expect(state.sessions.find((session) => session.id === 'a')?.messages).toEqual([])
    expect(state.sessions.find((session) => session.id === 'b')?.messages).toEqual(bMessages)
    expect(state.messages).toEqual(bMessages)
    expect(state.composerDrafts.a).toEqual({ text: 'retry me', attachments: [] })
    expect((window as any).api.session.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', messages: [] })
    )
  })

  it('does not overwrite a session whose message revision changed while revert was pending', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let resolveRevert: ((value: unknown) => void) | undefined
    ;(window as any).electron.ipcRenderer.invoke.mockReturnValue(new Promise((resolve) => {
      resolveRevert = resolve
    }))
    const messages = [{ id: 'u1', role: 'user' as const, content: 'original' }]
    useChatStore.setState({
      sessions: [{ id: 's1', projectId: 'p', summary: 'S', relativeTime: 'now', messages }],
      activeSessionId: 's1', messages, pendingPrompt: null
    } as any)

    const pending = useChatStore.getState().revertToMessage('u1')
    const changed = [...messages, { id: 'new', role: 'system' as const, content: 'new event' }]
    useChatStore.setState({
      sessions: [{ id: 's1', projectId: 'p', summary: 'S', relativeTime: 'now', messages: changed }],
      messages: changed
    } as any)
    resolveRevert?.({ historyVersion: 2 })
    await pending

    expect(useChatStore.getState().messages).toEqual(changed)
    expect((window as any).api.session.save).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('refusing stale UI overwrite'))
    errorSpy.mockRestore()
  })
})
