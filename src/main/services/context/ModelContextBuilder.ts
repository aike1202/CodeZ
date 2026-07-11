import type {
  ContextBudgetSnapshot,
  ContextScopeId,
  ModelContextItem,
  NormalizedModelMessage
} from '../../../shared/types/context'
import type {
  ChatMessage,
  ModelContextCapabilities,
  ProviderTokenUsage
} from '../../../shared/types/provider'
import { ProviderMessageAdapter } from '../chat/ProviderMessageAdapter'
import { CompactionService } from './CompactionService'
import { renderCompactionSummary } from './CompactionSummary'
import { ContextBudgetService } from './ContextBudgetService'
import { ModelHistoryNormalizer } from './ModelHistoryNormalizer'
import { ModelLedgerStore } from './ModelLedgerStore'
import { ResumeStateManager } from './ResumeStateManager'
import { ToolOutputPruner } from './ToolOutputPruner'

export interface BuildModelContextRequest {
  sessionId: string
  contextScopeId: ContextScopeId
  currentInputMessageId: string
  currentInput: string
  capabilities: ModelContextCapabilities
  systemPrompt: string
  toolSchemas: unknown[]
  instructions?: string[]
  providerUsage?: ProviderTokenUsage
  reasoningBudgetTokens?: number
  projectedAdditionalTokens?: number
  allowCompaction?: boolean
}

export interface BuiltModelContext {
  items: ModelContextItem[]
  messages: ChatMessage[]
  budget: ContextBudgetSnapshot
  historyVersion: number
}

export class ModelContextBuilder {
  constructor(
    private readonly ledger: ModelLedgerStore,
    private readonly budgetService = new ContextBudgetService(),
    private readonly pruner = new ToolOutputPruner(budgetService),
    private readonly resumeStates = new ResumeStateManager(),
    private readonly compaction?: CompactionService
  ) {}

  async build(request: BuildModelContextRequest): Promise<BuiltModelContext> {
    const state = await this.ledger.load(request.sessionId)
    const scope = state.scopes[request.contextScopeId]
    if (!scope) throw new Error(`Context scope not found: ${request.contextScopeId}`)

    const current = scope.activeMessages.find((message) => message.id === request.currentInputMessageId)
    if (!current || current.role !== 'user') throw new Error('Current input is not durably recorded')
    this.budgetService.assertCurrentInputFits(
      request.currentInput,
      request.capabilities,
      current.attachments
    )
    let activeMessages = scope.activeMessages
    let recentHistory = activeMessages.filter((message) => message.id !== current.id)
    const rawHistoryTokens = recentHistory.reduce(
      (total, message) => total + this.budgetService.estimateValueTokens(message),
      0
    )
    const summary = scope.latestCompaction ? renderCompactionSummary(scope.latestCompaction) : ''
    const resume = scope.resumeState && scope.resumeState.revision !== scope.latestCompactionResumeRevision
      ? this.resumeStates.renderBounded(scope.resumeState)
      : ''

    let budget = this.measure(
      request, recentHistory, summary, resume, scope.historyVersion, rawHistoryTokens, current.attachments
    )
    const maxSingleToolTokens = Math.min(
      8_000,
      Math.floor(budget.usableInputBudget * 0.1)
    )
    const emergencyPrune = this.pruner.prune(activeMessages, {
      targetTokens: Number.POSITIVE_INFINITY,
      protectedTailStart: activeMessages.length,
      maxSingleToolTokens
    })
    if (emergencyPrune.records.length > 0) {
      activeMessages = emergencyPrune.messages
      recentHistory = activeMessages.filter((message) => message.id !== current.id)
      budget = this.measure(
        request, recentHistory, summary, resume, scope.historyVersion, rawHistoryTokens, current.attachments
      )
    }
    if (budget.pressureLevel === 'prune' || budget.pressureLevel === 'compact' || budget.pressureLevel === 'overflow') {
      const protectedTail = ModelHistoryNormalizer.selectProtocolSafeTail(
        activeMessages,
        this.budgetService.recentTailBudget(budget.usableInputBudget),
        (message) => this.budgetService.estimateValueTokens(message)
      )
      const protectedTailStart = protectedTail.length
        ? activeMessages.findIndex((message) => message.id === protectedTail[0].id)
        : activeMessages.length
      activeMessages = this.pruner.prune(activeMessages, {
        targetTokens: Math.floor(budget.usableInputBudget * 0.75),
        protectedTailStart: Math.max(0, protectedTailStart),
        maxSingleToolTokens
      }).messages
      recentHistory = activeMessages.filter((message) => message.id !== current.id)
      budget = this.measure(
        request, recentHistory, summary, resume, scope.historyVersion, rawHistoryTokens, current.attachments
      )
    }

    if (
      (budget.pressureLevel === 'compact' || budget.pressureLevel === 'overflow') &&
      request.allowCompaction !== false &&
      this.compaction
    ) {
      const result = await this.compaction.compact({
        sessionId: request.sessionId,
        contextScopeId: request.contextScopeId,
        trigger: 'auto_threshold',
        capabilities: request.capabilities,
        systemPrompt: request.systemPrompt,
        toolSchemas: request.toolSchemas,
        instructions: request.instructions
      })
      if (result.status === 'completed') {
        return this.build({ ...request, allowCompaction: false })
      }
    }

    if (budget.totalInputTokens > budget.hardInputLimit) {
      throw Object.assign(new Error('Model context exceeds the hard input limit'), {
        code: 'BUDGET_UNAVAILABLE',
        budget
      })
    }

    const items = this.buildItems(
      request.systemPrompt,
      request.instructions || [],
      summary,
      resume,
      activeMessages
    )
    return {
      items,
      messages: ProviderMessageAdapter.toChatMessages(items),
      budget,
      historyVersion: scope.historyVersion
    }
  }

  private measure(
    request: BuildModelContextRequest,
    recentHistory: NormalizedModelMessage[],
    summary: string,
    resume: string,
    historyVersion: number,
    rawHistoryTokens: number,
    currentAttachments: NormalizedModelMessage['attachments']
  ): ContextBudgetSnapshot {
    return this.budgetService.measureRequest({
      capabilities: request.capabilities,
      systemPrompt: request.systemPrompt,
      toolSchemas: request.toolSchemas,
      instructions: [...(request.instructions || []), resume],
      summary,
      recentHistory,
      rawHistoryTokens,
      currentInput: request.currentInput,
      currentAttachments,
      historyVersion,
      providerUsage: request.providerUsage,
      reasoningBudgetTokens: request.reasoningBudgetTokens,
      projectedAdditionalTokens: request.projectedAdditionalTokens
    })
  }

  private buildItems(
    systemPrompt: string,
    instructions: string[],
    summary: string,
    resume: string,
    history: NormalizedModelMessage[]
  ): ModelContextItem[] {
    const items: ModelContextItem[] = [
      { kind: 'system', message: { role: 'system', content: systemPrompt } }
    ]
    items.push(...instructions
      .filter((instruction) => instruction.trim())
      .map((instruction): ModelContextItem => ({
        kind: 'system',
        message: { role: 'system', content: instruction }
      })))
    if (summary) items.push({ kind: 'compaction_summary', message: { role: 'system', content: summary } })
    if (resume) items.push({ kind: 'resume_state', message: { role: 'system', content: resume } })
    items.push(...history.map((message): ModelContextItem => ({ kind: message.role, message })))
    return items
  }
}
