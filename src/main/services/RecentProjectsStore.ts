import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import type { WorkspaceInfo } from '../../shared/types/workspace'

const MAX_RECENT = 10

export class RecentProjectsStore {
  private filePath: string
  private cache: WorkspaceInfo[] = []

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'recent-projects.json')
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed?.projects)) {
        this.cache = parsed.projects
      }
    } catch {
      this.cache = []
    }
  }

  getAll(): WorkspaceInfo[] {
    return [...this.cache]
  }

  async add(project: WorkspaceInfo): Promise<void> {
    this.cache = this.cache.filter((p) => p.rootPath !== project.rootPath)
    this.cache.unshift(project)
    if (this.cache.length > MAX_RECENT) {
      this.cache = this.cache.slice(0, MAX_RECENT)
    }
    await this.save()
  }

  async remove(id: string): Promise<void> {
    this.cache = this.cache.filter((p) => p.id !== id)
    await this.save()
  }

  async rename(id: string, newName: string): Promise<void> {
    const proj = this.cache.find((p) => p.id === id)
    if (proj) {
      proj.name = newName
      await this.save()
    }
  }

  private async save(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify({ projects: this.cache }, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save recent projects:', error)
    }
  }
}
