import type { SessionRuntimeStatus } from '../../shared/types/subagent'

interface ActiveRunner<T> {
  sessionId: string
  runner: T
}

type RuntimeChangeListener = (sessionId: string) => void

export class ChatRuntimeRegistry<T extends { abort(): void }> {
  private readonly entries = new Map<string, ActiveRunner<T>>()
  private readonly versions = new Map<string, number>()
  private readonly listeners = new Set<RuntimeChangeListener>()

  register(streamId: string, sessionId: string, runner: T): void {
    this.entries.set(streamId, { sessionId, runner })
    this.touch(sessionId)
  }

  getRunner(streamId: string): T | undefined {
    return this.entries.get(streamId)?.runner
  }

  unregister(streamId: string): void {
    const entry = this.entries.get(streamId)
    if (!entry || !this.entries.delete(streamId)) return
    this.touch(entry.sessionId)
  }

  onChange(listener: RuntimeChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  touch(sessionId: string): void {
    this.versions.set(sessionId, this.getVersion(sessionId) + 1)
    this.listeners.forEach((listener) => listener(sessionId))
  }

  getVersion(sessionId: string): number {
    return this.versions.get(sessionId) ?? 0
  }

  getStatus(sessionId: string, activeSubAgentIds: string[]): SessionRuntimeStatus {
    return {
      sessionId,
      mainRunnerActive: Array.from(this.entries.values()).some(
        (entry) => entry.sessionId === sessionId
      ),
      activeSubAgentIds
    }
  }
}
