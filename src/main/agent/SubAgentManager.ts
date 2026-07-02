import { ChatService } from '../services/ChatService'
import { ToolManager } from '../tools/ToolManager'
import { ContextManager } from './ContextManager'
import type { ChatMessage, ToolDefinition } from '../../shared/types/provider'
import type { StreamCallbacks } from '../services/ChatService'
import type { AgentRunnerCallbacks } from './AgentRunner'

// ─── SubAgent 定义接口 ──────────────────────────────────────

export interface SubAgentContext {
  workspaceRoot: string
  sessionId: string
  parentPrompt: string
  parentMessages?: ChatMessage[]
  modelOverride?: string
  /** 主 Agent 的 API 配置（baseUrl / apiKey / model 等） */
  apiConfig: {
    baseUrl: string
    apiKey: string
    apiFormat: string
    model: string
    thinking?: boolean
  }
}

export interface SubAgentResult {
  type: string
  output: string
  toolCallCount: number
  planSlug?: string
}

export interface SubAgentDefinition {
  type: string
  description: string
  systemPromptBuilder: (ctx: SubAgentContext) => string
  getTools(toolManager: ToolManager): ToolDefinition[]
  maxLoops: number
  defaultModel?: string
  isolation?: 'none' | 'worktree'
  canRunInBackground?: boolean
  onBeforeSpawn?: (ctx: SubAgentContext) => Promise<void>
  onAfterComplete?: (ctx: SubAgentContext, result: SubAgentResult) => Promise<void>
}

export interface SubAgentHandle {
  id: string
  type: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  result?: SubAgentResult
  cancel(): void
}

// ─── SubAgentManager ────────────────────────────────────────

export class SubAgentManager {
  private static definitions = new Map<string, SubAgentDefinition>()
  private static activeHandles = new Map<string, SubAgentHandle>()

  static register(definition: SubAgentDefinition): void {
    this.definitions.set(definition.type, definition)
  }

  static getDefinition(type: string): SubAgentDefinition | undefined {
    return this.definitions.get(type)
  }

  static listDefinitions(): SubAgentDefinition[] {
    return Array.from(this.definitions.values())
  }

  /**
   * 启动一个 SubAgent。
   *
   * 创建独立的消息历史和 loop 计数，通过 callbacks 实时推送进度。
   * 返回 SubAgentResult（阻塞直到 SubAgent 结束）。
   */
  static async spawn(
    type: string,
    ctx: SubAgentContext,
    callbacks: AgentRunnerCallbacks
  ): Promise<SubAgentResult> {
    const def = this.definitions.get(type)
    if (!def) {
      throw new Error(`SubAgent type '${type}' is not registered`)
    }

    const handleId = `subagent_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    let abortController = new AbortController()

    const handle: SubAgentHandle = {
      id: handleId,
      type,
      status: 'running',
      cancel: () => {
        abortController.abort()
        handle.status = 'cancelled'
      }
    }
    this.activeHandles.set(handleId, handle)

    // 生命周期钩子：启动前
    if (def.onBeforeSpawn) {
      await def.onBeforeSpawn(ctx)
    }

    const toolManager = new ToolManager()
    const availableTools = def.getTools(toolManager)
    const systemPrompt = def.systemPromptBuilder(ctx)

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: ctx.parentPrompt }
    ]

    const chatService = new ChatService()
    let loopCount = 0
    let toolCallCount = 0
    let finalOutput = ''

    try {
      while (loopCount < def.maxLoops && !abortController.signal.aborted) {
        loopCount++

        // 上下文裁剪
        const trimResult = ContextManager.trimMessages(messages, 32000)
        const trimmedMessages = trimResult.messages

        let currentContent = ''
        let toolCallsAcc: Record<number, { id: string; type: 'function'; function: { name: string; arguments: string }; thought_signature?: string }> = {}
        let gotError = false
        let thoughtSig: string | undefined

        await new Promise<void>((resolve) => {
          chatService.streamChat(
            {
              baseUrl: ctx.apiConfig.baseUrl,
              apiKey: ctx.apiConfig.apiKey,
              apiFormat: ctx.apiConfig.apiFormat,
              model: ctx.modelOverride || ctx.apiConfig.model,
              messages: trimmedMessages,
              tools: availableTools,
              thinking: ctx.apiConfig.thinking as any
            },
            {
              onChunk: (delta, reasoningDelta, toolCallsChunk, thoughtSignature) => {
                if (abortController.signal.aborted) return
                if (thoughtSignature) thoughtSig = thoughtSignature
                if (delta) {
                  currentContent += delta
                  callbacks.onChunk?.(delta, '')
                }
                if (reasoningDelta) {
                  callbacks.onChunk?.('', reasoningDelta)
                }
                if (toolCallsChunk) {
                  for (const tc of toolCallsChunk) {
                    const idx = tc.index
                    if (!toolCallsAcc[idx]) {
                      toolCallsAcc[idx] = { id: tc.id || '', type: 'function', function: { name: tc.function?.name || '', arguments: '' } }
                    }
                    const acc = toolCallsAcc[idx]
                    if (tc.id) acc.id = tc.id
                    if (tc.function?.name) acc.function.name = tc.function.name
                    if (tc.function?.arguments) acc.function.arguments += tc.function.arguments
                    if (tc.thought_signature) acc.thought_signature = tc.thought_signature
                    else if (thoughtSignature) acc.thought_signature = thoughtSignature
                    if (acc.id) callbacks.onToolStart?.(acc.id, acc.function.name, acc.function.arguments, acc.thought_signature)
                  }
                }
              },
              onDone: () => resolve(),
              onError: (err) => { gotError = true; callbacks.onError?.(err); resolve() }
            },
            abortController.signal
          )
        })

        if (gotError || abortController.signal.aborted) break

        const toolCallsArray = Object.keys(toolCallsAcc).map((k) => {
          const tc = (toolCallsAcc as any)[k]
          const sig = tc.thought_signature || thoughtSig
          return {
            id: tc.id,
            type: tc.type,
            function: { ...tc.function, thought_signature: sig || 'skip_thought_signature_validator' },
            thought_signature: sig || 'skip_thought_signature_validator'
          }
        })

        if (toolCallsArray.length > 0) {
          messages.push({
            role: 'assistant',
            content: currentContent || '',
            tool_calls: toolCallsArray,
            thought_signature: thoughtSig || 'skip_thought_signature_validator',
            provider_specific_fields: { thought_signature: thoughtSig || 'skip_thought_signature_validator' }
          } as any)

          const toolResults = await Promise.all(
            toolCallsArray.map(async (tc) => {
              const name = tc.function.name
              const args = tc.function.arguments
              toolCallCount++

              callbacks.onToolStart?.(tc.id, name, args)

              const toolInstance = toolManager.getTool(name)
              let result = ''
              if (!toolInstance) {
                result = JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `Tool '${name}' not found` } })
              } else {
                try {
                  const raw = await toolInstance.execute(args, { workspaceRoot: ctx.workspaceRoot, sessionId: ctx.sessionId })
                  result = JSON.stringify({ ok: true, data: raw })
                } catch (err: any) {
                  result = JSON.stringify({ ok: false, error: { code: 'EXECUTION_ERROR', message: err.message } })
                }
              }

              callbacks.onToolEnd?.(tc.id, result)
              return { role: 'tool' as const, tool_call_id: tc.id, name, content: result }
            })
          )

          messages.push(...toolResults)
        } else {
          // SubAgent 产出最终文本
          finalOutput = currentContent
          break
        }
      }

      const subResult: SubAgentResult = {
        type,
        output: finalOutput,
        toolCallCount
      }
      handle.status = 'completed'
      handle.result = subResult

      // 生命周期钩子：完成后
      if (def.onAfterComplete) {
        await def.onAfterComplete(ctx, subResult)
      }

      return subResult
    } catch (err: any) {
      handle.status = 'failed'
      throw err
    } finally {
      this.activeHandles.delete(handleId)
    }
  }

  static getHandle(id: string): SubAgentHandle | undefined {
    return this.activeHandles.get(id)
  }

  static listActive(): SubAgentHandle[] {
    return Array.from(this.activeHandles.values())
  }
}
