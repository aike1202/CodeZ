import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs/promises'
import { TaskStore, TaskData } from '../main/services/TaskStore'

// Mock electron app to return a test directory
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(path.join(__dirname, 'tmp_task_store'))
  }
}))

describe('TaskStore', () => {
  let store: TaskStore
  const sessionId = 'test-session-1'

  beforeEach(async () => {
    store = new TaskStore()
    await store.load()
  })

  afterEach(async () => {
    const dir = path.join(__dirname, 'tmp_task_store')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('should create a task with all new fields', async () => {
    const task: TaskData = {
      id: 'task-1',
      sessionId,
      subject: 'Test task',
      description: 'A test task description',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      owner: 'main-agent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await store.save(task)
    const bySession = store.getBySession(sessionId)
    expect(bySession).toHaveLength(1)
    expect(bySession[0].subject).toBe('Test task')
    expect(bySession[0].description).toBe('A test task description')
    expect(bySession[0].owner).toBe('main-agent')
  })

  it('getById should find a saved task', async () => {
    const task: TaskData = {
      id: 'task-2',
      sessionId,
      subject: 'Find me',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      owner: 'main-agent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await store.save(task)
    const found = store.getById('task-2')
    expect(found).toBeTruthy()
    expect(found!.subject).toBe('Find me')
  })

  it('getById should return undefined for non-existent task', () => {
    const found = store.getById('nonexistent')
    expect(found).toBeUndefined()
  })

  it('updateStatus should change status and update updatedAt', async () => {
    const task: TaskData = {
      id: 'task-3',
      sessionId,
      subject: 'Status test',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
      owner: 'main-agent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await store.save(task)
    const savedBefore = store.getById('task-3')!.updatedAt
    await new Promise(r => setTimeout(r, 5))
    await store.updateStatus('task-3', 'in_progress')
    const updated = store.getById('task-3')
    expect(updated!.status).toBe('in_progress')
    expect(updated!.updatedAt).not.toBe(savedBefore)
  })

  it('addDependency should create bidirectional links', async () => {
    const taskA: TaskData = { id: 'a', sessionId, subject: 'A', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const taskB: TaskData = { id: 'b', sessionId, subject: 'B', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await store.save(taskA)
    await store.save(taskB)
    await store.addDependency('b', 'a')  // B blocked by A
    const a = store.getById('a')
    const b = store.getById('b')
    expect(a!.blocks).toContain('b')
    expect(b!.blockedBy).toContain('a')
  })

  it('removeDependency should clean up both sides', async () => {
    const taskA: TaskData = { id: 'a2', sessionId, subject: 'A', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const taskB: TaskData = { id: 'b2', sessionId, subject: 'B', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await store.save(taskA)
    await store.save(taskB)
    await store.addDependency('b2', 'a2')
    await store.removeDependency('b2', 'a2')
    const a = store.getById('a2')
    const b = store.getById('b2')
    expect(a!.blocks).not.toContain('b2')
    expect(b!.blockedBy).not.toContain('a2')
  })

  it('getBySession should only return tasks for that session', async () => {
    const t1: TaskData = { id: 't1', sessionId: 's1', subject: 'S1', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const t2: TaskData = { id: 't2', sessionId: 's2', subject: 'S2', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'main-agent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await store.save(t1)
    await store.save(t2)
    expect(store.getBySession('s1')).toHaveLength(1)
    expect(store.getBySession('s1')[0].subject).toBe('S1')
    expect(store.getBySession('s2')).toHaveLength(1)
  })
})
