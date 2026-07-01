import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'

export interface TaskData {
  id: string
  sessionId: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  blocks: string[]
  blockedBy: string[]
  owner: string
  createdAt: string
  updatedAt: string
}

const TASKS_FILE = 'tasks.json'

export class TaskStore {
  private filePath: string
  private cache: TaskData[] = []

  constructor() {
    this.filePath = path.join(app.getPath('userData'), TASKS_FILE)
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed?.tasks)) {
        this.cache = parsed.tasks
      }
    } catch {
      this.cache = []
    }
  }

  getAllByProject(projectId: string): TaskData[] {
    return this.cache.filter((t) => (t as any).projectId === projectId)
  }

  getBySession(sessionId: string): TaskData[] {
    return this.cache.filter((t) => t.sessionId === sessionId)
  }

  getById(taskId: string): TaskData | undefined {
    return this.cache.find((t) => t.id === taskId)
  }

  async save(task: TaskData): Promise<void> {
    const idx = this.cache.findIndex((t) => t.id === task.id)
    if (idx >= 0) {
      this.cache[idx] = { ...task, updatedAt: new Date().toISOString() }
    } else {
      this.cache.push({ ...task })
    }
    await this.persist()
  }

  async updateStatus(taskId: string, status: TaskData['status']): Promise<void> {
    const idx = this.cache.findIndex((t) => t.id === taskId)
    if (idx < 0) throw new Error(`Task ${taskId} not found`)
    this.cache[idx] = {
      ...this.cache[idx],
      status,
      updatedAt: new Date().toISOString()
    }
    await this.persist()
  }

  async addDependency(taskId: string, blockedByTaskId: string): Promise<void> {
    const task = this.cache.find((t) => t.id === taskId)
    const blocker = this.cache.find((t) => t.id === blockedByTaskId)
    if (!task || !blocker) throw new Error('Task not found')

    if (!task.blockedBy.includes(blockedByTaskId)) {
      task.blockedBy.push(blockedByTaskId)
      task.updatedAt = new Date().toISOString()
    }
    if (!blocker.blocks.includes(taskId)) {
      blocker.blocks.push(taskId)
      blocker.updatedAt = new Date().toISOString()
    }
    await this.persist()
  }

  async removeDependency(taskId: string, blockedByTaskId: string): Promise<void> {
    const task = this.cache.find((t) => t.id === taskId)
    const blocker = this.cache.find((t) => t.id === blockedByTaskId)
    if (!task || !blocker) throw new Error('Task not found')

    task.blockedBy = task.blockedBy.filter((id) => id !== blockedByTaskId)
    task.updatedAt = new Date().toISOString()
    blocker.blocks = blocker.blocks.filter((id) => id !== taskId)
    blocker.updatedAt = new Date().toISOString()
    await this.persist()
  }

  async delete(taskId: string): Promise<void> {
    // Clean up dependencies before deleting
    const task = this.cache.find((t) => t.id === taskId)
    if (task) {
      for (const blockerId of task.blockedBy) {
        await this.removeDependency(taskId, blockerId).catch(() => {})
      }
      for (const blockedId of [...task.blocks]) {
        await this.removeDependency(blockedId, taskId).catch(() => {})
      }
    }
    this.cache = this.cache.filter((t) => t.id !== taskId)
    await this.persist()
  }

  private async persist(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        this.filePath,
        JSON.stringify({ tasks: this.cache }, null, 2),
        'utf-8'
      )
    } catch (error) {
      console.error('TaskStore persist error:', error)
    }
  }
}
