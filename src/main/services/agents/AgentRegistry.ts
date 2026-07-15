import type { AgentRecord, AgentRuntimeStatus } from '../../../shared/types/subagent'

const MAX_AGENT_RECORDS_PER_SESSION = 200

export interface AgentRegistryPersistence {
  saveAgents(sessionId: string, agents: AgentRecord[]): Promise<void>
}

type AgentChangeListener = (sessionId: string, agent: AgentRecord) => void

function copyRecord(record: AgentRecord): AgentRecord {
  return {
    ...record,
    launch: record.launch
      ? {
          ...record.launch,
          expectations: record.launch.expectations
            ? {
                questions: [...record.launch.expectations.questions],
                outOfScope: record.launch.expectations.outOfScope
                  ? [...record.launch.expectations.outOfScope]
                  : undefined
              }
            : undefined,
          scope: record.launch.scope
            ? {
                directories: record.launch.scope.directories
                  ? [...record.launch.scope.directories]
                  : undefined,
                excludeGlobs: record.launch.scope.excludeGlobs
                  ? [...record.launch.scope.excludeGlobs]
                  : undefined
              }
            : undefined,
          permissionScope: record.launch.permissionScope
            ? {
                ...record.launch.permissionScope,
                allowedWriteFiles: record.launch.permissionScope.allowedWriteFiles
                  ? [...record.launch.permissionScope.allowedWriteFiles]
                  : undefined
              }
            : undefined
        }
      : undefined,
    result: record.result
      ? {
          ...record.result,
          filesExamined: [...record.result.filesExamined],
          handoff: record.result.handoff ? { ...record.result.handoff } : undefined
        }
      : undefined
  }
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentRecord>()
  private readonly cancellers = new Map<string, () => void>()
  private readonly listeners = new Set<AgentChangeListener>()
  private persistence?: AgentRegistryPersistence

  configurePersistence(persistence: AgentRegistryPersistence): void {
    this.persistence = persistence
  }

  async restoreSession(sessionId: string, records: AgentRecord[]): Promise<void> {
    this.removeSessionFromMemory(sessionId)
    let changed = false
    for (const source of records) {
      const record = copyRecord(source)
      if (record.status === 'queued' || record.status === 'running') {
        record.status = 'interrupted'
        record.updatedAt = Date.now()
        record.completedAt = record.updatedAt
        record.result = {
          status: 'interrupted',
          report: '## SubAgent interrupted\n\nThe application restarted before this SubAgent completed.',
          conclusion: 'Resume this SubAgent to continue from its durable context.',
          toolCallCount: 0,
          filesExamined: [],
          handoff: {
            reasonCode: 'runtime_missing',
            reason: 'The in-memory SubAgent runtime was not available after application restart.',
            originalTask: record.description,
            filesExamined: [],
            filesModified: [],
            filesPossiblyModified: [],
            recentTools: [],
            workspaceMayHaveUntrackedChanges: false,
            canResume: true
          }
        }
        changed = true
      }
      this.agents.set(record.id, record)
    }
    if (changed) await this.persist(sessionId)
  }

  async create(record: AgentRecord): Promise<AgentRecord> {
    if (this.agents.has(record.id)) throw new Error(`Agent already exists: ${record.id}`)
    const conflict = this.list(record.sessionId).find((agent) => agent.path === record.path)
    if (conflict) throw new Error(`Agent path already exists: ${record.path}`)
    this.agents.set(record.id, copyRecord(record))
    this.prune(record.sessionId)
    await this.persist(record.sessionId)
    this.emit(record.sessionId, record)
    return copyRecord(record)
  }

  async update(
    agentId: string,
    patch: Partial<Omit<AgentRecord, 'id' | 'sessionId' | 'createdAt'>>
  ): Promise<AgentRecord> {
    const current = this.agents.get(agentId)
    if (!current) throw new Error(`Unknown agent: ${agentId}`)
    const updated: AgentRecord = copyRecord({
      ...current,
      ...patch,
      id: current.id,
      sessionId: current.sessionId,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt ?? Date.now()
    })
    this.agents.set(agentId, updated)
    await this.persist(updated.sessionId)
    this.emit(updated.sessionId, updated)
    return copyRecord(updated)
  }

  get(agentId: string): AgentRecord | undefined {
    const record = this.agents.get(agentId)
    return record ? copyRecord(record) : undefined
  }

  resolve(sessionId: string, target: string): AgentRecord | undefined {
    return this.list(sessionId).find((agent) => agent.id === target || agent.path === target)
  }

  list(sessionId?: string): AgentRecord[] {
    return Array.from(this.agents.values())
      .filter((agent) => !sessionId || agent.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(copyRecord)
  }

  listByStatus(sessionId: string, statuses: AgentRuntimeStatus[]): AgentRecord[] {
    const allowed = new Set(statuses)
    return this.list(sessionId).filter((agent) => allowed.has(agent.status))
  }

  attachCanceller(agentId: string, cancel: () => void): void {
    this.cancellers.set(agentId, cancel)
  }

  detachCanceller(agentId: string): void {
    this.cancellers.delete(agentId)
  }

  interrupt(sessionId: string, target: string): boolean {
    const record = this.resolve(sessionId, target)
    if (!record) return false
    const cancel = this.cancellers.get(record.id)
    if (!cancel) return false
    cancel()
    return true
  }

  onChange(listener: AgentChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  removeSession(sessionId: string): void {
    this.removeSessionFromMemory(sessionId)
  }

  private removeSessionFromMemory(sessionId: string): void {
    for (const [id, record] of this.agents) {
      if (record.sessionId !== sessionId) continue
      this.cancellers.get(id)?.()
      this.cancellers.delete(id)
      this.agents.delete(id)
    }
  }

  private prune(sessionId: string): void {
    const records = this.list(sessionId)
    if (records.length <= MAX_AGENT_RECORDS_PER_SESSION) return
    const removable = records.filter((agent) => !['queued', 'running'].includes(agent.status))
    for (const record of removable.slice(0, records.length - MAX_AGENT_RECORDS_PER_SESSION)) {
      this.agents.delete(record.id)
    }
  }

  private async persist(sessionId: string): Promise<void> {
    if (!this.persistence) return
    await this.persistence.saveAgents(sessionId, this.list(sessionId))
  }

  private emit(sessionId: string, record: AgentRecord): void {
    const snapshot = copyRecord(record)
    this.listeners.forEach((listener) => listener(sessionId, snapshot))
  }
}
