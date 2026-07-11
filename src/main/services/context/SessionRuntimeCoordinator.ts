import { createHash, randomUUID } from 'crypto'
import type {
  ContextScopeId,
  NormalizedModelMessage,
  NormalizedToolCall,
  VersionedResumeState
} from '../../../shared/types'
import type { AgentStopReason, ProviderTokenUsage } from '../../../shared/types/provider'
import type { ImageAttachment } from '../../../shared/types/attachment'
import { ModelLedgerStore } from './ModelLedgerStore'
import { ModelHistoryNormalizer } from './ModelHistoryNormalizer'

export interface BeginTurnInput {
  sessionId: string
  contextScopeId: ContextScopeId
  text: string
  providerId?: string
  model?: string
  commandMetadata?: unknown
  attachments?: ImageAttachment[]
}

export interface RuntimeTurnHandle {
  sessionId: string
  contextScopeId: ContextScopeId
  turnId: string
  userMessageId: string
  inputText: string
  attachments?: ImageAttachment[]
}

interface ActiveTurn extends RuntimeTurnHandle {
  pendingCalls: Map<string, NormalizedToolCall>
  closed: boolean
}

export interface AssistantRecord {
  content: string
  toolCalls?: NormalizedToolCall[]
  usage?: ProviderTokenUsage
}

export interface ToolResultRecord {
  callId: string
  name: string
  content: string
  status: 'success' | 'error' | 'interrupted'
}

export interface SessionRecoveryResult {
  sessionId: string
  recoveredScopes: Array<{
    contextScopeId: ContextScopeId
    turnId: string
    interruptedToolCalls: number
  }>
  warnings: string[]
}

export class SessionRuntimeCoordinator {
  private readonly activeTurns = new Map<string, ActiveTurn>()

  constructor(readonly ledger: ModelLedgerStore) {}

  async beginTurn(input: BeginTurnInput): Promise<RuntimeTurnHandle> {
    if (!input.text.trim() && !input.attachments?.length) throw new Error('Turn input is empty')
    const key = this.scopeKey(input.sessionId, input.contextScopeId)
    if (this.activeTurns.has(key)) throw new Error(`${key} already has an active turn`)

    const turnId = randomUUID()
    const message: NormalizedModelMessage = {
      id: randomUUID(),
      turnId,
      role: 'user',
      content: input.text,
      status: 'complete',
      createdAt: new Date().toISOString(),
      attachments: input.attachments?.map((attachment) => ({ ...attachment }))
    }
    await this.ledger.append(input.sessionId, input.contextScopeId, 'user_message', {
      message,
      providerId: input.providerId,
      model: input.model,
      commandMetadata: input.commandMetadata
    }, turnId)

    const active: ActiveTurn = {
      sessionId: input.sessionId,
      contextScopeId: input.contextScopeId,
      turnId,
      userMessageId: message.id,
      inputText: input.text,
      attachments: input.attachments?.map((attachment) => ({ ...attachment })),
      pendingCalls: new Map(),
      closed: false
    }
    this.activeTurns.set(key, active)
    return this.publicHandle(active)
  }

  async recordAssistant(handle: RuntimeTurnHandle, record: AssistantRecord): Promise<NormalizedModelMessage> {
    const turn = this.requireActive(handle)
    const message: NormalizedModelMessage = {
      id: randomUUID(),
      turnId: turn.turnId,
      role: 'assistant',
      content: record.content,
      toolCalls: record.toolCalls?.map((call) => ({ ...call })),
      status: 'complete',
      createdAt: new Date().toISOString()
    }
    await this.ledger.append(turn.sessionId, turn.contextScopeId, 'assistant_message', {
      message,
      usage: record.usage
    }, turn.turnId)
    for (const call of record.toolCalls || []) turn.pendingCalls.set(call.id, { ...call })
    return message
  }

  async recordToolResult(handle: RuntimeTurnHandle, record: ToolResultRecord): Promise<NormalizedModelMessage> {
    const turn = this.requireActive(handle)
    if (!turn.pendingCalls.has(record.callId)) throw new Error(`Unknown or completed tool call: ${record.callId}`)
    const message: NormalizedModelMessage = {
      id: randomUUID(),
      turnId: turn.turnId,
      role: 'tool',
      content: record.content,
      toolCallId: record.callId,
      name: record.name,
      status: record.status === 'interrupted' ? 'interrupted' : 'complete',
      createdAt: new Date().toISOString()
    }
    await this.ledger.append(turn.sessionId, turn.contextScopeId, 'tool_result', {
      message,
      status: record.status,
      fullResultSha256: createHash('sha256').update(record.content).digest('hex')
    }, turn.turnId)
    turn.pendingCalls.delete(record.callId)
    return message
  }

  async recordResumeState(handle: RuntimeTurnHandle, resumeState: VersionedResumeState): Promise<void> {
    const turn = this.requireActive(handle)
    await this.ledger.append(turn.sessionId, turn.contextScopeId, 'resume_state_updated', { resumeState }, turn.turnId)
  }

  async recordUserContinuation(handle: RuntimeTurnHandle, text: string): Promise<NormalizedModelMessage> {
    const turn = this.requireActive(handle)
    if (turn.pendingCalls.size > 0) throw new Error('Cannot add user continuation with pending tool calls')
    const message: NormalizedModelMessage = {
      id: randomUUID(),
      turnId: turn.turnId,
      role: 'user',
      content: text,
      status: 'complete',
      createdAt: new Date().toISOString()
    }
    await this.ledger.append(turn.sessionId, turn.contextScopeId, 'user_message', { message }, turn.turnId)
    return message
  }

  async completeTurn(
    handle: RuntimeTurnHandle,
    result: { stopReason: AgentStopReason; usage?: ProviderTokenUsage }
  ): Promise<void> {
    const turn = this.requireActive(handle)
    if (turn.pendingCalls.size > 0) throw new Error('Cannot complete a turn with pending tool calls')
    await this.ledger.append(turn.sessionId, turn.contextScopeId, 'turn_completed', {
      stopReason: result.stopReason,
      usage: result.usage,
      completedAt: new Date().toISOString()
    }, turn.turnId)
    this.close(turn)
  }

  async interruptTurn(handle: RuntimeTurnHandle, reason: string): Promise<void> {
    const turn = this.requireActive(handle)
    const createdAt = new Date().toISOString()
    const interruptedMessages: NormalizedModelMessage[] = [...turn.pendingCalls.values()].map((call) => ({
      id: `interrupted:${call.id}`,
      turnId: turn.turnId,
      role: 'tool',
      content: JSON.stringify({
        ok: false,
        error: { code: 'EXECUTION_INTERRUPTED', message: reason }
      }),
      toolCallId: call.id,
      name: call.name,
      status: 'interrupted',
      createdAt
    }))
    await this.ledger.append(turn.sessionId, turn.contextScopeId, 'turn_interrupted', {
      reason,
      interruptedMessages
    }, turn.turnId)
    this.close(turn)
  }

  isScopeBusy(sessionId: string, contextScopeId: ContextScopeId): boolean {
    return this.activeTurns.has(this.scopeKey(sessionId, contextScopeId))
  }

  async getScopeView(sessionId: string, contextScopeId: ContextScopeId) {
    const state = await this.ledger.load(sessionId)
    return state.scopes[contextScopeId]
  }

  async getThroughSequence(sessionId: string): Promise<number> {
    return (await this.ledger.load(sessionId)).throughSequence
  }

  async recoverSession(sessionId: string): Promise<SessionRecoveryResult> {
    const state = await this.ledger.load(sessionId)
    const result: SessionRecoveryResult = {
      sessionId,
      recoveredScopes: [],
      warnings: [...state.warnings]
    }

    for (const [scopeId, scope] of Object.entries(state.scopes)) {
      const latest = scope.activeMessages.at(-1)
      if (!latest) continue
      if (scope.lastCompletedTurnId === latest.turnId || scope.lastInterruptedTurnId === latest.turnId) continue

      const existingIds = new Set(scope.activeMessages.map((message) => message.id))
      const interruptedMessages = ModelHistoryNormalizer
        .normalizeRecoveredHistory(scope.activeMessages)
        .filter((message) => !existingIds.has(message.id) && message.turnId === latest.turnId)

      await this.ledger.append(sessionId, scopeId as ContextScopeId, 'turn_interrupted', {
        reason: 'The application stopped before this turn reached a durable terminal event.',
        interruptedMessages
      }, latest.turnId)
      result.recoveredScopes.push({
        contextScopeId: scopeId as ContextScopeId,
        turnId: latest.turnId,
        interruptedToolCalls: interruptedMessages.length
      })
    }

    return result
  }

  private requireActive(handle: RuntimeTurnHandle): ActiveTurn {
    const active = this.activeTurns.get(this.scopeKey(handle.sessionId, handle.contextScopeId))
    if (!active || active.closed || active.turnId !== handle.turnId) throw new Error('Turn is not active')
    return active
  }

  private close(turn: ActiveTurn): void {
    turn.closed = true
    this.activeTurns.delete(this.scopeKey(turn.sessionId, turn.contextScopeId))
  }

  private scopeKey(sessionId: string, contextScopeId: ContextScopeId): string {
    return `${sessionId}:${contextScopeId}`
  }

  private publicHandle(turn: ActiveTurn): RuntimeTurnHandle {
    const { sessionId, contextScopeId, turnId, userMessageId, inputText } = turn
    return {
      sessionId,
      contextScopeId,
      turnId,
      userMessageId,
      inputText,
      attachments: turn.attachments?.map((attachment) => ({ ...attachment }))
    }
  }
}
