import type {
  ContextBudgetSnapshot,
  SessionRuntimeScopeSnapshot
} from '../../../shared/types/context'
import type { ModelContextCapabilities } from '../../../shared/types/provider'
import { ContextBudgetService } from './ContextBudgetService'
import { renderCompactionSummary } from './CompactionSummary'

export interface ModelDownshiftEvaluation {
  required: boolean
  budget?: ContextBudgetSnapshot
}

export function evaluateModelDownshiftCompaction(input: {
  previousModel?: string
  nextModel: string
  scope?: SessionRuntimeScopeSnapshot
  capabilities: ModelContextCapabilities
  systemPrompt: string
  threshold?: number
  budgetService?: ContextBudgetService
}): ModelDownshiftEvaluation {
  const { scope } = input
  if (!input.previousModel || input.previousModel === input.nextModel || !scope?.activeMessages.length) {
    return { required: false }
  }
  const budgetService = input.budgetService || new ContextBudgetService()
  const budget = budgetService.measureRequest({
    capabilities: input.capabilities,
    systemPrompt: input.systemPrompt,
    summary: scope.latestCompaction ? renderCompactionSummary(scope.latestCompaction) : '',
    recentHistory: scope.activeMessages,
    currentInput: '',
    historyVersion: scope.historyVersion
  })
  return {
    required: budget.totalInputTokens >= budget.usableInputBudget * (input.threshold ?? 0.9),
    budget
  }
}
