import { ChatService, ChatRequestConfig, StreamCallbacks } from '../services/ChatService'
import { ToolManager } from '../tools/ToolManager'
import { EditTransactionService, getEditTransactionService } from '../services/EditTransactionService'
import { ContextManager } from './ContextManager'
import type { ChatMessage, ToolDefinition, ToolCall } from '../../shared/types/provider'

export interface AgentRunnerCallbacks extends StreamCallbacks {
  onToolStart?: (toolCallId: string, name: string, args: string, thoughtSignature?: string) => void
  onToolEnd?: (toolCallId: string, result: string) => void
}

export interface AgentRunConfig extends ChatRequestConfig {
  workspaceRoot: string
  tools?: ToolDefinition[]
  sessionId?: string
}

export class AgentRunner {
  private chatService: ChatService
  private toolManager: ToolManager
  private editTransactionService: EditTransactionService
  private abortController: AbortController | null = null

  constructor() {
    this.chatService = new ChatService()
    this.toolManager = new ToolManager()
    this.editTransactionService = getEditTransactionService()
  }

  async run(config: AgentRunConfig, callbacks: AgentRunnerCallbacks): Promise<void> {
    this.abortController = new AbortController()

    let allMessages = [...config.messages]
    let MAX_LOOPS = 30
    let loopCount = 0

    const availableTools = config.tools || this.toolManager.getToolDefinitions()

    // 开启修改事务
    const sessionId = config.sessionId || `session_${Date.now()}`
    let txId: string | null = null
    try {
      txId = await this.editTransactionService.beginTransaction(sessionId)
    } catch (err: any) {
      console.error('[AgentRunner] Failed to begin transaction:', err.message)
    }

    try {
      while (loopCount < MAX_LOOPS && !this.abortController?.signal.aborted) {
        loopCount++

        // 每轮循环开始前，对累积消息做智能裁剪
        allMessages = ContextManager.trimMessages(allMessages)

        let currentFullContent = ''
        let currentReasoningContent = ''
        let toolCallsAcc: Record<number, { id: string, type: 'function', function: { name: string, arguments: string }, thought_signature?: string }> = {}
        let thoughtSignatureForThisTurn: string | undefined = undefined
        
        let gotError = false

        await new Promise<void>((resolve) => {
          this.chatService.streamChat({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            apiFormat: config.apiFormat,
            model: config.model,
            messages: allMessages,
            tools: availableTools,
            thinking: config.thinking
          }, {
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

              // 拼接工具调用 chunk
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

                  // 实时推送当前流式累加结果给前端，允许前端变写变解析
                  if (acc.id) {
                    callbacks.onToolStart?.(acc.id, acc.function.name, acc.function.arguments, acc.thought_signature)
                  }
                }
              }
            },
            onDone: () => {
              resolve()
            },
            onError: (err) => {
              gotError = true
              callbacks.onError(err)
              resolve()
            }
          }, this.abortController!.signal)
        })

        if (gotError || this.abortController?.signal.aborted) {
          break
        }

        // 将本次助手的回复（哪怕是空的但有 tool_calls）存入历史
        const finalSig = thoughtSignatureForThisTurn
        const toolCallsArray = Object.keys(toolCallsAcc).map(k => {
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
            // Fallback for Gemini 400 error
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
            // Fallback for Gemini 400 error across different proxies (e.g. LiteLLM uses provider_specific_fields)
            thought_signature: finalSig || 'skip_thought_signature_validator',
            provider_specific_fields: {
              thought_signature: finalSig || 'skip_thought_signature_validator'
            }
          } as any)

          // 并发执行所有工具调用
          const toolResults = await Promise.all(toolCallsArray.map(async (tc) => {
            const toolCallId = tc.id
            const name = tc.function.name
            const args = tc.function.arguments

            // 判断是否已临近最大步数上限（倒数第二轮及之后）
            if (loopCount >= MAX_LOOPS - 1) {
              callbacks.onToolStart?.(toolCallId, name, args)
              
              const errMsg = [
                `提示：当前任务已连续执行了较多步骤（已达 ${MAX_LOOPS} 步的安全上限）。`,
                '为了保障运行安全并防止死循环，后续的工具执行已被自动挂起。',
                '请您放心，已完成的工作均已妥善保存。请在下方的回复中直接告诉用户：',
                '1. 目前已为您完成了哪些修改和成果；',
                '2. 还有哪些步骤因为达到步数限制而暂时挂起；',
                '3. 温馨提示用户：如果需要继续，可以直接点击右上角的“继续”按钮，或者在对话框中回复“继续”或“继续推进”。'
              ].join('\n')
              
              callbacks.onToolEnd?.(toolCallId, errMsg)
              
              return {
                role: 'tool' as const,
                tool_call_id: toolCallId,
                name: name,
                content: errMsg
              }
            }

            callbacks.onToolStart?.(toolCallId, name, args)

            const toolInstance = this.toolManager.getTool(name)
            let resultMessage = ''
            if (!toolInstance) {
              resultMessage = `Error: Tool '${name}' not found.`
            } else {
              try {
                resultMessage = await toolInstance.execute(args, {
                  workspaceRoot: config.workspaceRoot,
                  transactionId: txId || undefined,
                  editTransactionService: this.editTransactionService
                })
              } catch (err: any) {
                resultMessage = `Error: ${err.message}`
              }
            }

            callbacks.onToolEnd?.(toolCallId, resultMessage)

            // 转换为大模型约定的工具结果消息
            return {
              role: 'tool' as const,
              tool_call_id: toolCallId,
              name: name,
              content: resultMessage
            }
          }))

          // 把工具执行结果追加到消息中，继续下一个 loop 让大模型推理
          allMessages.push(...toolResults)

        } else {
          // 没有工具调用，当前内容是最终回答，正常输出并结束生成
          if (!gotError && callbacks.onDone) {
            callbacks.onDone(currentFullContent, txId || undefined)
          }
          break
        }
      }
    } catch (err) {
      // 异常退出：回滚事务
      if (txId) {
        try {
          await this.editTransactionService.rollback(txId)
        } catch {
          // 回滚本身失败不抛出
        }
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
