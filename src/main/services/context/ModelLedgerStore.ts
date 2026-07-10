import * as fs from 'fs/promises'
import * as path from 'path'
import {
  CONTEXT_SCHEMA_VERSION,
  eventChangesHistory,
  type AnyLedgerEvent,
  type ContextScopeId,
  type LedgerEvent,
  type LedgerEventType,
  type LedgerPayloadByType,
  type SessionRuntimeScopeSnapshot,
  type SessionRuntimeSnapshot
} from '../../../shared/types/context'
import { atomicWriteFile, atomicWriteJson } from './atomicFile'

export interface LoadedSessionRuntime extends SessionRuntimeSnapshot {
  warnings: string[]
}

function cloneScope(scope: SessionRuntimeScopeSnapshot): SessionRuntimeScopeSnapshot {
  return JSON.parse(JSON.stringify(scope)) as SessionRuntimeScopeSnapshot
}

function emptyScope(): SessionRuntimeScopeSnapshot {
  return { historyVersion: 0, activeMessages: [] }
}

function applyEvent(state: LoadedSessionRuntime, event: AnyLedgerEvent): void {
  const scope = state.scopes[event.contextScopeId] || emptyScope()
  state.scopes[event.contextScopeId] = scope
  scope.historyVersion = event.historyVersion

  switch (event.type) {
    case 'user_message':
      scope.lastProviderId = event.payload.providerId || scope.lastProviderId
      scope.lastModel = event.payload.model || scope.lastModel
      scope.activeMessages.push({ ...event.payload.message, sourceSequence: event.sequence })
      break
    case 'assistant_message':
    case 'tool_result':
      scope.activeMessages.push({ ...event.payload.message, sourceSequence: event.sequence })
      break
    case 'turn_completed':
      scope.lastCompletedTurnId = event.turnId
      break
    case 'turn_interrupted':
      scope.activeMessages.push(...event.payload.interruptedMessages.map((message) => ({
        ...message,
        sourceSequence: event.sequence
      })))
      scope.lastInterruptedTurnId = event.turnId
      break
    case 'resume_state_updated':
      scope.resumeState = event.payload.resumeState
      break
    case 'compaction_completed':
      scope.activeMessages = event.payload.activeMessages.map((message) => ({ ...message }))
      scope.latestCompaction = event.payload.summary
      scope.resumeState = event.payload.resumeState || scope.resumeState
      scope.latestCompactionResumeRevision = event.payload.resumeState?.revision
      break
    case 'legacy_import_completed':
      scope.activeMessages = event.payload.activeMessages.map((message) => ({
        ...message,
        sourceSequence: message.sourceSequence ?? event.sequence
      }))
      scope.latestCompaction = event.payload.summary
      scope.legacyImport = {
        sourceHash: event.payload.sourceHash,
        mode: event.payload.mode,
        eventId: event.eventId
      }
      break
  }

  state.throughSequence = event.sequence
}

async function appendDurable(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const handle = await fs.open(filePath, 'a')
  try {
    await handle.writeFile(line, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class ModelLedgerStore {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly cache = new Map<string, LoadedSessionRuntime>()

  constructor(public readonly runtimeRoot: string) {}

  sessionDirectory(sessionId: string): string {
    return path.join(this.runtimeRoot, sessionId)
  }

  ledgerPath(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), 'ledger.jsonl')
  }

  snapshotPath(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), 'snapshot.json')
  }

  async load(sessionId: string): Promise<LoadedSessionRuntime> {
    return this.enqueue(sessionId, () => this.loadUnlocked(sessionId, true))
  }

  async append<TType extends LedgerEventType>(
    sessionId: string,
    contextScopeId: ContextScopeId,
    type: TType,
    payload: LedgerPayloadByType[TType],
    turnId?: string
  ): Promise<LedgerEvent<TType>> {
    return this.enqueue(sessionId, async () => {
      const state = await this.loadUnlocked(sessionId)
      const scope = state.scopes[contextScopeId] || emptyScope()
      state.scopes[contextScopeId] = scope
      const event: LedgerEvent<TType> = {
        schemaVersion: CONTEXT_SCHEMA_VERSION,
        eventId: `${sessionId}:${state.throughSequence + 1}:${Math.random().toString(36).slice(2, 10)}`,
        sessionId,
        contextScopeId,
        sequence: state.throughSequence + 1,
        historyVersion: scope.historyVersion + (eventChangesHistory(type) ? 1 : 0),
        turnId,
        createdAt: new Date().toISOString(),
        type,
        payload
      }

      await appendDurable(this.ledgerPath(sessionId), `${JSON.stringify(event)}\n`)
      applyEvent(state, event as AnyLedgerEvent)
      return event
    })
  }

  async writeSnapshot(sessionId: string): Promise<SessionRuntimeSnapshot> {
    return this.enqueue(sessionId, async () => {
      const state = await this.loadUnlocked(sessionId)
      const snapshot: SessionRuntimeSnapshot = {
        schemaVersion: CONTEXT_SCHEMA_VERSION,
        sessionId,
        throughSequence: state.throughSequence,
        createdAt: new Date().toISOString(),
        scopes: Object.fromEntries(
          Object.entries(state.scopes).map(([scopeId, scope]) => [scopeId, cloneScope(scope)])
        )
      }
      await atomicWriteJson(this.snapshotPath(sessionId), snapshot)
      return snapshot
    })
  }

  async compactPhysicalLog(sessionId: string): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const snapshot = await this.readSnapshot(sessionId)
      if (!snapshot) return
      const retained = (await this.readEvents(sessionId, []))
        .filter((event) => event.sequence > snapshot.throughSequence)
      const content = retained.map((event) => JSON.stringify(event)).join('\n')
      await atomicWriteFile(this.ledgerPath(sessionId), content ? `${content}\n` : '')
    })
  }

  private async loadUnlocked(sessionId: string, force = false): Promise<LoadedSessionRuntime> {
    if (!force) {
      const cached = this.cache.get(sessionId)
      if (cached) return cached
    }

    const warnings: string[] = []
    const snapshot = await this.readSnapshot(sessionId)
    const state: LoadedSessionRuntime = snapshot
      ? {
          ...snapshot,
          scopes: Object.fromEntries(
            Object.entries(snapshot.scopes).map(([key, value]) => [key, cloneScope(value)])
          ),
          warnings
        }
      : {
          schemaVersion: CONTEXT_SCHEMA_VERSION,
          sessionId,
          throughSequence: 0,
          createdAt: new Date().toISOString(),
          scopes: {},
          warnings
        }

    const events = await this.readEvents(sessionId, warnings)
    for (const event of events) {
      if (event.sessionId !== sessionId) throw new Error('LEDGER_CORRUPTED: session id mismatch')
      if (event.sequence <= state.throughSequence) continue
      if (event.sequence !== state.throughSequence + 1) throw new Error('LEDGER_CORRUPTED: non-contiguous sequence')
      const scope = state.scopes[event.contextScopeId] || emptyScope()
      const expectedVersion = scope.historyVersion + (eventChangesHistory(event.type) ? 1 : 0)
      if (event.historyVersion !== expectedVersion) throw new Error('LEDGER_CORRUPTED: invalid history version')
      applyEvent(state, event)
    }

    this.cache.set(sessionId, state)
    return state
  }

  private async readSnapshot(sessionId: string): Promise<SessionRuntimeSnapshot | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.snapshotPath(sessionId), 'utf8')) as SessionRuntimeSnapshot
      if (parsed.schemaVersion !== CONTEXT_SCHEMA_VERSION || parsed.sessionId !== sessionId) {
        throw new Error('SNAPSHOT_COMMIT_FAILED: invalid snapshot identity')
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async readEvents(sessionId: string, warnings: string[]): Promise<AnyLedgerEvent[]> {
    let content: string
    try {
      content = await fs.readFile(this.ledgerPath(sessionId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const lines = content.split('\n')
    const events: AnyLedgerEvent[] = []
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue
      try {
        events.push(JSON.parse(lines[index]) as AnyLedgerEvent)
      } catch {
        const finalRecord = lines.slice(index + 1).every((line) => !line.trim())
        if (finalRecord) {
          warnings.push('TRUNCATED_FINAL_RECORD')
          const repaired = events.map((event) => JSON.stringify(event)).join('\n')
          await atomicWriteFile(this.ledgerPath(sessionId), repaired ? `${repaired}\n` : '')
          break
        }
        throw new Error(`LEDGER_CORRUPTED: invalid JSON at line ${index + 1}`)
      }
    }
    return events
  }

  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) || Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    this.queues.set(sessionId, result.then(() => undefined, () => undefined))
    return result
  }
}
