import { ChatService } from '../../services/ChatService'
import { ToolManager } from '../../tools/ToolManager'
import { EditTransactionService, getEditTransactionService } from '../../services/EditTransactionService'
import { ContextManager } from '../ContextManager'
import { PermissionManager } from '../../services/PermissionManager'
import { interceptAskUser } from '../../tools/builtin/AskUserQuestionTool'
import { TaskStore } from '../../services/TaskStore'
import { SubAgentManager } from '../SubAgentManager'
import type { ToolDefinition } from '../../../shared/types/provider'
import log from '../../logger'
import { logPrompt } from '../../services/PromptLogger'

import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import { isToolErrorResult, buildToolError } from './agentErrorHandler'
import { handleSubAgentRunnerSpawn } from './subAgentRunnerHelper'
import { handleDelegateTasks } from './delegateTasksHelper'
import { getSessionStore } from '../../ipc/session.handlers'
import { getSettingsService } from '../../ipc/settings.handlers'
import { LoopStateMachine, AgentState, TransitionEvent, TerminationReason } from './LoopStateMachine'
import { streamWithTimeoutRetry } from '../../services/chat/retry'

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
  private hasWarnedTrim: boolean = false

  constructor() {
    this.chatService = new ChatService()
    this.toolManager = new ToolManager()
    this.editTransactionService = getEditTransactionService()
  }

  async run(config: AgentRunConfig, callbacks: AgentRunnerCallbacks): Promise<void> {
    this.abortController = new AbortController()

    let allMessages = [...config.messages]
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

    const sessionId = config.sessionId || `session_${Date.now()}`

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

        allMessages = allMessages.filter(
          (m) =>
            !(
              m.role === 'system' &&
              typeof m.content === 'string' &&
              m.content.includes('<active_tasks>')
            )
        )
        allMessages.push({ role: 'system', content: taskMsg } as any)
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

    const resumeStateKey = ContextManager.createResumeStateKey(config.workspaceRoot, sessionId)

    try {
      const resumeState = await ContextManager.loadResumeState(resumeStateKey)
      if (resumeState && allMessages.length > 0 && allMessages[0].role === 'system') {
        const stateStr = `\n\n<resume_state>\nPrevious task state loaded:\n${JSON.stringify(resumeState, null, 2)}\n</resume_state>\n`
        allMessages[0] = {
          ...allMessages[0],
          content: allMessages[0].content + stateStr
        }
      }
    } catch (e) {}

    let consecutiveIdleTurns = 0
    let currentState = AgentState.Running

    try {
      while (loopCount < MAX_LOOPS && !this.abortController?.signal.aborted) {
        loopCount++

        log.info('[AgentRunner] loop start', { loopCount, msgCount: allMessages.length })

        const trimResult = ContextManager.trimMessages(
          allMessages,
          config.contextWindowTokens || 32000
        )
        allMessages = trimResult.messages

        // System prompt is always at index 0
        const systemPrompt = allMessages[0]

        if (trimResult.willTrimSoon && !this.hasWarnedTrim) {
          this.hasWarnedTrim = true
          systemPrompt.content += `\n\n⚠️ [SYSTEM NOTIFICATION]: 当前历史消息已达到容量上限的 65%，即将触发自动裁剪。为了防止丢失早期的任务目标和上下文，请**立即调用 update_resume_state 工具**把当前的任务进度、已完成和未完成的步骤进行总结存档！`
        } else if (trimResult.trimmed) {
          this.hasWarnedTrim = false
          systemPrompt.content += `\n\n⚠️ [SYSTEM NOTIFICATION]: 刚才有 ${trimResult.trimmedCount} 条旧消息被移除。如果你的部分早期记忆变得模糊，请查阅或更新你的 resume_state。`
        }

        if (loopCount === MAX_LOOPS - 2) {
          try {
            const { UpdateResumeStateTool } = await import('../../tools/builtin/UpdateResumeStateTool')
            const resumeTool = new UpdateResumeStateTool()
            await resumeTool.execute(
              JSON.stringify({
                currentGoalId: 'auto-save',
                currentPhase: 'auto-save-before-limit',
                currentStep: `Loop ${loopCount}/${MAX_LOOPS}`,
                nextAction: 'User needs to continue the task'
              }),
              { workspaceRoot: config.workspaceRoot, sessionId, resumeStateKey }
            )
            console.log('[AgentRunner] Auto-saved resume state before step limit.')
          } catch (e: any) {
            console.error('[AgentRunner] Auto-save resume state failed:', e.message)
          }
          systemPrompt.content += `\n\n⚠️ [SYSTEM WARNING]: 当前任务即将在 2 步后达到最大执行上限并挂起。框架已自动保存了一份进度快照。请务必在下一步调用 update_resume_state 补充更详细的任务状态以确保恢复时不丢失关键信息。`
        }

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
        let currentStopReason: import('../../../shared/types/provider').AgentStopReason | undefined = undefined

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

                  if (acc.id) {
                    callbacks.onToolStart?.(
                      acc.id,
                      acc.function.name,
                      acc.function.arguments,
                      acc.thought_signature
                    )
                  }
                }
              }
            },
            onDone: (fullContent, stopReason) => {
              currentStopReason = stopReason
              log.info('[AgentRunner] streamChat done', { loopCount, stopReason, contentLen: fullContent.length })
            },
            onError: (err) => {
              gotError = true
              log.error('[AgentRunner] streamChat error', { loopCount, error: err })
              callbacks.onError(err)
            }
          },
          this.abortController!.signal,
          {
            firstByteTimeoutMs: 30_000,
            idleTimeoutMs: 60_000,
            maxRetries: 2,
            retryDelayMs: 1_000,
            onFirstByteTimeout: (attempt) => log.error('[AgentRunner] stream first byte timeout', { loopCount, attempt }),
            onIdleTimeout: (attempt) => log.error('[AgentRunner] stream idle timeout', { loopCount, attempt }),
            onRetry: (attempt) => log.warn('[AgentRunner] retrying stream after first byte timeout', { loopCount, attempt, nextAttempt: attempt + 1 })
          }
        )

        if (gotError || this.abortController?.signal.aborted) {
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

        if (toolCallsArray.length > 0) {
          allMessages.push({
            role: 'assistant',
            content: currentFullContent || '',
            tool_calls: toolCallsArray,
            thought_signature: finalSig || 'skip_thought_signature_validator',
            provider_specific_fields: {
              thought_signature: finalSig || 'skip_thought_signature_validator'
            }
          } as any)

          const toolResults = await Promise.all(
            toolCallsArray.map(async (tc) => {
              const toolCallId = tc.id
              const name = tc.function.name
              const args = tc.function.arguments

              if (loopCount >= MAX_LOOPS - 1 || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                callbacks.onToolStart?.(toolCallId, name, args)

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

                callbacks.onToolEnd?.(toolCallId, errMsg)

                return {
                  role: 'tool' as const,
                  tool_call_id: toolCallId,
                  name: name,
                  content: JSON.stringify({ ok: false, error: errMsg })
                }
              }

              callbacks.onToolStart?.(toolCallId, name, args)

              log.info('[AgentRunner] tool start', { name, loopCount })

              if (name === 'SubAgentRunner') {
                return await handleSubAgentRunnerSpawn(
                  toolCallId,
                  args,
                  config,
                  callbacks
                )
              } else if (name === 'DelegateTasks') {
                return await handleDelegateTasks(
                  toolCallId,
                  args,
                  config,
                  callbacks
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
                  let parsedArgs = {}
                  try {
                    parsedArgs = JSON.parse(args)
                  } catch {}

                  const pm = PermissionManager.getInstance()
                  const permReq = pm.createPermissionRequest(name, parsedArgs)
                  const settingsService = getSettingsService()
                  const workspaceMode = settingsService.getSettings().workspaceMode || 'auto-approve-safe'
                  const permResult = pm.checkToolPermission(
                    name,
                    parsedArgs,
                    config.workspaceRoot,
                    workspaceMode
                  )

                  if (permResult === 'deny') {
                    resultMessage = `Error: Tool execution denied by security policy.`
                    isError = true
                  } else if (permResult === 'ask') {
                    if (callbacks.onPermissionRequest) {
                      const approved = await callbacks.onPermissionRequest(permReq)
                      if (!approved) {
                        resultMessage = `Error: User denied permission for this operation.`
                        isError = true
                      }
                    } else {
                      resultMessage = `Error: Tool execution denied. No approval handler registered.`
                      isError = true
                    }
                  }

                  if (!resultMessage) {
                    const askIntercept = await interceptAskUser(
                      name,
                      parsedArgs,
                      permReq.id,
                      callbacks.onAskUserRequest || null
                    )
                    if (askIntercept.handled) {
                      resultMessage = askIntercept.result || ''
                      if (askIntercept.isError) isError = true
                    }
                  }

                  if (!resultMessage) {
                    resultMessage = await toolInstance.execute(args, {
                      workspaceRoot: config.workspaceRoot,
                      sessionId,
                      resumeStateKey,
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

              callbacks.onToolEnd?.(toolCallId, resultMessage)

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

          allMessages.push(...toolResults)

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
            log.info('[AgentRunner] run complete', { sessionId, loops: loopCount, finalContentLen: currentFullContent.length, finishReason });
            callbacks.onDone(currentFullContent, currentStopReason, txId || undefined);
          }
          break;
        }

        if (currentState === AgentState.WaitingUser || currentState === AgentState.Suspended) {
           if (!gotError && callbacks.onDone) {
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

          allMessages.push({ role: 'assistant', content: currentFullContent.trim() ? currentFullContent : '(Acknowledged)' } as any);

          allMessages.push({
            role: 'user',
            content: `⚠️ [Verification Failed] The command (${lastVerificationResult!.command}) failed. Please fix the error and try again.`
          } as any);

          if (callbacks.onChunk) {
            callbacks.onChunk(`\n\n[系统拦截：验证失败，重试 ${verificationRetryCount}/${MAX_VERIFICATION_RETRIES}...]\n\n`, '');
          }
          continue;
        }

        break;
      }
    } catch (err) {
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
