import type {
  ContextBudgetSnapshot,
  SessionRuntimeScopeSnapshot
} from '../../../shared/types/context'
import type { ModelContextCapabilities } from '../../../shared/types/provider'
import { ContextBudgetService } from './ContextBudgetService'
import { renderCompactionSummary } from './CompactionSummary'
import { ResumeStateManager } from './ResumeStateManager'
import { FileContextProjector } from './FileContextProjector'
import { FileContextRestorer } from './FileContextRestorer'
import { SkillContextRestorer } from './SkillContextRestorer'
import { ProviderMessageAdapter } from '../chat/ProviderMessageAdapter'
import { buildModelContextItems } from './ModelContextBuilder'
import {
  fingerprintProviderRequest,
  type ProviderUsageRequestProfile
} from './ProviderUsageRequestFingerprint'

export interface ModelDownshiftEvaluation {
  required: boolean
  budget?: ContextBudgetSnapshot
}

export async function evaluateModelDownshiftCompaction(input: {
  previousProviderId?: string
  nextProviderId?: string
  previousModel?: string
  nextModel: string
  scope?: SessionRuntimeScopeSnapshot
  capabilities: ModelContextCapabilities
  systemPrompt: string
  toolSchemas?: unknown[]
  instructions?: string[]
  providerRequestProfile?: ProviderUsageRequestProfile
  workspaceRoot?: string
  reasoningBudgetTokens?: number
  threshold?: number
  budgetService?: ContextBudgetService
}): Promise<ModelDownshiftEvaluation> {
  const { scope } = input
  if (!input.previousModel || !scope?.activeMessages.length) {
    return { required: false }
  }
  const budgetService = input.budgetService || new ContextBudgetService()
  const projectedMessages = new FileContextProjector(budgetService).project(
    scope.activeMessages
  ).messages
  const fileContext = await new FileContextRestorer(budgetService).reconcile({
    context: scope.postCompactionFileContext,
    messages: scope.activeMessages,
    workspaceRoot: input.workspaceRoot
  })
  const skillContext = new SkillContextRestorer(budgetService).reconcile({
    context: scope.postCompactionSkillContext,
    messages: scope.activeMessages
  })
  const resume = scope.resumeState && scope.resumeState.revision !== scope.latestCompactionResumeRevision
    ? new ResumeStateManager().renderBounded(scope.resumeState)
    : ''
  const summary = scope.latestCompaction ? renderCompactionSummary(scope.latestCompaction) : ''
  const usageAnchorMessage = scope.lastProviderUsageMessageId
    ? projectedMessages.find((message) => message.id === scope.lastProviderUsageMessageId)
    : undefined
  const anchorTurnInput = usageAnchorMessage
    ? projectedMessages.find((message) =>
        message.turnId === usageAnchorMessage.turnId && message.role === 'user'
      )
    : undefined
  const items = buildModelContextItems({
    systemPrompt: input.systemPrompt,
    instructions: input.instructions || [],
    summary,
    resume,
    skillContext,
    fileContext,
    currentInputMessageId: anchorTurnInput?.id || '',
    history: projectedMessages
  })
  const usageAnchorItemIndex = scope.lastProviderUsageMessageId
    ? items.findIndex((item) =>
        'id' in item.message && item.message.id === scope.lastProviderUsageMessageId
      )
    : -1
  const usagePrefixFingerprint = usageAnchorItemIndex >= 0
    ? fingerprintProviderRequest({
        messages: ProviderMessageAdapter.toChatMessages(items.slice(0, usageAnchorItemIndex)),
        toolSchemas: input.toolSchemas || [],
        profile: {
          ...(input.providerRequestProfile || {}),
          reasoningBudgetTokens: input.reasoningBudgetTokens
        }
      })
    : undefined
  const usageAnchorIndex = scope.lastProviderUsageMessageId
    ? projectedMessages.findIndex((message) => message.id === scope.lastProviderUsageMessageId)
    : -1
  const fileContextChanged = Boolean(
    scope.postCompactionFileContext &&
    scope.postCompactionFileContext.content !== fileContext?.content
  )
  const skillContextChanged = Boolean(
    scope.postCompactionSkillContext &&
    scope.postCompactionSkillContext.content !== skillContext?.content
  )
  const providerUsageMatches = usageAnchorIndex >= 0 &&
    Boolean(scope.lastProviderUsage) &&
    Boolean(scope.lastProviderUsageRequestFingerprint) &&
    scope.lastProviderUsageRequestFingerprint === usagePrefixFingerprint &&
    !fileContextChanged &&
    !skillContextChanged &&
    scope.lastProviderUsageModel === input.nextModel &&
    (
      !input.nextProviderId ||
      scope.lastProviderUsageProviderId === input.nextProviderId
    )
  const providerUsageAdditionalTokens = providerUsageMatches
    ? projectedMessages.slice(usageAnchorIndex + 1).reduce(
        (total, message) => total + budgetService.estimateValueTokens(message),
        0
      )
    : 0
  const budget = budgetService.measureRequest({
    capabilities: input.capabilities,
    systemPrompt: input.systemPrompt,
    toolSchemas: input.toolSchemas,
    instructions: [
      ...(input.instructions || []),
      ...(resume ? [resume] : []),
      ...(skillContext ? [skillContext.content] : []),
      ...(fileContext ? [fileContext.content] : [])
    ],
    summary,
    recentHistory: projectedMessages,
    currentInput: '',
    historyVersion: scope.historyVersion,
    providerUsage: providerUsageMatches ? scope.lastProviderUsage : undefined,
    providerUsageAdditionalTokens,
    reasoningBudgetTokens: input.reasoningBudgetTokens
  })
  const identityChanged = input.previousModel !== input.nextModel || Boolean(
    input.previousProviderId &&
    input.nextProviderId &&
    input.previousProviderId !== input.nextProviderId
  )
  return {
    required: identityChanged
      ? budget.totalInputTokens >= budget.usableInputBudget * (input.threshold ?? 0.9)
      : budget.pressureLevel === 'overflow',
    budget
  }
}
