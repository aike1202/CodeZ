import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'

export interface TaskData {
  id: string
  projectId: string
  title: string
  plan: string
  status: 'pending' | 'running' | 'completed' | 'failed'
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
    return this.cache.filter((t) => t.projectId === projectId)
  }

  async save(task: TaskData): Promise<void> {
    const idx = this.cache.findIndex((t) => t.id === task.id)
    if (idx >= 0) {
      this.cache[idx] = task
    } else {
      this.cache.push(task)
    }
    await this.persist()
  }

  async delete(taskId: string): Promise<void> {
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
