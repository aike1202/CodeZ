import { ChatService } from '../../services/ChatService'
import { ToolManager } from '../../tools/ToolManager'
import { EditTransactionService, getEditTransactionService } from '../../services/EditTransactionService'
import {
  authorizePermissionToolCall,
  evaluatePermissionEffectPlanShadow,
  type PermissionToolAuthorization
} from '../../services/PermissionManager'
import { normalizeAskUserTextFallback } from '../../tools/builtin/AskUserQuestionTool'
import { SubAgentManager } from '../SubAgentManager'
import { RulesResolver } from '../RulesResolver'
import type { ChatProviderErrorCode, ProviderTokenUsage, ToolDefinition } from '../../../shared/types/provider'
import log from '../../logger'
import { logPrompt } from '../../services/PromptLogger'

import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import {
  getToolRuntimeFeatureFlags,
  LegacyToolExecutionPipeline,
  ToolCallAssembler,
  ToolExecutionPipeline
} from '../../tools/runtime'
import { getToolExposureState } from '../../tools/runtime/ToolExposurePlanner'
import type { NormalizedToolCall, ToolEffectPlan, ToolPipelineResult } from '../../tools/runtime'
import { createAgentRuntimeToolInvoker } from './runtimeToolInvoker'
import { getSessionStore } from '../../ipc/session.handlers'
import { LoopStateMachine, AgentState, TransitionEvent, TerminationReason } from './LoopStateMachine'
import { streamWithTimeoutRetry } from '../../services/chat/retry'
import { mergeProviderUsage } from '../../services/chat/usage'
import type { SmartApprovalClient } from '../../services/permission/SmartApprovalService'
import { ChatSmartApprovalClient } from '../../services/permission/ChatSmartApprovalClient'
import { ContextBudgetService } from '../../services/context/ContextBudgetService'
import { getReadFingerprintStore } from '../../tools/ReadFingerprintStore'
import type { ChatSteerInput } from '../../../shared/types/queuedPrompt'
import type { ToolApprovalPreference } from '../../../shared/types/permission'
import { resolveEffectiveReasoningBudgetTokens } from '../../services/chat/utils'
import { getAgentCollaborationRuntime } from '../../services/agents'

export enum NormalizedStopReason {
  Truncated = 'Truncated',
  Finished = 'Finished',
  ToolUse = 'ToolUse',
  Blocked = 'Blocked',
  Unknown = 'Unknown',
}

function normalizeProviderStopReason(reason?: string): NormalizedStopReason {
  if (!reason) return NormalizedStopReason.Unknown;
  const lower = reason.toLowerCase();
  if (lower === 'length' || lower === 'max_tokens') return NormalizedStopReason.Truncated;
  if (lower === 'stop' || lower === 'end_turn') return NormalizedStopReason.Finished;
  if (lower === 'tool_calls' || lower === 'tool_use') return NormalizedStopReason.ToolUse;
  if (lower === 'content_filter' || lower === 'safety') return NormalizedStopReason.Blocked;
  return NormalizedStopReason.Unknown;
}

export function unwrapModelToolResultForUi(content: string): string {
  try {
    const parsed = JSON.parse(content)
    if (parsed?.ok === true) {
      return typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data)
    }
    if (parsed?.ok === false) {
      if (typeof parsed.error === 'string') return parsed.error
      if (typeof parsed.error?.message === 'string') return parsed.error.message
      return JSON.stringify(parsed.error)
    }
  } catch {}
  return content
}

export type ToolAuthorization = PermissionToolAuthorization

export async function authorizeToolCall(
  toolName: string,
  parsedArgs: unknown,
  workspaceRoot: string,
  onPermissionRequest?: AgentRunnerCallbacks['onPermissionRequest'],
  smartApprovalClient?: SmartApprovalClient | null,
  sessionId?: string,
  effectPlan?: ToolEffectPlan,
  approvalPreference: ToolApprovalPreference | null = null
): Promise<ToolAuthorization> {
  return authorizePermissionToolCall(
    toolName,
    parsedArgs,
    workspaceRoot,
    onPermissionRequest,
    smartApprovalClient,
    sessionId,
    undefined,
    effectPlan,
    approvalPreference
  )
}

export function resolveAgentTransition(input: {
  toolCallCount: number
  isVerificationFailure: boolean | null
  verificationRetryCount: number
  maxVerificationRetries: number
  repeatedFailureLimitReached?: boolean
  stopReason?: import('../../../shared/types/provider').AgentStopReason
  assistantContent?: string
}): TransitionEvent {
  if (input.repeatedFailureLimitReached) {
    return TransitionEvent.RepeatedFailure
  }

  if (input.toolCallCount > 0) {
    return TransitionEvent.ToolExecuted
  }

  if (input.isVerificationFailure && input.verificationRetryCount < input.maxVerificationRetries) {
    return TransitionEvent.RetryRequested
  }

  return TransitionEvent.Completed
}

export class AgentRunner {
  private chatService: ChatService
  private toolManager: ToolManager
  private editTransactionService: EditTransactionService
  private abortController: AbortController | null = null
  private pendingSteers: ChatSteerInput[] = []
  private acceptingSteers = false

  constructor(dependencies: {
    chatService?: ChatService
    toolManager?: ToolManager
    editTransactionService?: EditTransactionService
  } = {}) {
    this.chatService = dependencies.chatService || new ChatService()
    this.toolManager = dependencies.toolManager || new ToolManager()
    this.editTransactionService = dependencies.editTransactionService || getEditTransactionService()
  }

  async run(config: AgentRunConfig, callbacks: AgentRunnerCallbacks): Promise<void> {
    this.abortController = new AbortController()
    this.pendingSteers = []

    if (!(
      config.runtimeTurn && config.runtimeCoordinator && config.contextBuilder &&
      config.contextCapabilities && config.systemPrompt
    )) {
      throw new Error('AgentRunner requires the canonical model ledger runtime')
    }
    this.acceptingSteers = true
    const runtimeTurn = config.runtimeTurn
    const runtimeCoordinator = config.runtimeCoordinator
    const sessionId = runtimeTurn?.sessionId || config.sessionId || `session_${Date.now()}`
    const collaborationRuntime = getAgentCollaborationRuntime()
    const flushPendingSteers = async (): Promise<number> => {
      const pending = this.pendingSteers.splice(0)
      for (const input of pending) {
        await runtimeCoordinator!.recordUserContinuation(runtimeTurn!, input.text, input.attachments)
        callbacks.onSteerConsumed?.(input)
      }
      return pending.length
    }
    const flushAgentMailbox = async (): Promise<number> => {
      const messages = await collaborationRuntime.consumeForAgent(sessionId, '/root')
      for (const message of messages) {
        await runtimeCoordinator!.recordUserContinuation(runtimeTurn!, message)
      }
      return messages.length
    }
    let runtimeClosed = false
    let overflowRetried = false
    let allMessages: import('../../../shared/types/provider').ChatMessage[] = []
    const runtimeInstructions: string[] = [...(config.contextInstructions || [])]
    const reasoningBudgetTokens = config.thinking?.enabled === false
      ? 0
      : config.thinking
        ? resolveEffectiveReasoningBudgetTokens(
            config.thinking,
            config.model || '',
            config.baseUrl || '',
            config.apiFormat || 'openai'
          )
        : undefined
    let loopCount = 0
    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 5

    let filesModifiedInSession = false
    let lastVerificationResult: { success: boolean; command: string } | null = null
    let verificationRetryCount = 0
    const MAX_VERIFICATION_RETRIES = 3

    const configuredTools: ToolDefinition[] = config.tools || this.toolManager.getToolDefinitions()
    let availableTools: ToolDefinition[] = configuredTools

    log.info('[AgentRunner] run start', { sessionId, model: config.model, loopMode: 'terminal-state', msgCount: allMessages.length })

    try {
      const sessionStore = getSessionStore()
      const session = sessionStore.getAll().find((s: any) => s.id === sessionId)
      const restoredTools = session?.toolRuntime?.activatedDeferredTools?.[runtimeTurn!.contextScopeId]
      if (restoredTools?.length) {
        getToolExposureState().activate(`${sessionId}:${runtimeTurn!.contextScopeId}`, restoredTools)
      }
    } catch (e) {
      console.error('[AgentRunner] Failed to load active plan:', e)
    }

    let txId: string | null = null
    let transactionHandedOff = false
    let transactionSettled = false
    try {
      txId = await this.editTransactionService.beginTransaction(sessionId)
    } catch (err: any) {
      console.error('[AgentRunner] Failed to begin transaction:', err.message)
    }
    const rollbackUnhandedTransaction = async (): Promise<void> => {
      if (!txId || transactionHandedOff || transactionSettled) return
      transactionSettled = true
      try {
        await this.editTransactionService.rollback(txId)
      } catch (error) {
        log.error('[AgentRunner] failed to rollback an unhanded transaction', {
          sessionId,
          txId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    let currentState = AgentState.Running
    const contextBudgetService = new ContextBudgetService()
    const runtimeToolManager = typeof (this.toolManager as any).createCatalogSnapshot === 'function'
      ? this.toolManager
      : new ToolManager()
    const runtimeFlags = getToolRuntimeFeatureFlags()
    const toolExecutionPipeline = runtimeFlags.runtimeV2
      ? new ToolExecutionPipeline({
          schedulerMode: runtimeFlags.scheduler,
          resultStoreEnabled: runtimeFlags.resultStore
        })
      : new LegacyToolExecutionPipeline()
    const smartApprovalClient = new ChatSmartApprovalClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      apiFormat: config.apiFormat
    })
    const runtimeToolInvoker = createAgentRuntimeToolInvoker({
      config,
      callbacks,
      parentSignal: this.abortController?.signal,
      parentTransaction: txId ? { id: txId, service: this.editTransactionService } : undefined
    })

    try {
      while (!this.abortController?.signal.aborted) {
        loopCount++

        await flushPendingSteers()
        await flushAgentMailbox()

        log.info('[AgentRunner] loop start', { loopCount, msgCount: allMessages.length })

        const catalogSnapshot = runtimeToolManager.createCatalogSnapshot('main', config.workspaceRoot)
        const exposureScopeId = `${sessionId}:${runtimeTurn!.contextScopeId}`
        const exposureState = getToolExposureState()
        const configuredNames = new Set(configuredTools.map((tool) => tool.function.name))
        const deniedByConfiguration = new Set(catalogSnapshot.descriptors
          .map((descriptor) => descriptor.name)
          .filter((name) => !configuredNames.has(name)))
        if (!runtimeFlags.toolSearch) deniedByConfiguration.add('ToolSearch')
        const agentRecords = collaborationRuntime.list(sessionId)
        const activeAgentRecords = agentRecords.filter((agent) =>
          agent.status === 'queued' || agent.status === 'running'
        )
        const activatedDeferredTools = new Set(runtimeFlags.toolSearch
          ? exposureState.get(exposureScopeId)
          : catalogSnapshot.descriptors
              .filter((descriptor) => descriptor.availability.exposure === 'deferred')
              .map((descriptor) => descriptor.name))
        if (activeAgentRecords.length > 0) {
          activatedDeferredTools.add('wait_agent')
        } else {
          deniedByConfiguration.add('wait_agent')
          activatedDeferredTools.delete('wait_agent')
        }
        const agentRuntimeInstruction = [
          '<agent_runtime_state>',
          activeAgentRecords.length > 0
            ? `Active background Agents (${activeAgentRecords.length}): ${activeAgentRecords
                .map((agent) => `${agent.id} ${agent.path} [${agent.status}]`)
                .join('; ')}. wait_agent may only target these active Agents.`
            : 'Active background Agents: none. Do not call wait_agent; it is unavailable in this model turn.',
          agentRecords.length > 0
            ? `Known terminal/history Agents: ${agentRecords
                .filter((agent) => agent.status !== 'queued' && agent.status !== 'running')
                .slice(-20)
                .map((agent) => `${agent.id} ${agent.path} [${agent.status}]`)
                .join('; ') || 'none'}.`
            : 'No SubAgent has been started in this session.',
          '</agent_runtime_state>'
        ].join('\n')
        const exposurePlan = runtimeToolManager.createExposurePlan({
          catalog: catalogSnapshot,
          agentRole: 'main',
          workspaceRoot: config.workspaceRoot,
          deniedTools: deniedByConfiguration,
          activatedDeferredTools
        })
        availableTools = runtimeToolManager.getToolDefinitionsForExposure(exposurePlan)
        const built = await config.contextBuilder!.build({
          sessionId,
          contextScopeId: runtimeTurn!.contextScopeId,
          currentInputMessageId: runtimeTurn!.userMessageId,
          currentInput: runtimeTurn!.inputText,
          capabilities: config.contextCapabilities!,
          systemPrompt: config.systemPrompt!,
          toolSchemas: availableTools,
          instructions: [
            ...runtimeInstructions,
            agentRuntimeInstruction
          ],
          providerRequestProfile: {
            providerId: config.providerId,
            model: config.model,
            apiFormat: config.apiFormat,
            baseUrl: config.baseUrl,
            thinking: config.thinking,
            maxOutputTokens: config.contextCapabilities?.maxOutputTokens
          },
          reasoningBudgetTokens,
          workspaceRoot: config.workspaceRoot
        })
        allMessages = built.messages
        getReadFingerprintStore().replaceScopeDeliveries(
          sessionId,
          runtimeTurn!.contextScopeId,
          built.items.map((item) => item.message)
        )
        callbacks.onContextBudget?.(built.budget)

        let currentFullContent = ''
        let currentReasoningContent = ''
        let toolCallAssembler = new ToolCallAssembler(`call_${runtimeTurn!.turnId}_${loopCount}`)
        let thoughtSignatureForThisTurn: string | undefined = undefined

        let gotError = false
        let errorReported = false
        let providerErrorMessage = ''
        let currentStopReason: import('../../../shared/types/provider').AgentStopReason | undefined = undefined
        let currentUsage: ProviderTokenUsage | undefined
        let providerErrorCode: ChatProviderErrorCode | undefined

        log.info('[AgentRunner] calling streamChat', { loopCount, model: config.model })

        const imageAttachments = allMessages.flatMap((message) => message.attachments || [])
        const resolveImage = imageAttachments.length > 0 && config.prepareImages
          ? await config.prepareImages(imageAttachments)
          : undefined

        // Prompt 调试日志（CODEZ_LOG_PROMPT=1 时写入独立文件）
        logPrompt(`[AgentRunner] loop ${loopCount}`, allMessages.length, allMessages[0]?.content as string)

        await streamWithTimeoutRetry(
          (attemptCallbacks, attemptSignal) => this.chatService.streamChat(
            {
              baseUrl: config.baseUrl,
              apiKey: config.apiKey,
              apiFormat: config.apiFormat,
              model: config.model,
              messages: allMessages,
              tools: availableTools,
              thinking: config.thinking,
              maxOutputTokens: config.contextCapabilities?.maxOutputTokens,
              resolveImage
            },
            attemptCallbacks,
            attemptSignal
          ),
          {
            onChunk: (delta, reasoningDelta, toolCallsChunk, thoughtSignature) => {
              if (this.abortController?.signal.aborted) return

              if (thoughtSignature) {
                thoughtSignatureForThisTurn = thoughtSignature
              }

              if (delta) {
                currentFullContent += delta
                callbacks.onChunk(delta, '')
              }
              if (reasoningDelta) {
                callbacks.onChunk('', reasoningDelta)
                currentReasoningContent += reasoningDelta
              }

              if (toolCallsChunk) {
                for (const tc of toolCallsChunk) {
                  const signature = tc.thought_signature || thoughtSignature
                  toolCallAssembler.push({
                    provider: config.apiFormat === 'anthropic' ? 'anthropic' : config.apiFormat === 'gemini' ? 'gemini' : 'openai',
                    position: tc.index,
                    callId: tc.id,
                    nameDelta: tc.function?.name,
                    argumentsDelta: tc.function?.arguments,
                    thoughtSignature: signature
                  })
                  if (signature) thoughtSignatureForThisTurn = signature
                }
              }
            },
            onDone: (fullContent, stopReason) => {
              currentStopReason = stopReason
              log.info('[AgentRunner] streamChat done', { loopCount, stopReason, contentLen: fullContent.length })
            },
            onError: (err, code) => {
              gotError = true
              providerErrorCode = code
              providerErrorMessage = err
              log.error('[AgentRunner] streamChat error', { loopCount, error: err })
              if (code !== 'CONTEXT_OVERFLOW') {
                callbacks.onError(err, code)
                errorReported = true
              }
            },
            onUsage: (usage) => {
              currentUsage = mergeProviderUsage(currentUsage, usage)
            }
          },
          this.abortController!.signal,
          {
            firstByteTimeoutMs: 30_000,
            idleTimeoutMs: 120_000,
            maxRetries: 10,
            maxIdleRetries: 2,
            onFirstByteTimeout: (attempt) => log.error('[AgentRunner] stream first byte timeout', { loopCount, attempt }),
            onIdleTimeout: (attempt) => log.error('[AgentRunner] stream idle timeout', { loopCount, attempt }),
            onRetry: (attempt, reason, retryNumber) => {
              log.warn('[AgentRunner] retrying stream', { loopCount, attempt, reason, retryNumber })
              if (reason !== 'idle') return

              currentFullContent = ''
              currentReasoningContent = ''
              toolCallAssembler = new ToolCallAssembler(`call_${runtimeTurn!.turnId}_${loopCount}`)
              thoughtSignatureForThisTurn = undefined
              currentStopReason = undefined
              callbacks.onChunk(`\n\n[响应流长时间无新数据，正在自动重试（第 ${retryNumber} 次）...]\n\n`, '')
            }
          }
        )

        if (currentUsage?.inputTokens) {
          callbacks.onContextBudget?.(
            contextBudgetService.applyProviderUsage(built.budget, currentUsage)
          )
        }

        if (
          gotError && providerErrorCode === 'CONTEXT_OVERFLOW' &&
          !overflowRetried && config.compactionService
        ) {
          overflowRetried = true
          const compacted = await config.compactionService.compact({
            sessionId,
            contextScopeId: runtimeTurn!.contextScopeId,
            trigger: 'provider_overflow',
            capabilities: config.contextCapabilities!,
            systemPrompt: config.systemPrompt!,
            toolSchemas: availableTools,
            instructions: runtimeInstructions,
            workspaceRoot: config.workspaceRoot,
            reasoningBudgetTokens,
            providerId: config.providerId,
            model: config.model,
            requiredMessageId: runtimeTurn!.userMessageId
          })
          if (compacted.status === 'completed') {
            loopCount--
            continue
          }
          const compactFailure = [
            compacted.errorCode,
            compacted.message
          ].filter(Boolean).join(': ')
          callbacks.onError(
            `上下文压缩失败，无法从 Provider 上下文溢出中恢复${compactFailure ? `：${compactFailure}` : '。'}`,
            'CONTEXT_OVERFLOW'
          )
          errorReported = true
        }

        if (gotError && providerErrorCode === 'CONTEXT_OVERFLOW' && !errorReported) {
          callbacks.onError(providerErrorMessage || 'Provider context overflow', 'CONTEXT_OVERFLOW')
          errorReported = true
        }

        if (gotError || this.abortController?.signal.aborted) {
          if (!runtimeClosed) {
            await rollbackUnhandedTransaction()
            await runtimeCoordinator!.interruptTurn(
              runtimeTurn!,
              this.abortController?.signal.aborted ? 'User aborted the turn' : 'Provider request failed'
            )
            runtimeClosed = true
          }
          break
        }

        const finalSig = thoughtSignatureForThisTurn
        const normalizedToolCalls: NormalizedToolCall[] = toolCallAssembler.finalize().map((call) => ({
          ...call,
          thoughtSignature: call.thoughtSignature || finalSig || 'skip_thought_signature_validator'
        }))
        const toolCallsArray = normalizedToolCalls.map((call) => {
          const result: any = {
            id: call.callId,
            type: 'function',
            function: {
              name: call.name,
              arguments: call.rawArguments
            }
          }
          result.function.thought_signature = call.thoughtSignature
          result.thought_signature = call.thoughtSignature
          return result
        })

        const fallbackAskArgs = toolCallsArray.length === 0
          ? normalizeAskUserTextFallback(currentFullContent)
          : null
        if (fallbackAskArgs) {
          const fallbackId = `fallback_ask_${runtimeTurn!.turnId}_${loopCount}`
          toolCallsArray.push({
            id: fallbackId,
            type: 'function',
            function: {
              name: 'AskUserQuestion',
              arguments: fallbackAskArgs,
              thought_signature: 'skip_thought_signature_validator'
            },
            thought_signature: 'skip_thought_signature_validator'
          })
          currentFullContent = ''
          normalizedToolCalls.push({
            callId: fallbackId,
            position: normalizedToolCalls.length,
            name: 'AskUserQuestion',
            rawArguments: fallbackAskArgs,
            thoughtSignature: 'skip_thought_signature_validator'
          })
          log.warn('[AgentRunner] converted text clarification payload to AskUserQuestion', {
            loopCount,
            model: config.model
          })
        }

        await runtimeCoordinator!.recordAssistant(runtimeTurn!, {
          content: currentFullContent || '',
          toolCalls: toolCallsArray.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            thoughtSignature: toolCall.thought_signature
          })),
          usage: currentUsage,
          requestFingerprint: built.providerUsageRequestFingerprint
        })
        const batchId = toolCallsArray.length > 1
          ? `batch_${runtimeTurn!.turnId}_${loopCount}`
          : undefined
        const toolBatchMeta = batchId
          ? { batchId, batchIndex: 0, batchSize: toolCallsArray.length }
          : fallbackAskArgs
            ? { textAskUserFallback: true }
            : undefined

        toolCallsArray.forEach((toolCall, batchIndex) => {
          callbacks.onToolStart?.(
            toolCall.id,
            toolCall.function.name,
            toolCall.function.arguments,
            toolCall.thought_signature,
            batchId
              ? { ...toolBatchMeta!, batchIndex }
              : toolBatchMeta
          )
        })

        let repeatedFailureLimitReached = false

        if (toolCallsArray.length > 0) {
          let pipelineResults: ToolPipelineResult[]
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            repeatedFailureLimitReached = true
            const errMsg = [
              `提示：当前任务已连续失败 ${MAX_CONSECUTIVE_FAILURES} 次。`,
              '为防止无进展重试，本轮工具执行已暂停。',
              '请检查最近的工具错误、调整任务或补充必要信息后再继续。'
            ].join('\n')
            pipelineResults = normalizedToolCalls.map((call) => ({
              call,
              canonicalName: call.name,
              result: {
                status: 'denied',
                error: { code: 'TOOL_FAILURE_LIMIT', message: errMsg, recoverable: false },
                modelContent: `Error: ${errMsg}`
              }
            }))
          } else {
            pipelineResults = await toolExecutionPipeline.executeBatch(normalizedToolCalls, {
              catalog: catalogSnapshot,
              exposure: exposurePlan,
              workspaceRoot: config.workspaceRoot,
              sessionId,
              agentRole: 'main',
              journalIdentity: {
                sessionId,
                turnId: runtimeTurn!.turnId,
                contextScopeId: runtimeTurn!.contextScopeId,
                providerId: config.providerId,
                model: config.model,
                apiFormat: config.apiFormat,
                catalogSnapshotId: catalogSnapshot.id,
                exposurePlanId: exposurePlan.id,
                schemaFingerprint: exposurePlan.schemaFingerprint
              },
              authorize: async (prepared) => {
                if (runtimeFlags.effectPolicy === 'shadow') {
                  const shadow = await evaluatePermissionEffectPlanShadow(
                    prepared.handler.descriptor.name,
                    prepared.input,
                    config.workspaceRoot,
                    prepared.effects,
                    sessionId
                  )
                  log.info('[ToolRuntime] shadow effect decision', {
                    tool: prepared.handler.descriptor.name,
                    action: shadow.action,
                    ruleId: shadow.ruleId
                  })
                }
                const authorization = await authorizeToolCall(
                  prepared.handler.descriptor.name,
                  prepared.input,
                  config.workspaceRoot,
                  callbacks.onPermissionRequest,
                  smartApprovalClient,
                  sessionId,
                  runtimeFlags.effectPolicy === 'enforce' ? prepared.effects : undefined,
                  prepared.approvalPreference
                )
                return authorization.allowed
                  ? {
                      allowed: true,
                      requestId: authorization.requestId,
                      permissionRuleId: authorization.permissionRuleId,
                      permissionMode: authorization.permissionMode
                    }
                  : {
                      allowed: false,
                      requestId: authorization.requestId,
                      permissionRuleId: authorization.permissionRuleId,
                      permissionMode: authorization.permissionMode,
                      error: {
                        code: 'TOOL_DENIED',
                        message: authorization.error || 'Tool execution denied.',
                        recoverable: false
                      }
                    }
              },
              createToolContext: (call, requestId) => ({
                workspaceRoot: config.workspaceRoot,
                sessionId,
                contextScopeId: runtimeTurn?.contextScopeId,
                runtimeCoordinator,
                runtimeTurn,
                transactionId: txId || undefined,
                editTransactionService: this.editTransactionService,
                abortSignal: this.abortController?.signal,
                toolCallId: call.callId,
                permissionRequestId: requestId,
                runtimeToolInvoker,
                toolExposure: {
                  deferredTools: exposurePlan.deferredTools,
                  activate: (toolNames) => {
                    exposureState.activate(exposureScopeId, toolNames)
                    const sessionStore = getSessionStore()
                    const activated = [...exposureState.get(exposureScopeId)]
                    void sessionStore.addActivatedDeferredTools(
                      sessionId,
                      runtimeTurn!.contextScopeId,
                      activated
                    ).catch((error) => log.error('[AgentRunner] failed to persist tool exposure state', {
                      sessionId,
                      error: error instanceof Error ? error.message : String(error)
                    }))
                  }
                }
              })
            })
          }

          const toolResults = pipelineResults.map((item) => {
            const result = item.result
            const isSuccess = result.status === 'success'
            const content = result.status === 'success'
              ? JSON.stringify({ ok: true, data: result.modelContent })
              : JSON.stringify({ ok: false, error: result.error })
            const fileReferences = result.status === 'success' ? result.fileReferences : undefined
            log.info('[AgentRunner] tool end', {
              name: item.canonicalName,
              isError: !isSuccess,
              loopCount
            })
            return {
              role: 'tool' as const,
              tool_call_id: item.call.callId,
              name: item.canonicalName,
              content,
              _uiContent: result.uiContent,
              _fileReferences: fileReferences,
              _pipelineResult: item
            }
          })

          for (const toolResult of toolResults) {
            let status: 'success' | 'error' = 'error'
            try {
              status = JSON.parse(toolResult.content).ok === true ? 'success' : 'error'
            } catch {}
            await runtimeCoordinator!.recordToolResult(runtimeTurn!, {
              callId: toolResult.tool_call_id,
              name: toolResult.name,
              content: toolResult.content,
              status,
              fileReferences: (toolResult as any)._fileReferences
            })
            callbacks.onToolEnd?.(
              toolResult.tool_call_id,
              (toolResult as any)._uiContent || unwrapModelToolResultForUi(toolResult.content)
            )
          }

          const readFilePaths = pipelineResults.flatMap((item) =>
            item.canonicalName === 'Read' && item.result.status === 'success'
              ? (item.result.fileReferences || []).map(reference => reference.path)
              : [])
          const directoryInstructions = await RulesResolver.loadDirectoryRulesForFiles(
            config.workspaceRoot,
            readFilePaths,
            sessionId
          )
          if (directoryInstructions) runtimeInstructions.push(directoryInstructions)

          for (const tr of toolResults) {
            const item = tr._pipelineResult
            if (item.result.status === 'success') {
              if (['Edit', 'Write', 'NotebookEdit'].includes(tr.name)) {
                filesModifiedInSession = true
              } else if (tr.name === 'Bash' || tr.name === 'PowerShell') {
                let cmdData: any = item.result.data
                if (typeof cmdData === 'string') {
                  try { cmdData = JSON.parse(cmdData) } catch {}
                }
                const cmdStr = String(
                  item.input?.command || item.input?.commandLine || cmdData?.command || ''
                )
                if (/(test|typecheck|build|lint)/.test(cmdStr)) {
                  if (cmdData && typeof cmdData === 'object' && cmdData.status !== 'running') {
                    lastVerificationResult = {
                      success: cmdData.exitCode === 0 && !cmdData.timedOut,
                      command: cmdStr
                    }
                  }
                }
              }
            }
          }

          const hasSuccess = pipelineResults.some((item) => item.result.status === 'success')
          if (hasSuccess) {
            consecutiveFailures = 0
          } else if (!repeatedFailureLimitReached) {
            consecutiveFailures++
          }
        }

        const isVerificationFailure = filesModifiedInSession && lastVerificationResult && !lastVerificationResult.success;
        
        const lateContinuations = await flushPendingSteers() + await flushAgentMailbox()
        if (lateContinuations > 0) {
          currentState = AgentState.Running
          continue
        }

        const transitionEvent = resolveAgentTransition({
          toolCallCount: toolCallsArray.length,
          isVerificationFailure,
          verificationRetryCount,
          maxVerificationRetries: MAX_VERIFICATION_RETRIES,
          repeatedFailureLimitReached,
          stopReason: currentStopReason,
          assistantContent: currentFullContent
        });

        currentState = LoopStateMachine.next(currentState, transitionEvent);

        if (currentState === AgentState.Terminated) {
          this.acceptingSteers = false
          const finishReason = transitionEvent === TransitionEvent.Completed ? TerminationReason.Completed : TerminationReason.Failed;
          if (!gotError && callbacks.onDone) {
            if (!runtimeClosed) {
              await runtimeCoordinator!.completeTurn(runtimeTurn!, {
                stopReason: currentStopReason || 'unknown',
                usage: currentUsage
              })
              runtimeClosed = true
            }
            log.info('[AgentRunner] run complete', { sessionId, loops: loopCount, finalContentLen: currentFullContent.length, finishReason });
            transactionHandedOff = true
            callbacks.onDone(currentFullContent, currentStopReason, txId || undefined);
          }
          break;
        }

        if (currentState === AgentState.WaitingUser || currentState === AgentState.Suspended) {
           this.acceptingSteers = false
           if (!gotError && callbacks.onDone) {
             if (!runtimeClosed) {
               await runtimeCoordinator!.completeTurn(runtimeTurn!, {
                 stopReason: currentStopReason || 'unknown',
                 usage: currentUsage
               })
               runtimeClosed = true
             }
             log.info('[AgentRunner] run suspended/waiting', { sessionId, loops: loopCount, finalContentLen: currentFullContent.length, state: currentState });
             transactionHandedOff = true
             callbacks.onDone(currentFullContent, currentStopReason, txId || undefined);
           }
           break;
        }

        // --- Handle Running state transitions ---
        if (transitionEvent === TransitionEvent.ToolExecuted) {
          if (filesModifiedInSession && lastVerificationResult && lastVerificationResult.success) {
            verificationRetryCount = 0;
          }
          continue; // Loop continues naturally to process new messages (tool results)
        }

        if (transitionEvent === TransitionEvent.RetryRequested) {
          verificationRetryCount++;
          log.info('[AgentRunner] verification intercept', {
            command: lastVerificationResult!.command,
            retry: verificationRetryCount,
            max: MAX_VERIFICATION_RETRIES,
            loopCount
          });

          const retryMessage = `⚠️ [Verification Failed] The command (${lastVerificationResult!.command}) failed. Please fix the error and try again.`
          await runtimeCoordinator!.recordUserContinuation(runtimeTurn!, retryMessage)

          if (callbacks.onChunk) {
            callbacks.onChunk(`\n\n[系统拦截：验证失败，重试 ${verificationRetryCount}/${MAX_VERIFICATION_RETRIES}...]\n\n`, '');
          }
          continue;
        }

        if (!runtimeClosed) {
          await runtimeCoordinator!.interruptTurn(runtimeTurn!, 'Runner stopped without a terminal transition')
          runtimeClosed = true
        }
        break;
      }
      if (!runtimeClosed) {
        await rollbackUnhandedTransaction()
        await runtimeCoordinator!.interruptTurn(runtimeTurn!, 'Agent loop ended before completion')
        runtimeClosed = true
      }
    } catch (err) {
      await rollbackUnhandedTransaction()
      if (!runtimeClosed) {
        await runtimeCoordinator!.interruptTurn(runtimeTurn!, err instanceof Error ? err.message : String(err)).catch(() => undefined)
        runtimeClosed = true
      }
      throw err
    } finally {
      this.acceptingSteers = false
    }
  }

  steer(input: ChatSteerInput): boolean {
    if (!this.acceptingSteers || this.abortController?.signal.aborted) return false
    if (!input.text.trim() && !input.attachments?.length) return false
    this.pendingSteers.push({
      ...input,
      attachments: input.attachments?.map((attachment) => ({ ...attachment }))
    })
    return true
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort('The user stopped the parent Agent run.')
    }
    this.chatService.abort()
  }
}

export * from './types'
export * from './agentErrorHandler'
