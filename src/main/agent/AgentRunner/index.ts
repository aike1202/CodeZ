import { ChatService } from '../../services/ChatService'
import { ToolManager } from '../../tools/ToolManager'
import { EditTransactionService, getEditTransactionService } from '../../services/EditTransactionService'
import { ContextManager } from '../ContextManager'
import { PermissionManager } from '../../services/PermissionManager'
import { interceptAskUser } from '../../tools/builtin/AskUserQuestionTool'
import { PlanStore } from '../../services/PlanStore'
import { SubAgentManager } from '../SubAgentManager'
import { PlanSubAgent } from '../definitions/PlanSubAgent'
import type { ToolDefinition } from '../../../shared/types/provider'

import type { AgentRunConfig, AgentRunnerCallbacks } from './types'
import { isToolErrorResult, buildToolError } from './agentErrorHandler'
import { handleEnterPlanMode } from './planRunnerHelper'
import { getSessionStore } from '../../ipc/session.handlers'
import { getSettingsService } from '../../ipc/settings.handlers'

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

    if (!SubAgentManager.getDefinition('Plan')) {
      SubAgentManager.register(PlanSubAgent)
    }
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

    const planStore = new PlanStore()
    let availableTools: ToolDefinition[] = config.tools || this.toolManager.getToolDefinitions()

    const sessionId = config.sessionId || `session_${Date.now()}`

    try {
      const sessionStore = getSessionStore()
      const session = sessionStore.getAll().find((s: any) => s.id === sessionId)
      let activePlan: any = null

      if (session && session.linkedPlanSlug) {
        activePlan = await planStore.getBySlug(config.workspaceRoot, session.linkedPlanSlug)
        if (activePlan && activePlan.status === 'suspended') {
          const { PlanService } = require('../../services/PlanService')
          activePlan = await PlanService.resume(config.workspaceRoot, activePlan.slug)
        }
      }

      if (activePlan) {
        if (!availableTools.find((t) => t.function.name === 'UpdatePlanStep')) {
          const stepTool = this.toolManager.getTool('UpdatePlanStep')
          if (stepTool) {
            availableTools = [
              ...availableTools,
              {
                type: 'function' as const,
                function: {
                  name: stepTool.name,
                  description: stepTool.description,
                  parameters: stepTool.parameters_schema
                }
              }
            ]
          }
        }

        const stepLines = activePlan.steps
          .map((s: any) => `- [${s.status}] ${s.id} ${s.title}`)
          .join('\n')
        const currentStep = activePlan.steps.find((s: any) => s.status === 'in_progress')
        const planMsg = [
          '<active_plan>',
          `Plan: ${activePlan.title} (slug: ${activePlan.slug})`,
          `Status: ${activePlan.status}`,
          'Steps:',
          stepLines,
          `Current step: ${currentStep ? `${currentStep.id} ${currentStep.title}` : 'none'}`,
          '</active_plan>'
        ].join('\n')

        allMessages = allMessages.filter(
          (m) =>
            !(
              m.role === 'system' &&
              typeof m.content === 'string' &&
              m.content.includes('<active_plan>')
            )
        )
        allMessages.push({ role: 'system', content: planMsg } as any)
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

    try {
      while (loopCount < MAX_LOOPS && !this.abortController?.signal.aborted) {
        loopCount++

        const trimResult = ContextManager.trimMessages(
          allMessages,
          config.contextWindowTokens || 32000
        )
        allMessages = trimResult.messages

        if (trimResult.willTrimSoon && !this.hasWarnedTrim) {
          this.hasWarnedTrim = true
          allMessages.push({
            role: 'system',
            content: `⚠️ 上下文容量预警：当前历史消息已达到容量上限的 65%，即将触发自动裁剪。\n为了防止丢失早期的任务目标和上下文，请**立即调用 update_resume_state 工具**把当前的任务进度、已完成和未完成的步骤进行总结存档！`
          } as any)
        } else if (trimResult.trimmed) {
          this.hasWarnedTrim = false
          allMessages.push({
            role: 'system',
            content: `⚠️ 上下文裁剪通知：刚才有 ${trimResult.trimmedCount} 条旧消息被移除。\n如果你的部分早期记忆变得模糊，请查阅或更新你的 resume_state。`
          } as any)
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
          allMessages.push({
            role: 'system',
            content: `⚠️ 警告：当前任务即将在 2 步后达到最大执行上限并挂起。框架已自动保存了一份进度快照。请务必在下一步调用 update_resume_state 补充更详细的任务状态（目标、已完成步骤、待办等），以确保恢复时不丢失关键信息。`
          } as any)
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

        await new Promise<void>((resolve) => {
          this.chatService.streamChat(
            {
              baseUrl: config.baseUrl,
              apiKey: config.apiKey,
              apiFormat: config.apiFormat,
              model: config.model,
              messages: allMessages,
              tools: availableTools,
              thinking: config.thinking
            },
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
                resolve()
              },
              onError: (err) => {
                gotError = true
                callbacks.onError(err)
                resolve()
              }
            },
            this.abortController!.signal
          ).catch((err) => {
            gotError = true
            callbacks.onError(err instanceof Error ? err.message : String(err))
            resolve()
          })
        })

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

              if (name === 'EnterPlanMode') {
                return await handleEnterPlanMode(
                  toolCallId,
                  allMessages,
                  config,
                  callbacks,
                  planStore,
                  this.toolManager,
                  availableTools
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
        } else {
          if (filesModifiedInSession && lastVerificationResult && !lastVerificationResult.success) {
            console.log(
              `[AgentRunner] Intercepted final response due to failed verification: ${lastVerificationResult.command}`
            )

            if (currentFullContent.trim()) {
              allMessages.push({
                role: 'assistant',
                content: currentFullContent
              } as any)
            }

            allMessages.push({
              role: 'system',
              content: `⚠️ 验证闭环拦截：你最后一次运行的验证命令 (${lastVerificationResult.command}) 未成功通过。作为负责任的 AI，你必须修复这些错误并重新验证，在验证通过之前绝对不能声称任务已完成。请继续使用相关工具（如 Read, Edit, Write, Bash 等）进行排查和修复。`
            } as any)

            if (callbacks.onChunk) {
              callbacks.onChunk(
                '\n\n[系统拦截：检测到验证失败，正在强制模型继续修复...]\n\n',
                ''
              )
            }
            continue
          }

          if (!gotError && callbacks.onDone) {
            callbacks.onDone(currentFullContent, currentStopReason, txId || undefined)
          }
          break
        }
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
