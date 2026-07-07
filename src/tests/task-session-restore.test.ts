import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskItem } from '../shared/types/task'

vi.mock('../renderer/src/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspace: null })
  }
}))

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
})
