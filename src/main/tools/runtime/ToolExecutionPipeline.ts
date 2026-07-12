import type { ToolContext } from '../Tool'
import { ToolHookRunner } from './ToolHookRunner'
import { ToolInputValidator } from './ToolInputValidator'
import { ToolScheduler } from './ToolScheduler'
import { ToolResultProcessor } from './ToolResultProcessor'
import { getToolExecutionJournal, type ToolExecutionJournal, type ToolJournalIdentity } from './ToolExecutionJournal'
import type { EnforcementMode } from './ToolRuntimeFeatureFlags'
import type {
  AgentRole,
  NormalizedToolCall,
  PreparedToolCall,
  ToolAuthorizationDecision,
  ToolCatalogSnapshot,
  ToolExecutionError,
  ToolExecutionResult,
  ToolExposurePlan,
  ToolPipelineResult,
  ToolPlanningContext,
  ToolRuntimeHook
} from './types'

export interface ToolExecutionPipelineContext {
  catalog: ToolCatalogSnapshot
  exposure?: ToolExposurePlan
  workspaceRoot: string
  sessionId?: string
  agentRole: AgentRole
  createToolContext(call: NormalizedToolCall, requestId?: string): ToolContext
  authorize(prepared: PreparedToolCall): Promise<ToolAuthorizationDecision>
  journalIdentity?: ToolJournalIdentity
}

function errorResult(error: ToolExecutionError, status: 'error' | 'denied' | 'cancelled' = 'error'): ToolExecutionResult {
  return { status, error, modelContent: `Error: ${error.message}` }
}

export class ToolExecutionPipeline {
  private readonly validator: ToolInputValidator
  private readonly scheduler: ToolScheduler
  private readonly hooks: ToolHookRunner
  private readonly resultProcessor: ToolResultProcessor
  private readonly journal: ToolExecutionJournal
  private readonly schedulerMode: EnforcementMode

  constructor(options: {
    validator?: ToolInputValidator
    scheduler?: ToolScheduler
    hooks?: readonly ToolRuntimeHook[]
    resultProcessor?: ToolResultProcessor
    journal?: ToolExecutionJournal
    schedulerMode?: EnforcementMode
    resultStoreEnabled?: boolean
  } = {}) {
    this.validator = options.validator || new ToolInputValidator()
    this.scheduler = options.scheduler || new ToolScheduler()
    this.hooks = new ToolHookRunner(options.hooks)
    this.resultProcessor = options.resultProcessor || new ToolResultProcessor(undefined, undefined, options.resultStoreEnabled ?? true)
    this.journal = options.journal || getToolExecutionJournal()
    this.schedulerMode = options.schedulerMode || 'enforce'
  }

  private async record(identity: ToolJournalIdentity | undefined, event: Parameters<ToolExecutionJournal['append']>[0]): Promise<void> {
    await this.journal.append({ ...identity, ...event }).catch(() => undefined)
  }

  async executeBatch(
    calls: readonly NormalizedToolCall[],
    context: ToolExecutionPipelineContext
  ): Promise<ToolPipelineResult[]> {
    const batchStartedAt = Date.now()
    this.validator.compile(context.catalog)
    await this.record(context.journalIdentity, {
      event: 'catalog.snapshot.created',
      catalogSnapshotId: context.catalog.id,
      schemaFingerprint: context.catalog.fingerprint
    })
    if (context.exposure) {
      await this.record(context.journalIdentity, {
        event: 'exposure.plan.created',
        exposurePlanId: context.exposure.id,
        schemaFingerprint: context.exposure.schemaFingerprint
      })
    }
    const immediate = new Map<number, ToolPipelineResult>()
    const prepared: PreparedToolCall[] = []
    const exposedNames = context.exposure
      ? new Set(context.exposure.eagerTools.map((descriptor) => descriptor.name))
      : null
    const planningContext: ToolPlanningContext = {
      workspaceRoot: context.workspaceRoot,
      sessionId: context.sessionId,
      agentRole: context.agentRole
    }

    for (const call of calls) {
      await this.record(context.journalIdentity, {
        event: 'tool.call.received',
        callId: call.callId,
        toolName: call.name,
        inputBytes: Buffer.byteLength(call.rawArguments, 'utf8')
      })
      const canonical = context.catalog.aliases.get(call.name) || call.name
      const handler = context.catalog.handlersByCanonicalName.get(canonical)
      if (!handler) {
        immediate.set(call.position, {
          call,
          canonicalName: canonical,
          result: errorResult({
            code: 'TOOL_NOT_FOUND',
            message: `Tool '${call.name}' is not registered in this catalog snapshot.`,
            recoverable: false
          })
        })
        continue
      }
      if (exposedNames && !exposedNames.has(canonical)) {
        immediate.set(call.position, {
          call,
          canonicalName: canonical,
          result: errorResult({
            code: 'TOOL_NOT_EXPOSED',
            message: `${canonical} is registered but was not exposed in this turn.`,
            recoverable: true,
            suggestion: 'Call ToolSearch for the required capability first.'
          })
        })
        continue
      }
      const validation = this.validator.validate(context.catalog, canonical, call.rawArguments)
      if (!validation.ok) {
        await this.record(context.journalIdentity, {
          event: 'tool.call.validation_failed',
          callId: call.callId,
          toolName: canonical,
          errorCode: validation.error.code,
          status: 'error'
        })
        immediate.set(call.position, {
          call,
          canonicalName: canonical,
          result: errorResult({
            code: validation.error.code,
            message: validation.error.message,
            recoverable: true,
            details: validation.error.issues ? { issues: validation.error.issues } : undefined
          })
        })
        continue
      }
      try {
        const [effects, resourceKeys] = await Promise.all([
          handler.descriptor.planEffects(validation.input, planningContext),
          handler.descriptor.resourceKeys(validation.input, planningContext)
        ])
        prepared.push({ call: { ...call, name: canonical }, handler, input: validation.input, effects, resourceKeys })
      } catch (error: any) {
        immediate.set(call.position, {
          call,
          canonicalName: canonical,
          input: validation.input,
          result: errorResult({
            code: 'TOOL_PLANNING_FAILED',
            message: error?.message || String(error),
            recoverable: false
          })
        })
      }
    }

    const hookPrepared: PreparedToolCall[] = []
    const hookDurationByCall = new Map<string, number>()
    for (const item of prepared) {
      const toolContext = context.createToolContext(item.call)
      try {
        const hookStartedAt = Date.now()
        const before = await this.hooks.beforeExecute({ prepared: item, toolContext })
        hookDurationByCall.set(item.call.callId, Date.now() - hookStartedAt)
        if (before.action === 'deny') {
          immediate.set(item.call.position, {
            call: item.call,
            canonicalName: item.handler.descriptor.name,
            input: item.input,
            result: errorResult(before.error, 'denied')
          })
          continue
        }
        if (before.action === 'replace-input') {
          const validation = this.validator.validate(
            context.catalog,
            item.handler.descriptor.name,
            JSON.stringify(before.input)
          )
          if (!validation.ok) {
            immediate.set(item.call.position, {
              call: item.call,
              canonicalName: item.handler.descriptor.name,
              input: before.input,
              result: errorResult({
                code: validation.error.code,
                message: validation.error.message,
                recoverable: true,
                details: validation.error.issues ? { issues: validation.error.issues } : undefined
              })
            })
            continue
          }
          const [effects, resourceKeys] = await Promise.all([
            item.handler.descriptor.planEffects(validation.input, planningContext),
            item.handler.descriptor.resourceKeys(validation.input, planningContext)
          ])
          hookPrepared.push({ ...item, input: validation.input, effects, resourceKeys })
          continue
        }
        hookPrepared.push(item)
      } catch (error: any) {
        immediate.set(item.call.position, {
          call: item.call,
          canonicalName: item.handler.descriptor.name,
          input: item.input,
          result: errorResult({
            code: 'TOOL_HOOK_FAILED',
            message: error?.message || String(error),
            recoverable: false
          })
        })
      }
    }

    const authorized: Array<{ prepared: PreparedToolCall; requestId: string }> = []
    for (const item of hookPrepared) {
      const permissionStartedAt = Date.now()
      await this.record(context.journalIdentity, {
        event: 'tool.call.permission_started',
        callId: item.call.callId,
        toolName: item.handler.descriptor.name,
        source: item.handler.descriptor.source,
        descriptorVersion: item.handler.descriptor.version
      })
      const decision = await context.authorize(item)
      await this.record(context.journalIdentity, {
        event: 'tool.call.permission_decided',
        callId: item.call.callId,
        toolName: item.handler.descriptor.name,
        decision: decision.allowed ? 'allow' : 'deny',
        status: decision.allowed ? 'queued' : 'denied',
        queueDurationMs: Date.now() - permissionStartedAt,
        errorCode: decision.error?.code,
        permissionRuleId: decision.permissionRuleId,
        permissionMode: decision.permissionMode
      })
      if (!decision.allowed) {
        immediate.set(item.call.position, {
          call: item.call,
          canonicalName: item.handler.descriptor.name,
          input: item.input,
          result: errorResult(decision.error || {
            code: 'TOOL_DENIED', message: 'Tool execution denied.', recoverable: false
          }, 'denied')
        })
      } else {
        authorized.push({ prepared: item, requestId: decision.requestId })
      }
    }

    const requestIds = new Map(authorized.map(({ prepared: item, requestId }) => [item.call.callId, requestId]))
    const authorizedCalls = authorized.map((item) => item.prepared)
    const plannedWaves = this.scheduler.plan(authorizedCalls)
    const waves = this.schedulerMode === 'enforce'
      ? plannedWaves
      : authorizedCalls.length > 0
        ? [{ index: 0, calls: authorizedCalls, reason: 'independent' as const }]
        : []
    const executed = new Map<number, ToolPipelineResult>()
    for (const wave of waves) {
      const queuedAt = Date.now()
      await Promise.all(wave.calls.map((item) => this.record(context.journalIdentity, {
        event: 'tool.call.queued',
        callId: item.call.callId,
        toolName: item.handler.descriptor.name,
        resourceKeyCount: item.resourceKeys.length,
        wave: wave.index
      })))
      const waveResults = await Promise.all(wave.calls.map(async (item) => {
        const requestId = requestIds.get(item.call.callId)
        const toolContext = context.createToolContext(item.call, requestId)
        if (toolContext.abortSignal?.aborted) {
          return {
            call: item.call,
            canonicalName: item.handler.descriptor.name,
            input: item.input,
            result: errorResult({
              code: 'TOOL_CANCELLED', message: 'Tool execution was cancelled.', recoverable: false
            }, 'cancelled')
          } satisfies ToolPipelineResult
        }
        try {
          const executionStartedAt = Date.now()
          await this.record(context.journalIdentity, {
            event: 'tool.call.started',
            callId: item.call.callId,
            toolName: item.handler.descriptor.name,
            queueDurationMs: executionStartedAt - queuedAt,
            wave: wave.index
          })
          const rawResult = await item.handler.execute(item.input, toolContext)
          const afterHookStartedAt = Date.now()
          const result = await this.hooks.afterExecute({ prepared: item, toolContext, result: rawResult })
          hookDurationByCall.set(
            item.call.callId,
            (hookDurationByCall.get(item.call.callId) || 0) + Date.now() - afterHookStartedAt
          )
          await this.record(context.journalIdentity, {
            event: result.status === 'success' ? 'tool.call.completed' : result.status === 'cancelled' ? 'tool.call.cancelled' : 'tool.call.failed',
            callId: item.call.callId,
            toolName: item.handler.descriptor.name,
            source: item.handler.descriptor.source,
            descriptorVersion: item.handler.descriptor.version,
            status: result.status,
            errorCode: result.status === 'success' ? undefined : result.error.code,
            recoverable: result.status === 'success' ? undefined : result.error.recoverable,
            executionDurationMs: Date.now() - executionStartedAt,
            resultBytes: result.status === 'success' ? Buffer.byteLength(JSON.stringify(result.data ?? ''), 'utf8') : undefined,
            modelResultBytes: Buffer.byteLength(result.modelContent || '', 'utf8'),
            hookDurationMs: hookDurationByCall.get(item.call.callId),
            wave: wave.index
          })
          return {
            call: item.call,
            canonicalName: item.handler.descriptor.name,
            input: item.input,
            result
          } satisfies ToolPipelineResult
        } catch (error: any) {
          return {
            call: item.call,
            canonicalName: item.handler.descriptor.name,
            input: item.input,
            result: errorResult({
              code: toolContext.abortSignal?.aborted ? 'TOOL_CANCELLED' : 'TOOL_EXECUTION_FAILED',
              message: error?.message || String(error),
              recoverable: false
            }, toolContext.abortSignal?.aborted ? 'cancelled' : 'error')
          } satisfies ToolPipelineResult
        }
      }))
      for (const result of waveResults) executed.set(result.call.position, result)
    }

    const ordered = calls.map((call) => immediate.get(call.position) || executed.get(call.position) || {
      call,
      canonicalName: call.name,
      result: errorResult({
        code: 'TOOL_RESULT_MISSING', message: 'Tool execution produced no result.', recoverable: false
      })
    })
    const processed = await this.resultProcessor.processBatch(ordered, {
      workspaceRoot: context.workspaceRoot,
      sessionId: context.sessionId
    })
    await Promise.all(processed.map(async (item, index) => {
      const original = ordered[index]
      if (original?.result.status !== 'success' || item.result.status !== 'success') return
      if (!item.result.modelContent.includes('<persisted-tool-result ')) return
      await this.record(context.journalIdentity, {
        event: 'tool.result.persisted',
        callId: item.call.callId,
        toolName: item.canonicalName,
        source: item.call.name.startsWith('mcp__') ? 'mcp' : undefined,
        persistedBytes: Buffer.byteLength(original.result.modelContent, 'utf8'),
        modelResultBytes: Buffer.byteLength(item.result.modelContent, 'utf8'),
        status: 'persisted'
      })
    }))
    await this.record(context.journalIdentity, {
      event: 'tool.batch.completed',
      status: processed.every((item) => item.result.status === 'success') ? 'success' : 'partial',
      executionDurationMs: Date.now() - batchStartedAt,
      batchSize: processed.length,
      modelResultBytes: processed.reduce((sum, item) => sum + Buffer.byteLength(item.result.modelContent || '', 'utf8'), 0)
    })
    return processed
  }
}
