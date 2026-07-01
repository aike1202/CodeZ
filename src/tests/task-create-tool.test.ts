import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TaskCreateTool } from '../main/tools/builtin/TaskCreateTool'

const savedTasks: any[] = []
const dependencyCalls: Array<[string, string]> = []

vi.mock('../main/services/TaskStore', () => ({
  TaskStore: vi.fn().mockImplementation(() => ({
    load: vi.fn(async () => {}),
    save: vi.fn(async (t: any) => {
      const idx = savedTasks.findIndex((x) => x.id === t.id)
      if (idx >= 0) savedTasks[idx] = t
      else savedTasks.push(t)
    }),
    addDependency: vi.fn(async (taskId: string, blockedByTaskId: string) => {
      dependencyCalls.push([taskId, blockedByTaskId])
    }),
    getById: vi.fn((id: string) => savedTasks.find((t) => t.id === id)),
    getBySession: vi.fn(() => savedTasks),
  })),
}))

vi.mock('../main/ipc/task.handlers', () => ({
  notifyTaskUpsert: vi.fn(),
  notifyTaskSync: vi.fn(),
}))

describe('TaskCreateTool', () => {
  let tool: TaskCreateTool

  beforeEach(() => {
    tool = new TaskCreateTool()
    savedTasks.length = 0
    dependencyCalls.length = 0
  })

  it('should have correct name and description', () => {
    expect(tool.name).toBe('TaskCreate')
    expect(tool.description).toBeTruthy()
    expect(tool.description.length).toBeGreaterThan(10)
  })

  it('should have correct parameter schema', () => {
    const schema = tool.parameters_schema
    expect(schema.type).toBe('object')
    expect(schema.properties.subject).toBeTruthy()
    expect(schema.properties.description).toBeTruthy()
    expect(schema.required).toContain('subject')
    expect(schema.required).toContain('description')
  })

  it('should create a task with required fields', async () => {
    const result = await tool.execute(JSON.stringify({
      subject: 'Test task',
      description: 'A test task',
    }), { workspaceRoot: '/test', sessionId: 's1' })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.subject).toBe('Test task')
    expect(parsed.data.status).toBe('pending')
    expect(parsed.data.taskId).toBeTruthy()
    expect(typeof parsed.data.taskId).toBe('string')
  })

  it('should save task with correct sessionId and owner', async () => {
    await tool.execute(JSON.stringify({
      subject: 'Session test',
      description: 'Check session scoping',
    }), { workspaceRoot: '/test', sessionId: 'my-session' })

    expect(savedTasks).toHaveLength(1)
    expect(savedTasks[0].sessionId).toBe('my-session')
    expect(savedTasks[0].owner).toBe('main-agent')
    expect(savedTasks[0].status).toBe('pending')
    expect(savedTasks[0].createdAt).toBeTruthy()
    expect(savedTasks[0].updatedAt).toBeTruthy()
    expect(savedTasks[0].blocks).toEqual([])
    expect(savedTasks[0].blockedBy).toEqual([])
  })

  it('should reject empty subject', async () => {
    const result = await tool.execute(JSON.stringify({
      subject: '',
      description: '',
    }), { workspaceRoot: '/test', sessionId: 's1' })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBeTruthy()
    expect(parsed.error.code).toBe('MISSING_SUBJECT')
  })

  it('should reject whitespace-only subject', async () => {
    const result = await tool.execute(JSON.stringify({
      subject: '   ',
      description: '',
    }), { workspaceRoot: '/test', sessionId: 's1' })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('MISSING_SUBJECT')
  })

  it('should reject invalid JSON', async () => {
    const result = await tool.execute('not-json', { workspaceRoot: '/test', sessionId: 's1' })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('INVALID_JSON')
  })

  it('should create task with dependencies via blockedBy', async () => {
    // Seed an existing task to act as blocker
    const { notifyTaskUpsert } = await import('../main/ipc/task.handlers')
    const { TaskStore } = await import('../main/services/TaskStore')

    const result = await tool.execute(JSON.stringify({
      subject: 'Blocked task',
      description: 'Depends on another task',
      blockedBy: ['task-1'],
    }), { workspaceRoot: '/test', sessionId: 's1' })

    const parsed = JSON.parse(result)
    expect(parsed.ok).toBe(true)

    // Verify addDependency was called with correct args
    expect(dependencyCalls).toHaveLength(1)
    expect(dependencyCalls[0][0]).toBe(parsed.data.taskId)
    expect(dependencyCalls[0][1]).toBe('task-1')

    // Verify blockedBy is stored in the task
    const saved = savedTasks.find((t) => t.id === parsed.data.taskId)
    expect(saved).toBeTruthy()
    expect(saved.blockedBy).toEqual(['task-1'])
  })

  it('should generate unique task IDs', async () => {
    const result1 = await tool.execute(JSON.stringify({
      subject: 'Task A', description: '',
    }), { workspaceRoot: '/test', sessionId: 's1' })

    const result2 = await tool.execute(JSON.stringify({
      subject: 'Task B', description: '',
    }), { workspaceRoot: '/test', sessionId: 's1' })

    const id1 = JSON.parse(result1).data.taskId
    const id2 = JSON.parse(result2).data.taskId
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
  })
})
