import { ChatService } from '../services/ChatService'
import { ToolManager } from '../tools/ToolManager'
import { ContextManager } from './ContextManager'
import type { ChatMessage, ToolDefinition } from '../../shared/types/provider'
import type { StreamCallbacks } from '../services/ChatService'
import type { AgentRunnerCallbacks } from './AgentRunner'
import { allSubAgentDefinitions } from './definitions'
import {
  generateSubmitResultTool,
  extractJsonBlock,
  validateAgainstSpec,
  computeQualitySummary
} from './AgentRunner/subagentOutputHelper'

// ─── SubAgent 定义接口 ──────────────────────────────────────

export interface SubAgentContext {
  workspaceRoot: string
  sessionId: string

  /** 要回答的核心问题 */
  task: string
  /** @deprecated 使用 task 代替 */
  parentPrompt: string

  /** 验收标准 — 子 Agent 必须逐条回答 */
  expectations?: {
    questions: string[]
    outOfScope?: string[]
  }

  /** 主 Agent 对问题域的已知信息（自然语言，非文件列表） */
  context?: string

  /** 领域边界（结构事实，非探索提示） */
  scope?: {
    directories?: string[]
    excludeGlobs?: string[]
  }

  /** 探索深度 → 框架映射到 maxLoops */
  depth?: 'quick' | 'normal' | 'exhaustive'

  parentMessages?: ChatMessage[]
  modelOverride?: string
  maxLoopsOverride?: number

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
  structuredOutput?: SubAgentStructuredOutput
  qualitySummary?: SubAgentQualitySummary
  toolCallCount: number
  filesExamined?: string[]
  planSlug?: string
}

export interface SubAgentDefinition {
  type: string
  description: string

  /** 主 Agent 何时应委派给此子 Agent */
  whenToUse: string
  /** 主 Agent 何时不应委派 */
  whenNotToUse?: string
  /** 调用成本提示 */
  costHint?: string

  systemPromptBuilder: (ctx: SubAgentContext) => string
  getTools(toolManager: ToolManager): ToolDefinition[]

  /** 输出规格 — 设置后框架自动注入 submit_result 工具 */
  outputSpec?: SubAgentOutputSpec

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

// ─── 结构化输出类型 ──────────────────────────────────────────

/** 子 Agent 输出的证据项 */
export interface SubAgentEvidence {
  file: string
  line: number
  snippet: string
}

/** 子 Agent 对单个问题的回答 */
export interface SubAgentAnswer {
  question: string
  answer: string
  confidence: 'confirmed' | 'likely' | 'speculative'
  evidence: SubAgentEvidence[]
}

/** 未能回答的问题 */
export interface SubAgentUnresolved {
  question: string
  reason: string
}

/** 结构化的子 Agent 输出 */
export interface SubAgentStructuredOutput {
  conclusion: string
  answers: SubAgentAnswer[]
  unresolved: SubAgentUnresolved[]
  additionalDiscoveries?: SubAgentAnswer[]
}

/** 质量摘要 — 框架自动计算 */
export interface SubAgentQualitySummary {
  coverage: number
  confirmedRatio: number
  unresolvedCount: number
  warning: string | null
}

/** 子 Agent 输出字段定义 */
export interface SubAgentOutputField {
  name: string
  type: 'string' | 'string[]' | 'number' | 'boolean'
  description: string
  required: boolean
}

/** 子 Agent 输出规格 */
export interface SubAgentOutputSpec {
  description: string
  fields: SubAgentOutputField[]
}

// ─── 深度映射 ──────────────────────────────────────────────

const DEPTH_LOOPS: Record<string, number> = {
  quick: 6,
  normal: 12,
  exhaustive: 20,
}

function resolveMaxLoops(def: SubAgentDefinition, ctx: SubAgentContext): number {
  if (ctx.maxLoopsOverride) return ctx.maxLoopsOverride
  if (ctx.depth && DEPTH_LOOPS[ctx.depth]) return DEPTH_LOOPS[ctx.depth]
  return def.maxLoops
}

// ─── 系统提示扩展 ───────────────────────────────────────────

function buildExtendedSystemPrompt(def: SubAgentDefinition, ctx: SubAgentContext): string {
  const basePrompt = def.systemPromptBuilder(ctx)
  const parts: string[] = [basePrompt]

  // 验收标准清单
  if (ctx.expectations?.questions?.length) {
    parts.push('\n\n## Acceptance Criteria')
    parts.push('Before submitting your results, you MUST verify each of the following:')
    parts.push(ctx.expectations.questions.map((q, i) => `  ${i + 1}. [ ] ${q}`).join('\n'))
    if (ctx.expectations.outOfScope?.length) {
      parts.push('\nThe following are OUT OF SCOPE — do not spend time on:')
      parts.push(ctx.expectations.outOfScope.map(s => `  - ${s}`).join('\n'))
    }
    parts.push('\nIf you cannot answer a question, state it explicitly in the "unresolved" list with a reason.')
  }

  // 主动发现触发器
  parts.push('\n\n## Proactive Discovery')
  parts.push('After your initial exploration (first 2-3 tool calls), review the questions.')
  parts.push('Ask yourself: "Is there a critical question the caller SHOULD have asked but didn\'t?"')
  parts.push('If yes, explore and answer it briefly. Flag these as "additionalDiscoveries" in your submit_result call.')
  parts.push('(If it would take more than 3 extra rounds, note it in "unresolved" instead.)')

  // 输出指令（如果设置了 outputSpec）
  if (def.outputSpec) {
    parts.push('\n\n## Output Requirements')
    parts.push('When you have completed your work, call submit_result with your findings.')
    parts.push('Do NOT output your final answer as plain text — use the submit_result tool.')
    parts.push('If you produce plain text instead, your results may not be parsed correctly and important findings may be lost.')
  }

  return parts.join('\n')
}

// ─── SubAgentManager ────────────────────────────────────────

export class SubAgentManager {
  private static definitions = new Map<string, SubAgentDefinition>(
    allSubAgentDefinitions.map(def => [def.type, def])
  )
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

    // 注入 submit_result 工具（如果设置了 outputSpec）
    if (def.outputSpec) {
      availableTools.push(generateSubmitResultTool(def.outputSpec))
    }

    const systemPrompt = buildExtendedSystemPrompt(def, ctx)

    const task = ctx.task || ctx.parentPrompt || ''
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task }
    ]

    const chatService = new ChatService()
    let loopCount = 0
    let toolCallCount = 0
    let finalOutput = ''
    const filesExamined = new Set<string>()
    const effectiveMaxLoops = resolveMaxLoops(def, ctx)

    try {
      while (loopCount < effectiveMaxLoops && !abortController.signal.aborted) {
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

          // 检查是否有 submit_result 调用
          const submitCall = toolCallsArray.find(tc => tc.function.name === 'submit_result')
          if (submitCall && def.outputSpec) {
            // 处理 submit_result
            let structuredOutput: SubAgentStructuredOutput | undefined
            try {
              const args = JSON.parse(submitCall.function.arguments)
              structuredOutput = validateAgainstSpec(args, def.outputSpec)
            } catch {
              // 解析失败，继续循环让模型重试
            }

            if (structuredOutput) {
              // 推送 submit_result 的 ack 消息
              messages.push({
                role: 'tool' as const,
                tool_call_id: submitCall.id,
                name: 'submit_result',
                content: JSON.stringify({ ok: true, data: 'Results submitted and validated.' })
              })

              finalOutput = currentContent

              const subResult: SubAgentResult = {
                type,
                output: finalOutput,
                structuredOutput,
                toolCallCount,
                filesExamined: Array.from(filesExamined),
              }

              // 计算质量摘要
              subResult.qualitySummary = computeQualitySummary(
                ctx.expectations?.questions ?? [],
                structuredOutput
              )

              handle.status = 'completed'
              handle.result = subResult

              // 生命周期钩子：完成后
              if (def.onAfterComplete) {
                await def.onAfterComplete(ctx, subResult)
              }

              return subResult
            } else {
              // submit_result 验证失败 — 推送错误让模型重试
              messages.push({
                role: 'tool' as const,
                tool_call_id: submitCall.id,
                name: 'submit_result',
                content: JSON.stringify({
                  ok: false,
                  error: {
                    code: 'VALIDATION_ERROR',
                    message: 'submit_result data did not match the expected schema. Check your output format — ensure you include "conclusion" (string), "answers" (array), and "unresolved" (array). Then call submit_result again.'
                  }
                })
              })
              continue  // 不执行其他工具，让模型重新提交
            }
          }

          // 执行常规工具调用
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

                  // 追踪读取的文件
                  if (name === 'Read' || name === 'list_files') {
                    try { const p = JSON.parse(args); if (p.file_path) filesExamined.add(p.file_path) } catch {}
                  }
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
          // SubAgent 产出最终文本（未调用 submit_result 的纯文本回退）
          finalOutput = currentContent

          // 尝试从纯文本中提取 JSON
          if (def.outputSpec && currentContent) {
            const maybeJson = extractJsonBlock(currentContent)
            if (maybeJson) {
              const structured = validateAgainstSpec(maybeJson, def.outputSpec)
              if (structured) {
                const subResult: SubAgentResult = {
                  type,
                  output: finalOutput,
                  structuredOutput: structured,
                  toolCallCount,
                  filesExamined: Array.from(filesExamined),
                }
                subResult.qualitySummary = computeQualitySummary(
                  ctx.expectations?.questions ?? [],
                  structured
                )
                handle.status = 'completed'
                handle.result = subResult
                if (def.onAfterComplete) {
                  await def.onAfterComplete(ctx, subResult)
                }
                return subResult
              }
            }
          }

          break
        }
      }

      const subResult: SubAgentResult = {
        type,
        output: finalOutput,
        toolCallCount,
        filesExamined: Array.from(filesExamined),
      }

      // 如果设置了 outputSpec 但没有 structuredOutput，生成警告质量摘要
      if (def.outputSpec && !subResult.structuredOutput && ctx.expectations?.questions?.length) {
        subResult.qualitySummary = {
          coverage: 0,
          confirmedRatio: 0,
          unresolvedCount: 0,
          warning: 'SubAgent produced plain text instead of structured output via submit_result. Findings may be incomplete.',
        }
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
