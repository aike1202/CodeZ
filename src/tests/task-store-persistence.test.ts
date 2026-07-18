import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveMock = vi.hoisted(() => vi.fn())
const sessionRecord = vi.hoisted(() => ({
  id: 's1',
  projectId: 'p1',
  summary: 'Task session',
  relativeTime: 'now',
  messages: [] as any[],
  tasks: [] as any[]
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) }
}))

vi.mock('../main/ipc/session.handlers', () => ({
  getSessionStore: () => ({
    get: (sessionId: string) => sessionId === sessionRecord.id ? sessionRecord : undefined,
    save: saveMock
  })
}))

describe('TaskStore persistence', () => {
  beforeEach(async () => {
    vi.resetModules()
    saveMock.mockReset()
    sessionRecord.tasks = []
  })

  it('writes created tasks back to the session', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = TaskStore.getInstance()

    store.create('s1', [{ subject: 'Persist task', description: 'must survive reopen' }])

    expect(sessionRecord.tasks).toEqual([
      expect.objectContaining({ id: 't1', subject: 'Persist task', status: 'pending' })
    ])
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1',
      tasks: sessionRecord.tasks
    }))
  })

  it('starts a fresh task list after the previous list is finished', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = TaskStore.getInstance()
    store.create('s1', [
      { subject: 'First task' },
      { subject: 'Second task' }
    ])
    store.update('s1', 't1', { status: 'completed' })
    store.update('s1', 't2', { status: 'cancelled' })

    store.create('s1', [{ subject: 'Next task' }])

    expect(store.list('s1')).toEqual([
      expect.objectContaining({ id: 't3', subject: 'Next task', status: 'pending' })
    ])
    expect(sessionRecord.tasks).toEqual(store.list('s1'))
  })

  it('keeps appending while the current task list has unfinished work', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = TaskStore.getInstance()
    store.create('s1', [
      { subject: 'Completed task' },
      { subject: 'Pending task' }
    ])
    store.update('s1', 't1', { status: 'completed' })

    store.create('s1', [{ subject: 'Appended task' }])

    expect(store.list('s1').map(task => ({ id: task.id, status: task.status }))).toEqual([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'pending' },
      { id: 't3', status: 'pending' }
    ])
  })

  it('persists task group approval metadata on created tasks', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = TaskStore.getInstance()

    store.create('s1', [
      {
        subject: 'Design migration',
        description: 'unify plan and task concepts',
        groupId: 'tg1',
        groupTitle: 'Unified Task System',
        riskLevel: 'high',
        requiresApproval: true,
        approvalStatus: 'pending',
        acceptanceCriteria: ['Plan entry is no longer exposed by default'],
        verificationCommand: 'npm test -- task-store-persistence'
      }
    ])

    expect(sessionRecord.tasks[0]).toMatchObject({
      id: 't1',
      groupId: 'tg1',
      groupTitle: 'Unified Task System',
      riskLevel: 'high',
      requiresApproval: true,
      approvalStatus: 'pending',
      acceptanceCriteria: ['Plan entry is no longer exposed by default'],
      verificationCommand: 'npm test -- task-store-persistence'
    })
  })

  it('persists the research and Plan context bundle for delegation', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = TaskStore.getInstance()
    const contextBundle = {
      knownFacts: ['Sidebar status comes from streamCleanups'],
      decisions: ['Use one derived session status'],
      excludedDirections: ['Do not parse error message text'],
      sourceReferences: ['useAppWorkspace.ts:151-178 @ abc']
    }

    store.create('s1', [{ subject: 'Implement status projection', contextBundle }])

    expect(sessionRecord.tasks[0]).toMatchObject({ contextBundle })
  })

  it('writes task status updates back to the session', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = TaskStore.getInstance()
    store.create('s1', [{ subject: 'Persist task' }])
    saveMock.mockClear()

    store.update('s1', 't1', { status: 'in_progress' })

    expect(sessionRecord.tasks[0]).toMatchObject({ id: 't1', status: 'in_progress' })
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1',
      tasks: sessionRecord.tasks
    }))
  })

  it('returns the complete updated Todo items for execution-log persistence', async () => {
    const { TodoUpdateTool } = await import('../main/tools/builtin/TaskUpdateTool')
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = TaskStore.getInstance()
    store.create('s1', [{
      subject: 'Verify lifecycle',
      description: 'Confirm terminal Task logging',
      files: ['src/task.ts'],
      acceptanceCriteria: ['Capsule no longer shows the Task'],
      verificationCommand: 'npm test -- task-store-persistence'
    }])

    const result = JSON.parse(await new TodoUpdateTool().execute(
      JSON.stringify({
        expectedRevision: 1,
        updates: [{ todoId: 't1', status: 'completed' }]
      }),
      { workspaceRoot: process.cwd(), sessionId: 's1' } as any
    ))

    expect(result.data.updated[0]).toMatchObject({
      id: 't1',
      subject: 'Verify lifecycle',
      description: 'Confirm terminal Task logging',
      status: 'completed',
      files: ['src/task.ts'],
      acceptanceCriteria: ['Capsule no longer shows the Task'],
      verificationCommand: 'npm test -- task-store-persistence'
    })
  })

  it('atomically completes the current Todo and starts the next', async () => {
    const { TodoUpdateTool } = await import('../main/tools/builtin/TaskUpdateTool')
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = TaskStore.getInstance()
    store.create('s1', [
      { subject: 'First task' },
      { subject: 'Second task' }
    ])
    store.update('s1', 't1', { status: 'in_progress' })

    const tool = new TodoUpdateTool()
    const result = JSON.parse(await tool.execute(JSON.stringify({
      expectedRevision: 2,
      updates: [
        { todoId: 't1', status: 'completed' },
        { todoId: 't2', status: 'in_progress' }
      ]
    }), {
      workspaceRoot: process.cwd(),
      sessionId: 's1'
    } as any))

    expect(result.ok).toBe(true)
    expect(result.data.revision).toBe(3)
    expect(store.list('s1').map(item => item.status)).toEqual(['completed', 'in_progress'])
  })

  it('clears persisted session tasks when the task list is cleared', async () => {
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = TaskStore.getInstance()
    store.create('s1', [{ subject: 'Persist task' }])
    saveMock.mockClear()

    store.clear('s1')

    expect(sessionRecord.tasks).toEqual([])
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1',
      tasks: []
    }))
  })
})
