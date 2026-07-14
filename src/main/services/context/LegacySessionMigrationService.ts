import { createHash, randomUUID } from 'crypto'
import type { SessionStore } from '../SessionStore'
import type { SessionData } from '../../../shared/types/session'
import type {
  CompactionSummary,
  NormalizedModelMessage
} from '../../../shared/types/context'
import { MAIN_CONTEXT_SCOPE } from '../../../shared/types/context'
import { ContextBudgetService } from './ContextBudgetService'
import { ModelLedgerStore } from './ModelLedgerStore'
import { serializeLegacyTranscript } from './LegacyTranscript'

export interface LegacySummaryClient {
  summarize(input: {
    sessionId: string
    transcript: string
    coveredItemCount: number
  }): Promise<CompactionSummary>
}

export interface LegacyMigrationResult {
  sourceHash: string
  mode: 'summary' | 'recent-text-fallback'
  eventId: string
}

export interface LegacyMigrationOptions {
  excludeMessageId?: string
}

function stableSourceHash(session: SessionData): string {
  return createHash('sha256').update(JSON.stringify({
    id: session.id,
    projectId: session.projectId,
    messages: session.messages
  })).digest('hex')
}

export class LegacySessionMigrationService {
  constructor(
    private readonly sessions: SessionStore,
    private readonly ledger: ModelLedgerStore,
    private readonly summaryClient: LegacySummaryClient,
    private readonly budget = new ContextBudgetService()
  ) {}

  async ensureMigrated(sessionId: string, options: LegacyMigrationOptions = {}): Promise<LegacyMigrationResult> {
    const storedSession = this.sessions.get(sessionId)
    if (!storedSession) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'LEGACY_MIGRATION_FAILED' })
    if (storedSession.runtime) {
      const state = await this.ledger.load(sessionId)
      const imported = state.scopes[MAIN_CONTEXT_SCOPE]?.legacyImport
      return {
        sourceHash: storedSession.runtime.legacySourceHash || imported?.sourceHash || '',
        mode: storedSession.runtime.legacyImportMode || imported?.mode || 'recent-text-fallback',
        eventId: imported?.eventId || 'runtime-present'
      }
    }

    const session: SessionData = {
      ...storedSession,
      messages: options.excludeMessageId
        ? storedSession.messages.filter((message) => message.id !== options.excludeMessageId)
        : storedSession.messages
    }

    const sourceHash = stableSourceHash(session)
    const existing = (await this.ledger.load(sessionId)).scopes[MAIN_CONTEXT_SCOPE]?.legacyImport
    if (existing) {
      await this.sessions.setRuntimeRef(sessionId, {
        schemaVersion: 2,
        ledgerVersion: 1,
        migratedAt: new Date().toISOString(),
        legacySourceHash: existing.sourceHash,
        legacyImportMode: existing.mode
      })
      return { sourceHash: existing.sourceHash, mode: existing.mode, eventId: existing.eventId }
    }

    const transcript = serializeLegacyTranscript(session.messages)
    let summary: CompactionSummary | undefined
    let mode: LegacyMigrationResult['mode'] = 'summary'
    try {
      if (session.messages.length > 0) {
        summary = await this.summaryClient.summarize({
          sessionId,
          transcript,
          coveredItemCount: session.messages.length
        })
      } else {
        mode = 'recent-text-fallback'
      }
    } catch {
      mode = 'recent-text-fallback'
    }

    const activeMessages = this.recentTextMessages(session.messages, 6000)
    const event = await this.ledger.append(sessionId, MAIN_CONTEXT_SCOPE, 'legacy_import_completed', {
      sourceHash,
      mode,
      activeMessages,
      summary
    })
    await this.ledger.writeSnapshot(sessionId)
    await this.sessions.setRuntimeRef(sessionId, {
      schemaVersion: 2,
      ledgerVersion: 1,
      migratedAt: new Date().toISOString(),
      legacySourceHash: sourceHash,
      legacyImportMode: mode
    })
    return { sourceHash, mode, eventId: event.eventId }
  }

  private recentTextMessages(
    messages: SessionData['messages'],
    tokenBudget: number
  ): NormalizedModelMessage[] {
    const selected: SessionData['messages'] = []
    let tokens = 0
    for (let index = messages.length - 1; index >= 0; index--) {
      const messageTokens = this.budget.estimateStringTokens(messages[index].content)
      if (selected.length > 0 && tokens + messageTokens > tokenBudget) break
      selected.unshift(messages[index])
      tokens += messageTokens
    }
    const createdAt = new Date().toISOString()
    return selected.map((message) => ({
      id: `legacy:${message.id || randomUUID()}`,
      clientMessageId: message.role === 'user' ? message.id : undefined,
      turnId: `legacy:${message.id || randomUUID()}`,
      role: message.role === 'agent' || message.role === 'assistant' ? 'assistant' : 'user',
      content: message.role === 'system' ? `[System note] ${message.content}` : message.content,
      status: 'complete',
      createdAt
    }))
  }
}
