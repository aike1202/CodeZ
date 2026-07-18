import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../renderer/src/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspace: null })
  }
}))

const deleteSession = vi.hoisted(() => vi.fn())
vi.mock('../renderer/src/shared/desktop/api', () => ({
  desktopApi: { session: { delete: deleteSession } }
}))

function deferred<T>() {
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise
  })
  return { promise, reject }
}

describe('session deletion rollback', () => {
  beforeEach(() => {
    vi.resetModules()
    deleteSession.mockReset()
  })

  it('restores a soft-deleted active session when the desktop command rejects', async () => {
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const messages = [{ id: 'message-1', role: 'user', content: 'keep me' }]
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      summary: 'Active session',
      relativeTime: 'now',
      messages
    }
    deleteSession.mockRejectedValue(new Error('RUN_ACTIVE'))
    useChatStore.setState({
      sessions: [session as any],
      activeSessionId: session.id,
      messages: messages as any,
      composerDrafts: {}
    })

    await useChatStore.getState().deleteSession(session.id)

    const state = useChatStore.getState()
    expect(state.sessions[0]).toMatchObject({ id: session.id, isDeleted: undefined })
    expect({ activeSessionId: state.activeSessionId, messages: state.messages }).toEqual({
      activeSessionId: session.id,
      messages
    })
  })

  it('restores a permanently deleted session without replacing a newer selection', async () => {
    const pendingDelete = deferred<void>()
    const { useChatStore } = await import('../renderer/src/stores/chatStore')
    const deletedSession = {
      id: 'session-deleted',
      projectId: 'project-1',
      summary: 'Deleted session',
      relativeTime: 'now',
      messages: [],
      isDeleted: true,
      deletedAt: 1
    }
    const activeSession = {
      id: 'session-active',
      projectId: 'project-1',
      summary: 'New selection',
      relativeTime: 'now',
      messages: []
    }
    const draft = { text: 'restore draft', attachments: [] }
    deleteSession.mockReturnValue(pendingDelete.promise)
    useChatStore.setState({
      sessions: [deletedSession, activeSession] as any,
      activeSessionId: deletedSession.id,
      messages: [],
      composerDrafts: { [deletedSession.id]: draft }
    })

    const deletion = useChatStore.getState().deleteSession(deletedSession.id)
    const newerMessages = [{ id: 'message-2', role: 'user', content: 'new selection' }]
    useChatStore.setState({
      activeSessionId: activeSession.id,
      messages: newerMessages as any
    })
    pendingDelete.reject(new Error('RUN_ACTIVE'))
    await deletion

    const state = useChatStore.getState()
    expect(state.sessions.map((session) => session.id)).toEqual([
      deletedSession.id,
      activeSession.id
    ])
    expect({
      activeSessionId: state.activeSessionId,
      messages: state.messages,
      draft: state.composerDrafts[deletedSession.id]
    }).toEqual({
      activeSessionId: activeSession.id,
      messages: newerMessages,
      draft
    })
  })
})
