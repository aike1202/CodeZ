import type { SessionRuntimeStatus } from '../../shared/types/subagent'

interface ActiveRunner<T> {
  sessionId: string
  runner: T
}

export class ChatRuntimeRegistry<T extends { abort(): void }> {
  private readonly entries = new Map<string, ActiveRunner<T>>()

  register(streamId: string, sessionId: string, runner: T): void {
    this.entries.set(streamId, { sessionId, runner })
  }

  getRunner(streamId: string): T | undefined {
    return this.entries.get(streamId)?.runner
  }

  unregister(streamId: string): void {
    this.entries.delete(streamId)
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
