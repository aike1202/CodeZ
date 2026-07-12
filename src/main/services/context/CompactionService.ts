import { createHash } from 'crypto'
import type {
  CompactionTrigger,
  ContextErrorCode,
  ContextScopeId,
  NormalizedModelMessage
} from '../../../shared/types/context'
import type { ModelContextCapabilities } from '../../../shared/types/provider'
import { ContextBudgetService } from './ContextBudgetService'
import { FileContextProjector } from './FileContextProjector'
import { FileContextRestorer } from './FileContextRestorer'
import type { CompactionModelClient } from './CompactionModelClient'
import { parseAndValidateSummary, renderCompactionSummary } from './CompactionSummary'
import { ModelHistoryNormalizer } from './ModelHistoryNormalizer'
import { ModelLedgerStore } from './ModelLedgerStore'
import { ToolOutputPruner } from './ToolOutputPruner'
import { SkillContextRestorer } from './SkillContextRestorer'

export interface CompactionRequest {
  sessionId: string
  contextScopeId: ContextScopeId
  trigger: CompactionTrigger
  capabilities: ModelContextCapabilities
  systemPrompt: string
  toolSchemas?: unknown[]
  instructions?: string[]
  manualInstructions?: string
  workspaceRoot?: string
  reasoningBudgetTokens?: number
  /** Durable user input that must remain addressable while its turn is active. */
  requiredMessageId?: string
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
  constructor(
    private readonly ledger: ModelLedgerStore,
    private readonly model: CompactionModelClient,
    private readonly budget = new ContextBudgetService(),
    private readonly observer: CompactionObserver = {},
    private readonly fileRestorer = new FileContextRestorer(budget),
    private readonly fileProjector = new FileContextProjector(budget),
    private readonly skillRestorer = new SkillContextRestorer(budget)
  ) {}

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    return this.ledger.runScopeExclusive(
      request.sessionId,
      request.contextScopeId,
      () => this.compactExclusive(request)
    )
  }

  private async compactExclusive(request: CompactionRequest): Promise<CompactionResult> {
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
      const currentSkillContext = this.skillRestorer.reconcile({
        context: scope.postCompactionSkillContext,
        messages: scope.activeMessages
      })
      const tokensBefore = this.measure(
        request,
        scope.activeMessages,
        scope.latestCompaction ? renderCompactionSummary(scope.latestCompaction) : '',
        sourceHistoryVersion,
        currentSkillContext?.content,
        scope.postCompactionFileContext?.content
      ).totalInputTokens
      const baseTailBudget = this.budget.recentTailBudget(
        this.budget.resolveLimits(
          request.capabilities,
          request.reasoningBudgetTokens
        ).usableInputBudget
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
            if (index > 0) {
              tailStart = index
              tail = scope.activeMessages.slice(index)
            }
            break
          }
        }
      }
      const head = tailStart > 0 ? scope.activeMessages.slice(0, tailStart) : []
      if (head.length === 0) {
        return this.fail(request, 'COMPACTION_INSUFFICIENT_REDUCTION', 'No protocol-safe history prefix can be compacted')
      }

      const retainedPrefixIndexes = new Set<number>()
      if (tail[0]?.role !== 'user') {
        for (let index = tailStart - 1; index >= 0; index--) {
          if (scope.activeMessages[index].role === 'user') {
            retainedPrefixIndexes.add(index)
            break
          }
        }
      }
      if (request.requiredMessageId) {
        const requiredIndex = scope.activeMessages.findIndex(
          (message) => message.id === request.requiredMessageId
        )
        if (requiredIndex >= 0 && requiredIndex < tailStart) retainedPrefixIndexes.add(requiredIndex)
      }
      const retainedMessages = [
        ...[...retainedPrefixIndexes]
          .sort((left, right) => left - right)
          .map((index) => scope.activeMessages[index]),
        ...tail
      ]

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

      const usable = this.budget.resolveLimits(
        request.capabilities,
        request.reasoningBudgetTokens
      ).usableInputBudget
      const projectedHead = this.fileProjector.project(head).messages
      const summaryMessages = new ToolOutputPruner(this.budget).prune(projectedHead, {
        targetTokens: Math.floor(usable * 0.6),
        protectedTailStart: projectedHead.length,
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
      const limits = this.budget.resolveLimits(
        request.capabilities,
        request.reasoningBudgetTokens
      )
      const restoreTarget = Math.min(
        limits.hardInputLimit,
        Math.floor(limits.usableInputBudget * 0.55)
      )
      const bareTokensAfter = this.measure(
        request,
        retainedMessages,
        renderedSummary,
        sourceHistoryVersion
      ).totalInputTokens
      const restoredSkillContext = this.skillRestorer.restore({
        messages: scope.activeMessages,
        retainedTail: retainedMessages,
        existing: scope.postCompactionSkillContext,
        maxTotalTokens: Math.max(0, restoreTarget - bareTokensAfter)
      })
      const baseTokensAfter = this.measure(
        request,
        retainedMessages,
        renderedSummary,
        sourceHistoryVersion,
        restoredSkillContext?.content
      ).totalInputTokens
      const restoredFileContext = await this.fileRestorer.restore({
        messages: scope.activeMessages,
        retainedTail: retainedMessages,
        existingReferences: scope.postCompactionFileContext?.fileReferences,
        workspaceRoot: request.workspaceRoot,
        maxTotalTokens: Math.max(0, restoreTarget - baseTokensAfter),
        maxVisibleToolTokens: Math.min(8_000, Math.floor(usable * 0.1))
      })
      const tokensAfter = this.measure(
        request,
        retainedMessages,
        renderedSummary,
        sourceHistoryVersion,
        restoredSkillContext?.content,
        restoredFileContext?.content
      ).totalInputTokens
      if (tokensAfter > limits.hardInputLimit) {
        lastFailure = {
          code: 'COMPACTION_INSUFFICIENT_REDUCTION',
          message: 'Compaction candidate still exceeds the model hard input limit'
        }
        continue
      }
      if (tokensAfter > usable * 0.55 && tokensAfter > tokensBefore * 0.8) {
        lastFailure = {
          code: 'COMPACTION_INSUFFICIENT_REDUCTION',
          message: 'Compaction candidate did not meet the target budget or minimum reduction'
        }
        continue
      }

      const sourceHash = createHash('sha256').update(JSON.stringify(head)).digest('hex')
      const completed = await this.ledger.appendIfHistoryVersion(
        request.sessionId,
        request.contextScopeId,
        sourceHistoryVersion,
        'compaction_completed',
        {
          trigger: request.trigger,
          sourceHistoryVersion,
          coveredThroughSequence,
          retainedFromSequence: retainedMessages[0]?.sourceSequence,
          tokensBefore,
          tokensAfter,
          sourceHash,
          summary,
          resumeState: scope.resumeState,
          activeMessages: retainedMessages,
          postCompactionFileContext: restoredFileContext,
          postCompactionSkillContext: restoredSkillContext
        }
      )
      if (!completed) {
        lastFailure = {
          code: 'COMPACTION_STALE_VERSION',
          message: 'History changed before the compaction candidate could be committed'
        }
        continue
      }

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
    historyVersion: number,
    skillContext?: string,
    fileContext?: string
  ) {
    return this.budget.measureRequest({
      capabilities: request.capabilities,
      systemPrompt: request.systemPrompt,
      toolSchemas: request.toolSchemas,
      instructions: [
        ...(request.instructions || []),
        ...(skillContext ? [skillContext] : []),
        ...(fileContext ? [fileContext] : [])
      ],
      summary,
      recentHistory: messages,
      currentInput: '',
      historyVersion,
      reasoningBudgetTokens: request.reasoningBudgetTokens
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
      retryable: code === 'COMPACTION_STALE_VERSION' ||
        code === 'COMPACTION_SUMMARY_FAILED' ||
        code === 'COMPACTION_SCHEMA_INVALID'
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
