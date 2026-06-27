import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'

import { SessionData } from '../../shared/types'

const SESSIONS_FILE = 'sessions.json'
const MAX_SESSIONS = 50

export class SessionStore {
  private filePath: string
  private cache: SessionData[] = []

  constructor() {
    this.filePath = path.join(app.getPath('userData'), SESSIONS_FILE)
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed?.sessions)) {
        const THREE_DAYS = 3 * 24 * 60 * 60 * 1000
        const now = Date.now()
        let isDirty = false
        this.cache = parsed.sessions.filter((s: any) => {
          if (s.isDeleted && s.deletedAt) {
            if (now - s.deletedAt > THREE_DAYS) {
              isDirty = true
              return false // 物理删除超过3天的会话
            }
          }
          return true
        })
        if (isDirty) {
          await this.persist()
        }
      }
    } catch {
      this.cache = []
    }
  }

  getAll(): SessionData[] {
    return [...this.cache]
  }

  async save(session: SessionData): Promise<void> {
    const idx = this.cache.findIndex((s) => s.id === session.id)
    if (idx >= 0) {
      this.cache[idx] = session
    } else {
      this.cache.unshift(session)
      if (this.cache.length > MAX_SESSIONS) {
        this.cache = this.cache.slice(0, MAX_SESSIONS)
      }
    }
    await this.persist()
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.cache.find((s) => s.id === sessionId)
    if (session && !session.isDeleted) {
      session.isDeleted = true
      session.deletedAt = Date.now()
    } else {
      this.cache = this.cache.filter((s) => s.id !== sessionId)
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        this.filePath,
        JSON.stringify({ sessions: this.cache }, null, 2),
        'utf-8'
      )
    } catch (error) {
      console.error('SessionStore persist error:', error)
    }
  }
}
