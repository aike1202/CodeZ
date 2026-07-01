import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TaskUpdateTool } from '../main/tools/builtin/TaskUpdateTool'

const tasks: any[] = []

vi.mock('../main/services/TaskStore', () => ({
  TaskStore: vi.fn().mockImplementation(() => ({
    load: vi.fn(async () => {}),
    save: vi.fn(async (t: any) => {
      const idx = tasks.findIndex((x) => x.id === t.id)
      if (idx >= 0) tasks[idx] = t
      else tasks.push(t)
    }),
    getById: vi.fn((id: string) => tasks.find((t) => t.id === id)),
    getBySession: vi.fn((_sessionId: string) => tasks),
    updateStatus: vi.fn(async (id: string, status: string) => {
      const t = tasks.find((x) => x.id === id)
      if (t) {
        t.status = status
        t.updatedAt = new Date().toISOString()
      }
    }),
    addDependency: vi.fn(async (taskId: string, blockedByTaskId: string) => {
      const task = tasks.find((t) => t.id === taskId)
      const blocker = tasks.find((t) => t.id === blockedByTaskId)
      if (task && blocker) {
        if (!task.blockedBy.includes(blockedByTaskId)) {
          task.blockedBy.push(blockedByTaskId)
        }
        if (!blocker.blocks.includes(taskId)) {
          blocker.blocks.push(taskId)
        }
      }
    }),
    removeDependency: vi.fn(async (taskId: string, blockedByTaskId: string) => {
      const task = tasks.find((t) => t.id === taskId)
      const blocker = tasks.find((t) => t.id === blockedByTaskId)
      if (task) task.blockedBy = task.blockedBy.filter((id: string) => id !== blockedByTaskId)
      if (blocker) blocker.blocks = blocker.blocks.filter((id: string) => id !== taskId)
    }),
    delete: vi.fn(async (_id: string) => {}),
  })),
}))

vi.mock('../main/ipc/task.handlers', () => ({
  notifyTaskUpsert: vi.fn(),
  notifyTaskSync: vi.fn(),
}))

describe('TaskUpdateTool', () => {
  let tool: TaskUpdateTool

  beforeEach(async () => {
    tasks.length = 0
    tool = new TaskUpdateTool()
    // Seed tasks: t1 is in_progress, t2 is pending
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = new TaskStore()
    await store.save({
      id: 't1',
      sessionId: 's1',
      subject: 'Task 1',
      description: '',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
      owner: 'main-agent',
      createdAt: '',
      updatedAt: '',
    })
    await store.save({
      id: 't2',
      sessionId: 's1',
      subject: 'Task 2',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      owner: 'main-agent',
      createdAt: '',
      updatedAt: '',
    })
  })

  it('should have correct name', () => {
    expect(tool.name).toBe('TaskUpdate')
  })

  it('should update status', async () => {
    const result = await tool.execute(
      JSON.stringify({ taskId: 't1', status: 'completed' }),
      { workspaceRoot: '/test', sessionId: 's1' },
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.status).toBe('completed')
  })

  it('should reject setting in_progress when another task already in_progress', async () => {
    // t1 is already in_progress from seed
    const result = await tool.execute(
      JSON.stringify({ taskId: 't2', status: 'in_progress' }),
      { workspaceRoot: '/test', sessionId: 's1' },
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('ALREADY_IN_PROGRESS')
  })

  it('should reject completing a task that is still blocked', async () => {
    // Make t1 blocked by t2 (t2 is pending)
    const { TaskStore } = await import('../main/services/TaskStore')
    const store = new TaskStore()
    await store.addDependency('t1', 't2')
    const result = await tool.execute(
      JSON.stringify({ taskId: 't1', status: 'completed' }),
      { workspaceRoot: '/test', sessionId: 's1' },
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('BLOCKED')
  })

  it('should update subject and description', async () => {
    const result = await tool.execute(
      JSON.stringify({
        taskId: 't1',
        subject: 'Updated subject',
        description: 'Updated description',
      }),
      { workspaceRoot: '/test', sessionId: 's1' },
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.subject).toBe('Updated subject')
    expect(parsed.data.description).toBe('Updated description')
    expect(parsed.data.status).toBe('in_progress') // status unchanged
  })

  it('should return NOT_FOUND for non-existent task', async () => {
    const result = await tool.execute(
      JSON.stringify({ taskId: 'nonexistent', status: 'completed' }),
      { workspaceRoot: '/test', sessionId: 's1' },
    )
    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('NOT_FOUND')
  })
})
