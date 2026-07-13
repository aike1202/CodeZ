import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { app } from 'electron'

import { SessionData } from '../../shared/types'
import type { SessionRuntimeRef } from '../../shared/types/context'
import { atomicWriteJson } from './context/atomicFile'

const SESSIONS_FILE = 'sessions.json'
const MAX_SESSIONS = 50

export class SessionStore {
  private filePath: string
  private cache: SessionData[] = []
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath?: string) {
    const userDataPath = app?.getPath
      ? app.getPath('userData')
      : path.join(os.tmpdir(), `codez-session-store-${process.pid}`)
    this.filePath = filePath ?? path.join(userDataPath, SESSIONS_FILE)
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

  get(sessionId: string): SessionData | undefined {
    return this.cache.find((s) => s.id === sessionId)
  }

  getAll(): SessionData[] {
    return [...this.cache]
  }

  async save(session: SessionData): Promise<void> {
    return this.enqueueMutation(async () => {
      const idx = this.cache.findIndex((s) => s.id === session.id)
      if (idx >= 0) {
        const current = this.cache[idx]
        this.cache[idx] = {
          ...session,
          runtime: current.runtime,
          toolRuntime: current.toolRuntime
        }
      } else {
        this.cache.unshift(session)
        if (this.cache.length > MAX_SESSIONS) {
          const removed = this.cache.slice(MAX_SESSIONS)
          this.cache = this.cache.slice(0, MAX_SESSIONS)
          console.warn(`[SessionStore] 会话数超过 ${MAX_SESSIONS}，已移除最旧会话:`, removed.map(s => s.id))
        }
      }
    })
  }

  async delete(sessionId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const session = this.cache.find((s) => s.id === sessionId)
      if (session && !session.isDeleted) {
        this.cache = this.cache.map((item) => item.id === sessionId
          ? { ...item, isDeleted: true, deletedAt: Date.now() }
          : item)
      } else {
        this.cache = this.cache.filter((s) => s.id !== sessionId)
      }
    })
  }

  async setRuntimeRef(sessionId: string, runtime: SessionRuntimeRef): Promise<void> {
    return this.enqueueMutation(async () => {
      const idx = this.cache.findIndex((session) => session.id === sessionId)
      if (idx < 0) throw new Error(`Session not found: ${sessionId}`)
      this.cache[idx] = { ...this.cache[idx], runtime: { ...runtime } }
    })
  }

  async addActivatedDeferredTools(
    sessionId: string,
    contextScopeId: string,
    toolNames: readonly string[]
  ): Promise<void> {
    if (toolNames.length === 0) return
    return this.enqueueMutation(async () => {
      const idx = this.cache.findIndex((session) => session.id === sessionId)
      if (idx < 0) throw new Error(`Session not found: ${sessionId}`)
      const session = this.cache[idx]
      const existing = session.toolRuntime?.activatedDeferredTools?.[contextScopeId] || []
      this.cache[idx] = {
        ...session,
        toolRuntime: {
          ...session.toolRuntime,
          activatedDeferredTools: {
            ...session.toolRuntime?.activatedDeferredTools,
            [contextScopeId]: [...new Set([...existing, ...toolNames])]
          }
        }
      }
    })
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.filePath, { sessions: this.cache })
  }

  private enqueueMutation(mutate: () => Promise<void>): Promise<void> {
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const previous = this.cache
      this.cache = [...this.cache]
      try {
        await mutate()
        await this.persist()
      } catch (error) {
        this.cache = previous
        throw error
      }
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
