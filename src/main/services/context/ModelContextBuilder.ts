import type {
  ContextBudgetSnapshot,
  ContextScopeId,
  ModelContextItem,
  NormalizedModelMessage,
  PostCompactionFileContext,
  PostCompactionSkillContext
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
import { FileContextProjector } from './FileContextProjector'
import { FileContextRestorer } from './FileContextRestorer'
import { ModelHistoryNormalizer } from './ModelHistoryNormalizer'
import { ModelLedgerStore } from './ModelLedgerStore'
import { ResumeStateManager } from './ResumeStateManager'
import { ToolOutputPruner } from './ToolOutputPruner'
import { SkillContextRestorer } from './SkillContextRestorer'
import {
  activeSessionSkillNames,
  renderSessionSkillStateContext
} from './SessionSkillState'
import {
  fingerprintProviderRequest,
  type ProviderUsageRequestProfile
} from './ProviderUsageRequestFingerprint'

export interface BuildModelContextRequest {
  sessionId: string
  contextScopeId: ContextScopeId
  currentInputMessageId: string
  currentInput: string
  capabilities: ModelContextCapabilities
  systemPrompt: string
  toolSchemas: unknown[]
  instructions?: string[]
  providerRequestProfile?: ProviderUsageRequestProfile
  reasoningBudgetTokens?: number
  projectedAdditionalTokens?: number
  allowCompaction?: boolean
  workspaceRoot?: string
}

export interface BuiltModelContext {
  items: ModelContextItem[]
  messages: ChatMessage[]
  budget: ContextBudgetSnapshot
  historyVersion: number
  providerUsageRequestFingerprint: string
}

export function buildModelContextItems(input: {
  systemPrompt: string
  instructions: readonly string[]
  summary: string
  resume: string
  skillContext?: PostCompactionSkillContext
  sessionSkillState?: string
  fileContext?: PostCompactionFileContext
  currentInputMessageId: string
  history: readonly NormalizedModelMessage[]
}): ModelContextItem[] {
  const items: ModelContextItem[] = [
    { kind: 'system', message: { role: 'system', content: input.systemPrompt } }
  ]
  items.push(...input.instructions
    .filter((instruction) => instruction.trim())
    .map((instruction): ModelContextItem => ({
      kind: 'system',
      message: { role: 'system', content: instruction }
    })))
  if (input.summary) {
    items.push({ kind: 'compaction_summary', message: { role: 'system', content: input.summary } })
  }
  if (input.resume) {
    items.push({ kind: 'resume_state', message: { role: 'system', content: input.resume } })
  }
  for (const message of input.history) {
    if (input.skillContext && message.id === input.currentInputMessageId) {
      items.push({
        kind: 'skill_context',
        message: {
          id: `skill-context:${input.skillContext.sourceSequence ?? input.skillContext.createdAt}`,
          turnId: message.turnId,
          role: 'assistant',
          content: input.skillContext.content,
          status: 'complete',
          createdAt: input.skillContext.createdAt,
          sourceSequence: input.skillContext.sourceSequence
        }
      })
    }
    if (input.sessionSkillState && message.id === input.currentInputMessageId) {
      items.push({
        kind: 'skill_state',
        message: {
          id: `skill-state:${message.turnId}`,
          turnId: message.turnId,
          role: 'assistant',
          content: input.sessionSkillState,
          status: 'complete',
          createdAt: message.createdAt
        }
      })
    }
    if (input.fileContext && message.id === input.currentInputMessageId) {
      items.push({
        kind: 'file_context',
        message: {
          id: `file-context:${input.fileContext.sourceSequence ?? input.fileContext.createdAt}`,
          turnId: message.turnId,
          role: 'assistant',
          content: input.fileContext.content,
          fileReferences: input.fileContext.fileReferences.map((reference) => ({ ...reference })),
          status: 'complete',
          createdAt: input.fileContext.createdAt,
          sourceSequence: input.fileContext.sourceSequence
        }
      })
    }
    items.push({ kind: message.role, message })
  }
  return items
}

export class ModelContextBuilder {
  constructor(
    private readonly ledger: ModelLedgerStore,
    private readonly budgetService = new ContextBudgetService(),
    private readonly pruner = new ToolOutputPruner(budgetService),
    private readonly resumeStates = new ResumeStateManager(),
    private readonly compaction?: CompactionService,
    private readonly fileProjector = new FileContextProjector(budgetService),
    private readonly fileRestorer = new FileContextRestorer(budgetService),
    private readonly skillRestorer = new SkillContextRestorer(budgetService)
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
      current.attachments,
      request.reasoningBudgetTokens
    )
    const rawHistoryTokens = scope.activeMessages
      .filter((message) => message.id !== current.id)
      .reduce((total, message) => total + this.budgetService.estimateValueTokens(message), 0)
    const fileProjection = this.fileProjector.project(scope.activeMessages)
    let activeMessages = fileProjection.messages
    let recentHistory = activeMessages.filter((message) => message.id !== current.id)
    const summary = scope.latestCompaction ? renderCompactionSummary(scope.latestCompaction) : ''
    const resume = scope.resumeState && scope.resumeState.revision !== scope.latestCompactionResumeRevision
      ? this.resumeStates.renderBounded(scope.resumeState)
      : ''
    const fileContext = await this.fileRestorer.reconcile({
      context: scope.postCompactionFileContext,
      messages: scope.activeMessages,
      workspaceRoot: request.workspaceRoot
    })
    const skillContext = this.skillRestorer.reconcile({
      context: scope.postCompactionSkillContext,
      messages: scope.activeMessages,
      activeSkillNames: activeSessionSkillNames(scope.skillStates),
      activeSkills: scope.skillStates
    })
    const sessionSkillState = renderSessionSkillStateContext(scope.skillStates)

    const fileContextChanged = Boolean(
      scope.postCompactionFileContext &&
      scope.postCompactionFileContext.content !== fileContext?.content
    )
    const skillContextChanged = Boolean(
      scope.postCompactionSkillContext &&
      scope.postCompactionSkillContext.content !== skillContext?.content
    )
    const resolveProviderBaseline = (
      messages: readonly NormalizedModelMessage[]
    ): { usage: ProviderTokenUsage; additionalTokens: number } | undefined => {
      if (
        fileContextChanged || skillContextChanged ||
        !scope.lastProviderUsage ||
        !scope.lastProviderUsageMessageId ||
        !scope.lastProviderUsageRequestFingerprint
      ) return undefined
      const items = buildModelContextItems({
        systemPrompt: request.systemPrompt,
        instructions: request.instructions || [],
        summary,
        resume,
        skillContext,
        sessionSkillState,
        fileContext,
        currentInputMessageId: current.id,
        history: messages
      })
      const anchorItemIndex = items.findIndex((item) =>
        'id' in item.message && item.message.id === scope.lastProviderUsageMessageId
      )
      const anchorMessageIndex = messages.findIndex((message) =>
        message.id === scope.lastProviderUsageMessageId
      )
      if (anchorItemIndex < 0 || anchorMessageIndex < 0) return undefined
      const prefixFingerprint = this.fingerprintRequest(
        request,
        items.slice(0, anchorItemIndex)
      )
      if (prefixFingerprint !== scope.lastProviderUsageRequestFingerprint) return undefined
      return {
        usage: scope.lastProviderUsage,
        additionalTokens: messages.slice(anchorMessageIndex + 1).reduce(
          (total, message) => total + this.budgetService.estimateValueTokens(message),
          0
        )
      }
    }
    let providerBaseline = resolveProviderBaseline(activeMessages)
    let budget = this.measure(
      request, recentHistory, summary, resume, skillContext?.content || '', sessionSkillState, fileContext?.content || '',
      scope.historyVersion, rawHistoryTokens,
      current.attachments, providerBaseline?.usage,
      providerBaseline?.additionalTokens
    )
    const maxSingleToolTokens = Math.min(
      8_000,
      Math.floor(budget.usableInputBudget * 0.1)
    )
    let lastAssistantInCurrentTurn = -1
    for (let index = activeMessages.length - 1; index >= 0; index--) {
      const message = activeMessages[index]
      if (message.turnId === current.turnId && message.role === 'assistant') {
        lastAssistantInCurrentTurn = index
        break
      }
    }
    const unconsumedToolResultIds = new Set(
      activeMessages
        .slice(lastAssistantInCurrentTurn + 1)
        .filter((message) => message.turnId === current.turnId && message.role === 'tool')
        .map((message) => message.id)
    )
    for (const id of fileProjection.protectedMessageIds) unconsumedToolResultIds.add(id)
    const emergencyPrune = this.pruner.prune(activeMessages, {
      targetTokens: Number.POSITIVE_INFINITY,
      protectedTailStart: activeMessages.length,
      maxSingleToolTokens,
      protectedMessageIds: unconsumedToolResultIds
    })
    if (emergencyPrune.records.length > 0) {
      activeMessages = emergencyPrune.messages
      recentHistory = activeMessages.filter((message) => message.id !== current.id)
      providerBaseline = resolveProviderBaseline(activeMessages)
      budget = this.measure(
        request, recentHistory, summary, resume, skillContext?.content || '', sessionSkillState, fileContext?.content || '',
        scope.historyVersion, rawHistoryTokens,
        current.attachments,
        providerBaseline?.usage,
        providerBaseline?.additionalTokens
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
      const pressurePrune = this.pruner.prune(activeMessages, {
        targetTokens: Math.floor(budget.usableInputBudget * 0.75),
        protectedTailStart: Math.max(0, protectedTailStart),
        maxSingleToolTokens,
        protectedMessageIds: unconsumedToolResultIds
      })
      activeMessages = pressurePrune.messages
      recentHistory = activeMessages.filter((message) => message.id !== current.id)
      providerBaseline = resolveProviderBaseline(activeMessages)
      budget = this.measure(
        request, recentHistory, summary, resume, skillContext?.content || '', sessionSkillState, fileContext?.content || '',
        scope.historyVersion, rawHistoryTokens,
        current.attachments,
        providerBaseline?.usage,
        providerBaseline?.additionalTokens
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
        instructions: request.instructions,
        workspaceRoot: request.workspaceRoot,
        reasoningBudgetTokens: request.reasoningBudgetTokens,
        requiredMessageId: request.currentInputMessageId
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

    const items = buildModelContextItems({
      systemPrompt: request.systemPrompt,
      instructions: request.instructions || [],
      summary,
      resume,
      skillContext,
      sessionSkillState,
      fileContext,
      currentInputMessageId: current.id,
      history: activeMessages
    })
    const messages = ProviderMessageAdapter.toChatMessages(items)
    return {
      items,
      messages,
      budget,
      historyVersion: scope.historyVersion,
      providerUsageRequestFingerprint: fingerprintProviderRequest({
        messages,
        toolSchemas: request.toolSchemas,
        profile: this.requestProfile(request)
      })
    }
  }

  private measure(
    request: BuildModelContextRequest,
    recentHistory: NormalizedModelMessage[],
    summary: string,
    resume: string,
    skillContext: string,
    sessionSkillState: string,
    fileContext: string,
    historyVersion: number,
    rawHistoryTokens: number,
    currentAttachments: NormalizedModelMessage['attachments'],
    providerUsage?: ProviderTokenUsage,
    providerUsageAdditionalTokens = 0
  ): ContextBudgetSnapshot {
    return this.budgetService.measureRequest({
      capabilities: request.capabilities,
      systemPrompt: request.systemPrompt,
      toolSchemas: request.toolSchemas,
      instructions: [
        ...(request.instructions || []),
        ...(resume ? [resume] : []),
        ...(skillContext ? [skillContext] : []),
        ...(sessionSkillState ? [sessionSkillState] : []),
        ...(fileContext ? [fileContext] : [])
      ],
      summary,
      recentHistory,
      rawHistoryTokens,
      currentInput: request.currentInput,
      currentAttachments,
      historyVersion,
      providerUsage,
      providerUsageAdditionalTokens,
      reasoningBudgetTokens: request.reasoningBudgetTokens,
      projectedAdditionalTokens: request.projectedAdditionalTokens
    })
  }

  private requestProfile(request: BuildModelContextRequest): ProviderUsageRequestProfile {
    return {
      ...(request.providerRequestProfile || {}),
      reasoningBudgetTokens: request.reasoningBudgetTokens
    }
  }

  private fingerprintRequest(
    request: BuildModelContextRequest,
    items: readonly ModelContextItem[]
  ): string {
    return fingerprintProviderRequest({
      messages: ProviderMessageAdapter.toChatMessages([...items]),
      toolSchemas: request.toolSchemas,
      profile: this.requestProfile(request)
    })
  }
}
