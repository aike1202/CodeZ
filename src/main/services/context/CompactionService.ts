import { createHash } from 'crypto'
import type {
  CompactionTrigger,
  ContextErrorCode,
  ContextScopeId,
  NormalizedModelMessage
} from '../../../shared/types/context'
import type { ModelContextCapabilities } from '../../../shared/types/provider'
import { ContextBudgetService } from './ContextBudgetService'
import type { CompactionModelClient } from './CompactionModelClient'
import { parseAndValidateSummary, renderCompactionSummary } from './CompactionSummary'
import { ModelHistoryNormalizer } from './ModelHistoryNormalizer'
import { ModelLedgerStore } from './ModelLedgerStore'
import { ToolOutputPruner } from './ToolOutputPruner'

export interface CompactionRequest {
  sessionId: string
  contextScopeId: ContextScopeId
  trigger: CompactionTrigger
  capabilities: ModelContextCapabilities
  systemPrompt: string
  toolSchemas?: unknown[]
  instructions?: string[]
  manualInstructions?: string
}

export interface CompactionResult {
  status: 'completed' | 'failed'
  errorCode?: ContextErrorCode
  message?: string
  tokensBefore?: number
  tokensAfter?: number
  snapshotStatus?: 'committed' | 'deferred'
  historyVersion?: number
}

export interface CompactionObserver {
  onStarted?: (event: {
    sessionId: string
    contextScopeId: ContextScopeId
    trigger: CompactionTrigger
    tokensBefore: number
  }) => void
  onCompleted?: (event: CompactionResult & { sessionId: string; contextScopeId: ContextScopeId; trigger: CompactionTrigger }) => void
  onFailed?: (event: CompactionResult & { sessionId: string; contextScopeId: ContextScopeId; trigger: CompactionTrigger }) => void
}

export class CompactionService {
  private terminalFailure?: CompactionResult

  constructor(
    private readonly ledger: ModelLedgerStore,
    private readonly model: CompactionModelClient,
    private readonly budget = new ContextBudgetService(),
    private readonly observer: CompactionObserver = {}
  ) {}

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    if (this.terminalFailure) return this.terminalFailure
    let lastFailure: { code: ContextErrorCode; message: string } = {
      code: 'COMPACTION_INSUFFICIENT_REDUCTION',
      message: 'Compaction did not produce a usable reduction'
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.ledger.load(request.sessionId)
      const scope = state.scopes[request.contextScopeId]
      if (!scope || scope.activeMessages.length === 0) {
        return this.fail(request, 'COMPACTION_INSUFFICIENT_REDUCTION', 'No history is available to compact')
      }

      const sourceHistoryVersion = scope.historyVersion
      const tokensBefore = this.measure(
        request,
        scope.activeMessages,
        scope.latestCompaction ? renderCompactionSummary(scope.latestCompaction) : '',
        sourceHistoryVersion
      ).totalInputTokens
      const baseTailBudget = this.budget.recentTailBudget(
        this.budget.resolveLimits(request.capabilities).usableInputBudget
      )
      const tailBudget = Math.max(1, Math.floor(baseTailBudget / (attempt + 1)))
      let tail = ModelHistoryNormalizer.selectProtocolSafeTail(
        scope.activeMessages,
        tailBudget,
        (message) => this.budget.estimateValueTokens(message)
      )
      let tailStart = scope.activeMessages.findIndex((message) => message.id === tail[0]?.id)
      if (tailStart > 0 && tail[0].role !== 'user') {
        for (let index = tailStart - 1; index >= 0; index--) {
          if (scope.activeMessages[index].role === 'user') {
            tailStart = index
            tail = scope.activeMessages.slice(index)
            break
          }
        }
      }
      const head = tailStart > 0 ? scope.activeMessages.slice(0, tailStart) : []
      if (head.length === 0) {
        return this.fail(request, 'COMPACTION_INSUFFICIENT_REDUCTION', 'No protocol-safe history prefix can be compacted')
      }

      const coveredThroughSequence = head.at(-1)?.sourceSequence
      if (!coveredThroughSequence) {
        return this.fail(request, 'COMPACTION_SCHEMA_INVALID', 'Compaction boundary has no durable sequence')
      }

      await this.ledger.append(request.sessionId, request.contextScopeId, 'compaction_started', {
        trigger: request.trigger,
        sourceHistoryVersion,
        candidateThroughSequence: coveredThroughSequence,
        tokensBefore
      })
      this.observer.onStarted?.({
        sessionId: request.sessionId,
        contextScopeId: request.contextScopeId,
        trigger: request.trigger,
        tokensBefore
      })

      const usable = this.budget.resolveLimits(request.capabilities).usableInputBudget
      const summaryMessages = new ToolOutputPruner(this.budget).prune(head, {
        targetTokens: Number.POSITIVE_INFINITY,
        protectedTailStart: 0,
        maxSingleToolTokens: Math.min(8_000, Math.floor(usable * 0.1))
      }).messages
      let summary: ReturnType<typeof parseAndValidateSummary> | undefined
      let validationFeedback: string | undefined
      let previousInvalidOutput: string | undefined
      for (let schemaAttempt = 0; schemaAttempt < 2; schemaAttempt++) {
        let raw: string
        try {
          raw = await this.model.generate({
            coveredThroughSequence,
            messages: summaryMessages,
            previousSummary: scope.latestCompaction,
            resumeState: scope.resumeState,
            instructions: request.manualInstructions,
            validationFeedback,
            previousInvalidOutput
          })
        } catch (error) {
          return this.fail(
            request,
            'COMPACTION_SUMMARY_FAILED',
            error instanceof Error ? error.message : String(error)
          )
        }
        try {
          summary = parseAndValidateSummary(raw, coveredThroughSequence)
          break
        } catch (error) {
          const schemaError = (error as any)?.code === 'COMPACTION_SCHEMA_INVALID'
          if (schemaError && schemaAttempt === 0) {
            validationFeedback = error instanceof Error ? error.message : String(error)
            previousInvalidOutput = raw.slice(0, 32_000)
            continue
          }
          const code = schemaError ? 'COMPACTION_SCHEMA_INVALID' : 'COMPACTION_SUMMARY_FAILED'
          const failure = await this.fail(
            request,
            code,
            error instanceof Error ? error.message : String(error)
          )
          if (code === 'COMPACTION_SCHEMA_INVALID') this.terminalFailure = failure
          return failure
        }
      }
      if (!summary) throw new Error('Compaction summary retry ended without a result')

      const latest = await this.ledger.load(request.sessionId)
      if (latest.scopes[request.contextScopeId]?.historyVersion !== sourceHistoryVersion) {
        lastFailure = {
          code: 'COMPACTION_STALE_VERSION',
          message: 'History changed while the compaction summary was generated'
        }
        continue
      }

      const renderedSummary = renderCompactionSummary(summary)
      const tokensAfter = this.measure(
        request,
        tail,
        renderedSummary,
        sourceHistoryVersion
      ).totalInputTokens
      if (tokensAfter > usable * 0.55 && tokensAfter > tokensBefore * 0.8) {
        lastFailure = {
          code: 'COMPACTION_INSUFFICIENT_REDUCTION',
          message: 'Compaction candidate did not meet the target budget or minimum reduction'
        }
        continue
      }

      const sourceHash = createHash('sha256').update(JSON.stringify(head)).digest('hex')
      const completed = await this.ledger.append(request.sessionId, request.contextScopeId, 'compaction_completed', {
        trigger: request.trigger,
        sourceHistoryVersion,
        coveredThroughSequence,
        retainedFromSequence: tail[0]?.sourceSequence,
        tokensBefore,
        tokensAfter,
        sourceHash,
        summary,
        resumeState: scope.resumeState,
        activeMessages: tail
      })

      let snapshotStatus: CompactionResult['snapshotStatus'] = 'committed'
      try {
        await this.ledger.writeSnapshot(request.sessionId)
        await this.ledger.compactPhysicalLog(request.sessionId)
      } catch {
        snapshotStatus = 'deferred'
      }
      const result: CompactionResult = {
        status: 'completed',
        tokensBefore,
        tokensAfter,
        snapshotStatus,
        historyVersion: completed.historyVersion
      }
      this.observer.onCompleted?.({
        ...result,
        sessionId: request.sessionId,
        contextScopeId: request.contextScopeId,
        trigger: request.trigger
      })
      return result
    }

    return this.fail(request, lastFailure.code, lastFailure.message)
  }

  private measure(
    request: CompactionRequest,
    messages: NormalizedModelMessage[],
    summary: string,
    historyVersion: number
  ) {
    return this.budget.measureRequest({
      capabilities: request.capabilities,
      systemPrompt: request.systemPrompt,
      toolSchemas: request.toolSchemas,
      instructions: request.instructions,
      summary,
      recentHistory: messages,
      currentInput: '',
      historyVersion
    })
  }

  private async fail(
    request: CompactionRequest,
    code: ContextErrorCode,
    message: string
  ): Promise<CompactionResult> {
    await this.ledger.append(request.sessionId, request.contextScopeId, 'compaction_failed', {
      trigger: request.trigger,
      stage: 'compaction',
      code,
      message,
      retryable: code === 'COMPACTION_STALE_VERSION' || code === 'COMPACTION_SUMMARY_FAILED'
    })
    const result: CompactionResult = { status: 'failed', errorCode: code, message }
    this.observer.onFailed?.({
      ...result,
      sessionId: request.sessionId,
      contextScopeId: request.contextScopeId,
      trigger: request.trigger
    })
    return result
  }
}
