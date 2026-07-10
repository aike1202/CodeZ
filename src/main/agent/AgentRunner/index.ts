import { ChatService } from '../../services/ChatService'
import { ToolManager } from '../../tools/ToolManager'
import { EditTransactionService, getEditTransactionService } from '../../services/EditTransactionService'
import { PermissionManager } from '../../services/PermissionManager'
import { interceptAskUser } from '../../tools/builtin/AskUserQuestionTool'
import { TaskStore } from '../../services/TaskStore'
import { SubAgentManager } from '../SubAgentManager'
import type { ChatProviderErrorCode, ProviderTokenUsage, ToolDefinition } from '../../../shared/types/provider'
import log from '../../logger'
import { logPrompt } from '../../services/PromptLogger'

import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import { isToolErrorResult, buildToolError } from './agentErrorHandler'
import { handleSubAgentRunnerSpawn } from './subAgentRunnerHelper'
import { handleDelegateTasks } from './delegateTasksHelper'
import { getSessionStore } from '../../ipc/session.handlers'
import { LoopStateMachine, AgentState, TransitionEvent, TerminationReason } from './LoopStateMachine'
import { streamWithTimeoutRetry } from '../../services/chat/retry'
import { getWorkspacePermissionStore } from '../../services/permission/workspacePermissionStore'
import type { PermissionApprovalResponse } from '../../../shared/types/permission'
import type { SmartApprovalClient } from '../../services/permission/SmartApprovalService'
import { ChatSmartApprovalClient } from '../../services/permission/ChatSmartApprovalClient'

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

export interface ToolAuthorization {
  allowed: boolean
  requestId: string
  error?: string
}

export async function authorizeToolCall(
  toolName: string,
  parsedArgs: unknown,
  workspaceRoot: string,
  onPermissionRequest?: AgentRunnerCallbacks['onPermissionRequest'],
  smartApprovalClient?: SmartApprovalClient | null
): Promise<ToolAuthorization> {
  const permissionManager = PermissionManager.getInstance()
  const context = {
    workspaceRoot,
    cwd: workspaceRoot,
    platform: process.platform,
    shellKind: toolName === 'PowerShell' ? 'powershell' as const : toolName === 'Bash' ? 'bash' as const : undefined,
    mode: await getWorkspacePermissionStore().getMode(workspaceRoot),
    smartApprovalClient
  }
  const decision = await permissionManager.evaluateToolCall(toolName, parsedArgs, context)
  await permissionManager.audit(toolName, decision, context)
  const request = permissionManager.createPermissionRequest(toolName, parsedArgs, context, decision)

  if (decision.action === 'allow') {
    return await permissionManager.revalidate(decision)
      ? { allowed: true, requestId: request.id }
      : { allowed: false, requestId: request.id, error: 'Error: Permission inputs changed before execution.' }
  }
  if (decision.action === 'deny') {
    return {
      allowed: false,
      requestId: request.id,
      error: 'Error: Tool execution denied by security policy.'
    }
  }
  if (!onPermissionRequest) {
    return {
      allowed: false,
      requestId: request.id,
      error: 'Error: Tool execution denied. No approval handler registered.'
    }
  }

  try {
    const rawResponse = await onPermissionRequest(request)
    const response: PermissionApprovalResponse = typeof rawResponse === 'boolean'
      ? { approved: rawResponse, scope: 'once' }
      : rawResponse
    const valid = response.approved && await permissionManager.revalidate(decision)
    if (valid) await permissionManager.rememberApproval(request, response, context)
    await permissionManager.audit(toolName, decision, context, response)
    return valid
      ? { allowed: true, requestId: request.id }
      : {
          allowed: false,
          requestId: request.id,
          error: response.approved
            ? 'Error: Permission inputs changed before execution.'
            : 'Error: User denied permission for this operation.'
        }
  } catch (error: any) {
    return {
      allowed: false,
      requestId: request.id,
      error: `Error: Permission approval failed: ${error?.message || String(error)}`
    }
  }
}

export function resolveAgentTransition(input: {
  toolCallCount: number
  isVerificationFailure: boolean | null
  verificationRetryCount: number
  maxVerificationRetries: number
  consecutiveIdleTurns: number
  stopReason?: import('../../../shared/types/provider').AgentStopReason
  hasPendingTasks?: boolean
  assistantContent?: string
}): TransitionEvent {
  if (input.toolCallCount > 0) {
    return TransitionEvent.ToolExecuted
  }

  if (input.isVerificationFailure && input.verificationRetryCount < input.maxVerificationRetries) {
    return TransitionEvent.RetryRequested
  }

  if (input.consecutiveIdleTurns >= 3) {
    return TransitionEvent.MaxIdleReached
  }

  return TransitionEvent.Completed
}

export class AgentRunner {
  private chatService: ChatService
  private toolManager: ToolManager
  private editTransactionService: EditTransactionService
  private abortController: AbortController | null = null

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

    if (!(
      config.runtimeTurn && config.runtimeCoordinator && config.contextBuilder &&
      config.contextCapabilities && config.systemPrompt
    )) {
      throw new Error('AgentRunner requires the canonical model ledger runtime')
    }
    const runtimeTurn = config.runtimeTurn
    const runtimeCoordinator = config.runtimeCoordinator
    let runtimeClosed = false
    let overflowRetried = false
    let allMessages: import('../../../shared/types/provider').ChatMessage[] = []
    const runtimeInstructions: string[] = [...(config.contextInstructions || [])]
    const MAX_LOOPS = 30
    let loopCount = 0
    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 5

    let filesModifiedInSession = false
    let lastVerificationResult: { success: boolean; command: string } | null = null
    let verificationRetryCount = 0
    const MAX_VERIFICATION_RETRIES = 3

    const taskStore = TaskStore.getInstance()
    let availableTools: ToolDefinition[] = config.tools || this.toolManager.getToolDefinitions()

    const sessionId = runtimeTurn?.sessionId || config.sessionId || `session_${Date.now()}`

    log.info('[AgentRunner] run start', { sessionId, model: config.model, loopMax: MAX_LOOPS, msgCount: allMessages.length })

    try {
      const sessionStore = getSessionStore()
      const session = sessionStore.getAll().find((s: any) => s.id === sessionId)

      // ─── 恢复 Task 状态到会话内存 ──────────────────
      if (session && session.tasks && session.tasks.length > 0) {
        if (taskStore.list(sessionId).length === 0) {
          taskStore.restore(sessionId, session.tasks)
        }
      }

      // ─── 注入 active_tasks ─────────────────────────
      const activeTasks = taskStore.list(sessionId)
      if (activeTasks.length > 0) {
        const taskLines = activeTasks
          .map((t: any) => `- [${t.status}] ${t.id} ${t.subject}`)
          .join('\n')
        const inProgress = activeTasks.find((t: any) => t.status === 'in_progress')
        const group = activeTasks.find((t: any) => t.groupTitle || t.groupId || t.requiresApproval || t.approvalStatus)
        const taskMsg = [
          '<active_tasks>',
          `Total: ${activeTasks.length} tasks | Completed: ${activeTasks.filter((t: any) => t.status === 'completed').length}`,
          group ? `TaskGroup: ${group.groupTitle || group.groupId || 'untitled'} | Risk: ${group.riskLevel || 'unspecified'} | Approval: ${group.approvalStatus || (group.requiresApproval ? 'pending' : 'not_required')}` : 'TaskGroup: none',
          inProgress ? `Current: ${inProgress.id} ${inProgress.subject}` : 'No task in progress',
          'Tasks:',
          taskLines,
          '</active_tasks>'
        ].join('\n')

        runtimeInstructions.push(taskMsg)
      }
    } catch (e) {
      console.error('[AgentRunner] Failed to load active plan:', e)
    }

    let txId: string | null = null
    try {
      txId = await this.editTransactionService.beginTransaction(sessionId)
    } catch (err: any) {
      console.error('[AgentRunner] Failed to begin transaction:', err.message)
    }

    let consecutiveIdleTurns = 0
    let currentState = AgentState.Running

    try {
      while (loopCount < MAX_LOOPS && !this.abortController?.signal.aborted) {
        loopCount++

        log.info('[AgentRunner] loop start', { loopCount, msgCount: allMessages.length })

        const built = await config.contextBuilder!.build({
          sessionId,
          contextScopeId: runtimeTurn!.contextScopeId,
          currentInputMessageId: runtimeTurn!.userMessageId,
          currentInput: runtimeTurn!.inputText,
          capabilities: config.contextCapabilities!,
          systemPrompt: config.systemPrompt!,
          toolSchemas: availableTools,
          instructions: runtimeInstructions,
          reasoningBudgetTokens: config.thinking?.budgetTokens
        })
        allMessages = built.messages
        callbacks.onContextBudget?.(built.budget)

        let currentFullContent = ''
        let currentReasoningContent = ''
        let toolCallsAcc: Record<
          number,
          {
            id: string
            type: 'function'
            function: { name: string; arguments: string }
            thought_signature?: string
          }
        > = {}
        let thoughtSignatureForThisTurn: string | undefined = undefined

        let gotError = false
        let errorReported = false
        let providerErrorMessage = ''
        let currentStopReason: import('../../../shared/types/provider').AgentStopReason | undefined = undefined
        let currentUsage: ProviderTokenUsage | undefined
        let providerErrorCode: ChatProviderErrorCode | undefined

        log.info('[AgentRunner] calling streamChat', { loopCount, model: config.model })

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
              thinking: config.thinking
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
                  const index = tc.index
                  if (!toolCallsAcc[index]) {
                    toolCallsAcc[index] = {
                      id: tc.id || '',
                      type: 'function',
                      function: { name: tc.function?.name || '', arguments: '' }
                    }
                  }
                  const acc = toolCallsAcc[index]
                  if (tc.id) acc.id = tc.id
                  if (tc.function?.name) acc.function.name = tc.function.name
                  if (tc.function?.arguments) acc.function.arguments += tc.function.arguments

                  if (tc.thought_signature) {
                    acc.thought_signature = tc.thought_signature
                    thoughtSignatureForThisTurn = tc.thought_signature
                  } else if (thoughtSignature) {
                    acc.thought_signature = thoughtSignature
                  }

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
              currentUsage = {
                inputTokens: Math.max(currentUsage?.inputTokens || 0, usage.inputTokens),
                outputTokens: Math.max(currentUsage?.outputTokens || 0, usage.outputTokens),
                reasoningTokens: Math.max(currentUsage?.reasoningTokens || 0, usage.reasoningTokens || 0),
                totalTokens: Math.max(currentUsage?.totalTokens || 0, usage.totalTokens || 0)
              }
            }
          },
          this.abortController!.signal,
          {
            firstByteTimeoutMs: 30_000,
            idleTimeoutMs: 60_000,
            maxRetries: 10,
            onFirstByteTimeout: (attempt) => log.error('[AgentRunner] stream first byte timeout', { loopCount, attempt }),
            onIdleTimeout: (attempt) => log.error('[AgentRunner] stream idle timeout', { loopCount, attempt }),
            onRetry: (attempt) => log.warn('[AgentRunner] retrying stream after first byte timeout', { loopCount, attempt, nextAttempt: attempt + 1 })
          }
        )

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
            instructions: runtimeInstructions
          })
          if (compacted.status === 'completed') {
            loopCount--
            continue
          }
          callbacks.onError('上下文压缩失败，无法从 Provider 上下文溢出中恢复。', 'CONTEXT_OVERFLOW')
          errorReported = true
        }

        if (gotError && providerErrorCode === 'CONTEXT_OVERFLOW' && !errorReported) {
          callbacks.onError(providerErrorMessage || 'Provider context overflow', 'CONTEXT_OVERFLOW')
          errorReported = true
        }

        if (gotError || this.abortController?.signal.aborted) {
          if (!runtimeClosed) {
            await runtimeCoordinator!.interruptTurn(
              runtimeTurn!,
              this.abortController?.signal.aborted ? 'User aborted the turn' : 'Provider request failed'
            )
            runtimeClosed = true
          }
          break
        }

        const finalSig = thoughtSignatureForThisTurn
        const toolCallsArray = Object.keys(toolCallsAcc).map((k) => {
          const tc = (toolCallsAcc as any)[k]
          const sig = tc.thought_signature || finalSig
          const result: any = {
            id: tc.id,
            type: tc.type,
            function: {
              ...tc.function
            }
          }
          if (sig) {
            result.function.thought_signature = sig
            result.thought_signature = sig
          } else {
            result.function.thought_signature = 'skip_thought_signature_validator'
            result.thought_signature = 'skip_thought_signature_validator'
          }
          return result
        })

        await runtimeCoordinator!.recordAssistant(runtimeTurn!, {
          content: currentFullContent || '',
          toolCalls: toolCallsArray.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            thoughtSignature: toolCall.thought_signature
          })),
          usage: currentUsage
        })
        for (const toolCall of toolCallsArray) {
          callbacks.onToolStart?.(
            toolCall.id,
            toolCall.function.name,
            toolCall.function.arguments,
            toolCall.thought_signature
          )
        }

        if (toolCallsArray.length > 0) {
          const toolCallbacks: AgentRunnerCallbacks = { ...callbacks, onToolEnd: undefined }

          const toolResults = await Promise.all(
            toolCallsArray.map(async (tc) => {
              const toolCallId = tc.id
              const name = tc.function.name
              const args = tc.function.arguments

              if (loopCount >= MAX_LOOPS - 1 || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                const reason =
                  loopCount >= MAX_LOOPS - 1
                    ? `已达 ${MAX_LOOPS} 步的安全上限`
                    : `已连续失败 ${MAX_CONSECUTIVE_FAILURES} 次`

                const errMsg = [
                  `提示：当前任务${reason}。`,
                  '为了保障运行安全并防止死循环，后续的工具执行已被自动挂起。',
                  '请您放心，已完成的工作均已妥善保存。请在下方的回复中直接告诉用户：',
                  '1. 目前已为您完成了哪些修改和成果；',
                  '2. 还有哪些步骤因为达到限制而暂时挂起；',
                  '3. 温馨提示用户：如果需要继续，可以直接点击右上角的“继续”按钮，或者在对话框中回复“继续”或“继续推进”。'
                ].join('\n')

                return {
                  role: 'tool' as const,
                  tool_call_id: toolCallId,
                  name: name,
                  content: JSON.stringify({ ok: false, error: errMsg })
                }
              }

              log.info('[AgentRunner] tool start', { name, loopCount })

              let parsedArgs = {}
              try {
                parsedArgs = JSON.parse(args)
              } catch {}

              const authorization = await authorizeToolCall(
                name,
                parsedArgs,
                config.workspaceRoot,
                callbacks.onPermissionRequest,
                new ChatSmartApprovalClient({
                  baseUrl: config.baseUrl,
                  apiKey: config.apiKey,
                  model: config.model,
                  apiFormat: config.apiFormat
                })
              )

              if (!authorization.allowed) {
                const resultMessage = authorization.error || 'Error: Tool execution denied.'
                log.info('[AgentRunner] tool end', { name, isError: true, loopCount })
                return {
                  role: 'tool' as const,
                  tool_call_id: toolCallId,
                  name,
                  content: JSON.stringify({
                    ok: false,
                    error: buildToolError(resultMessage)
                  }),
                  _rawArgs: args
                }
              }

              if (name === 'SubAgentRunner') {
                return await handleSubAgentRunnerSpawn(
                  toolCallId,
                  args,
                  config,
                  toolCallbacks
                )
              } else if (name === 'DelegateTasks') {
                return await handleDelegateTasks(
                  toolCallId,
                  args,
                  config,
                  toolCallbacks
                )
              }

              const toolInstance = this.toolManager.getTool(name)
              let resultMessage = ''
              let isError = false
              if (!toolInstance) {
                resultMessage = `Error: Tool '${name}' not found.`
                isError = true
              } else {
                try {
                  const askIntercept = await interceptAskUser(
                    name,
                    parsedArgs,
                    authorization.requestId,
                    callbacks.onAskUserRequest || null
                  )
                  if (askIntercept.handled) {
                    resultMessage = askIntercept.result || ''
                    if (askIntercept.isError) isError = true
                  }

                  if (!resultMessage) {
                    resultMessage = await toolInstance.execute(args, {
                      workspaceRoot: config.workspaceRoot,
                      sessionId,
                      runtimeCoordinator,
                      runtimeTurn,
                      transactionId: txId || undefined,
                      editTransactionService: this.editTransactionService
                    })
                    if (isToolErrorResult(resultMessage)) {
                      isError = true
                    }
                  }
                } catch (err: any) {
                  resultMessage = `Error: ${err.message}`
                  isError = true
                }
              }

              log.info('[AgentRunner] tool end', { name, isError, loopCount })

              const toolResultWrapper = isError
                ? {
                    ok: false,
                    error: buildToolError(resultMessage)
                  }
                : {
                    ok: true,
                    data: resultMessage
                  }

              return {
                role: 'tool' as const,
                tool_call_id: toolCallId,
                name: name,
                content: JSON.stringify(toolResultWrapper),
                _rawArgs: args
              }
            })
          )

          for (const toolResult of toolResults) {
            let status: 'success' | 'error' = 'error'
            try {
              status = JSON.parse(toolResult.content).ok === true ? 'success' : 'error'
            } catch {}
            await runtimeCoordinator!.recordToolResult(runtimeTurn!, {
              callId: toolResult.tool_call_id,
              name: toolResult.name,
              content: toolResult.content,
              status
            })
            callbacks.onToolEnd?.(
              toolResult.tool_call_id,
              unwrapModelToolResultForUi(toolResult.content)
            )
          }

          for (const tr of toolResults) {
            try {
              const parsed = JSON.parse(tr.content)
              if (parsed.ok) {
                if (['Edit', 'Write'].includes(tr.name)) {
                  filesModifiedInSession = true
                } else if (tr.name === 'Bash' || tr.name === 'PowerShell') {
                  const cmdArgs = JSON.parse((tr as any)._rawArgs || '{}')
                  const cmdStr = cmdArgs.command || cmdArgs.commandLine || ''
                  if (/(test|typecheck|build|lint)/.test(cmdStr)) {
                    let cmdData = parsed.data
                    if (typeof cmdData === 'string') {
                      try {
                        cmdData = JSON.parse(cmdData)
                      } catch (e) {}
                    }
                    if (cmdData && typeof cmdData === 'object') {
                      lastVerificationResult = {
                        success: cmdData.exitCode === 0 && !cmdData.timedOut,
                        command: cmdStr
                      }
                    }
                  }
                }
              }
            } catch (e) {}

            delete (tr as any)._rawArgs
          }

          const hasSuccess = toolResults.some((tr) => {
            try {
              return JSON.parse(tr.content).ok === true
            } catch {
              return false
            }
          })
          if (!hasSuccess) {
            consecutiveFailures++
          } else {
            consecutiveFailures = 0
          }
        }

        const taskStore = TaskStore.getInstance();
        const hasPendingTasks = taskStore.list(sessionId).some(t => t.status === 'pending' || t.status === 'in_progress');

        const isVerificationFailure = filesModifiedInSession && lastVerificationResult && !lastVerificationResult.success;
        
        const transitionEvent = resolveAgentTransition({
          toolCallCount: toolCallsArray.length,
          isVerificationFailure,
          verificationRetryCount,
          maxVerificationRetries: MAX_VERIFICATION_RETRIES,
          consecutiveIdleTurns,
          stopReason: currentStopReason
        });

        currentState = LoopStateMachine.next(currentState, transitionEvent);

        if (currentState === AgentState.Terminated) {
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
            callbacks.onDone(currentFullContent, currentStopReason, txId || undefined);
          }
          break;
        }

        if (currentState === AgentState.WaitingUser || currentState === AgentState.Suspended) {
           if (!gotError && callbacks.onDone) {
             if (!runtimeClosed) {
               await runtimeCoordinator!.completeTurn(runtimeTurn!, {
                 stopReason: currentStopReason || 'unknown',
                 usage: currentUsage
               })
               runtimeClosed = true
             }
             log.info('[AgentRunner] run suspended/waiting', { sessionId, loops: loopCount, finalContentLen: currentFullContent.length, state: currentState });
             callbacks.onDone(currentFullContent, currentStopReason, txId || undefined);
           }
           break;
        }

        // --- Handle Running state transitions ---
        if (transitionEvent === TransitionEvent.ToolExecuted) {
          consecutiveIdleTurns = 0;
          if (filesModifiedInSession && lastVerificationResult && lastVerificationResult.success) {
            verificationRetryCount = 0;
          }
          continue; // Loop continues naturally to process new messages (tool results)
        }

        if (transitionEvent === TransitionEvent.RetryRequested) {
          consecutiveIdleTurns = 0;
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
        await runtimeCoordinator!.interruptTurn(runtimeTurn!, 'Agent loop ended before completion')
        runtimeClosed = true
      }
    } catch (err) {
      if (!runtimeClosed) {
        await runtimeCoordinator!.interruptTurn(runtimeTurn!, err instanceof Error ? err.message : String(err)).catch(() => undefined)
        runtimeClosed = true
      }
      if (txId) {
        try {
          await this.editTransactionService.rollback(txId)
        } catch {}
      }
      throw err
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort()
    }
    this.chatService.abort()
  }
}

export * from './types'
export * from './agentErrorHandler'
