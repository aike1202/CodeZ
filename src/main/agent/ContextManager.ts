import type { ChatMessage } from '../../shared/types/provider'
import * as path from 'path'
import * as fs from 'fs/promises'
import { app } from 'electron'

export interface TrimOptions {
  /** 单条 tool 输出的最大字符数，超出将被截断。默认 3000 */
  maxToolOutputChars?: number
  /** 消息数组的最大总条数（含 system）。默认 40 */
  maxTotalMessages?: number
  /** 保留最近 N 轮对话不被裁剪。默认 3 */
  keepRecentRounds?: number
}

export interface GoalSnapshot {
  id?: string
  title?: string
  originalPrompt: string
  normalizedGoal?: string
  keyRequirements: string[]
  nonGoals?: string[]
  successCriteria?: string[]
  updatedAt?: string
}

export interface TaskPlan {
  currentStep: string
  completedSteps: string[]
  pendingSteps: string[]
}

export interface ResumeState {
  currentGoalId: string
  currentPhase: string
  currentStep: string
  lastCompletedStep?: string
  nextAction: string
  openQuestions: string[]
  blockedBy: string[]
  filesTouched: string[]
  filesToInspectNext: string[]
  validationPending: string[]
  goal?: GoalSnapshot
  plan?: TaskPlan
  contextFiles?: string[]
  lastTrimmedAt?: number
  updatedAt?: string
}

const DEFAULT_MAX_TOOL_OUTPUT = 3000
const DEFAULT_MIN_TOOL_OUTPUT = 1500
const DEFAULT_MAX_TOTAL_MESSAGES = 40
const DEFAULT_KEEP_RECENT_ROUNDS = 3

/** CJK 字符范围正则（中日韩统一表意 + 常用标点 + 全角符号） */
const CJK_REGEX = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g

/**
 * 智能上下文窗口管理器。
 *
 * 在发送消息给大模型前，对累积的 messages 数组做三步裁剪：
 * 1. 锚定首条 System Prompt 永不删除
 * 2. 截断过长的 tool 输出内容
 * 3. 按消息总数上限裁剪最旧的对话轮次（保证 assistant+tool 成组删除）
 * 
 * 附带 ResumeState 管理，在 Token 超限或长会话时浓缩保存任务蓝图。
 */
export class ContextManager {
  /**
   * 估算消息的 Token 数。
   * 对 CJK 字符使用 1:1.5 比率，非 CJK 字符使用 1:4 比率。
   */
  static estimateTokens(messages: ChatMessage[]): number {
    let count = 0
    for (const msg of messages) {
      if (msg.content) count += ContextManager.estimateStringTokens(msg.content)
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          count += Math.ceil((tc.function?.name?.length || 0) / 4)
          const args = tc.function?.arguments || ''
          count += ContextManager.estimateStringTokens(args)
        }
      }
    }
    return count
  }

  /** 对单个字符串做 CJK 感知的 Token 估算 */
  private static estimateStringTokens(text: string): number {
    const cjkMatches = text.match(CJK_REGEX)
    const cjkCount = cjkMatches ? cjkMatches.length : 0
    const otherCount = text.length - cjkCount
    return Math.ceil(cjkCount / 1.5 + otherCount / 4)
  }

  /**
   * 对消息数组进行智能裁剪，返回新数组及裁剪状态。
   */
  static trimMessages(
    messages: ChatMessage[],
    contextWindowTokens: number = 32000,
    options?: TrimOptions
  ): { messages: ChatMessage[], trimmed: boolean, trimmedCount: number, willTrimSoon: boolean } {
    // 根据上下文窗口大小动态调整工具输出截断长度
    const dynamicMaxToolOutput = Math.max(
      DEFAULT_MIN_TOOL_OUTPUT,
      Math.min(30000, Math.floor(contextWindowTokens / 100))
    )
    const maxToolOutput = options?.maxToolOutputChars ?? dynamicMaxToolOutput
    const keepRecent = options?.keepRecentRounds ?? DEFAULT_KEEP_RECENT_ROUNDS

    // 步骤 1: 浅拷贝并截断 tool 输出
    let result = messages.map(msg => {
      if (msg.role === 'tool' && msg.content && msg.content.length > maxToolOutput) {
        return {
          ...msg,
          content: ContextManager.truncateToolOutput(msg.content, maxToolOutput)
        }
      }
      return msg
    })

    const initialLength = result.length
    let trimmed = false
    let trimmedCount = 0

    // 步骤 2: 基于 Token 的动态裁剪
    const threshold = contextWindowTokens * 0.75
    const warningThreshold = contextWindowTokens * 0.65
    const targetTokens = contextWindowTokens * 0.6

    const tokensBefore = ContextManager.estimateTokens(result)
    
    let willTrimSoon = false

    if (tokensBefore > threshold) {
      result = ContextManager.trimByTokens(result, targetTokens, keepRecent)
    } else if (tokensBefore > warningThreshold) {
      willTrimSoon = true
    }

    // 步骤 3: 兼容旧的固定条数裁剪（作为兜底）
    // 仅在步骤 2 未触发裁剪（消息数未减少）且条数超限时生效
    const maxTotal = options?.maxTotalMessages ?? DEFAULT_MAX_TOTAL_MESSAGES
    if (result.length === initialLength && result.length > maxTotal) {
      result = ContextManager.trimByCount(result, maxTotal, keepRecent)
    }

    if (result.length < initialLength) {
      trimmed = true
      trimmedCount = initialLength - result.length
      const tokensAfter = ContextManager.estimateTokens(result)
      console.log(
        `[ContextManager] Trimmed ${trimmedCount} messages. ` +
        `Tokens: ${tokensBefore} → ${tokensAfter} ` +
        `(window: ${contextWindowTokens}, threshold: ${Math.floor(threshold)}, toolOutput: ${maxToolOutput})`
      )
    }

    return { messages: result, trimmed, trimmedCount, willTrimSoon }
  }

  /**
   * 截断单条 tool 输出：保留前 headChars + 后 tailChars，中间替换为摘要标记。
   */
  static truncateToolOutput(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content

    // 头部保留 70%，尾部保留 30%（最少各 200 字符）
    const headChars = Math.max(Math.floor(maxChars * 0.7), 200)
    const tailChars = Math.max(Math.floor(maxChars * 0.3), 200)

    const head = content.slice(0, headChars)
    const tail = content.slice(-tailChars)
    const originalSize = content.length

    return `${head}\n\n[... Output Truncated. Original size: ${originalSize} chars ...]\n\n${tail}`
  }

  /**
   * 按 Token 数量裁剪：
   * - 始终保留 messages[0]（System Prompt）
   * - 始终保留最近 keepRecentRounds 轮的完整 user→assistant→tool 组
   * - 从最旧的消息开始移除，保证 assistant(带 tool_calls) 和对应 tool 结果成组删除
   */
  private static trimByTokens(
    messages: ChatMessage[],
    targetTokens: number,
    keepRecentRounds: number
  ): ChatMessage[] {
    const systemMsg = messages[0]?.role === 'system' ? messages[0] : null
    const rest = systemMsg ? messages.slice(1) : [...messages]

    const roundStartIndices: number[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].role === 'user') {
        roundStartIndices.push(i)
      }
    }

    const protectedStartIdx = roundStartIndices.length > keepRecentRounds
      ? roundStartIndices[roundStartIndices.length - keepRecentRounds]
      : 0

    const protectedMessages = rest.slice(protectedStartIdx)
    let trimCandidates = rest.slice(0, protectedStartIdx)

    let currentTokens = ContextManager.estimateTokens([
      ...(systemMsg ? [systemMsg] : []),
      ...trimCandidates,
      ...protectedMessages
    ])

    if (currentTokens <= targetTokens) {
      return messages
    }

    let removed = 0

    for (let i = 0; i < trimCandidates.length && currentTokens > targetTokens; i++) {
      const msg = trimCandidates[i]
      let groupTokens = ContextManager.estimateTokens([msg])

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCallIds = new Set(msg.tool_calls.map(tc => tc.id))
        let groupSize = 1
        for (let j = i + 1; j < trimCandidates.length; j++) {
          if (trimCandidates[j].role === 'tool' && trimCandidates[j].tool_call_id && toolCallIds.has(trimCandidates[j].tool_call_id!)) {
            groupSize++
            groupTokens += ContextManager.estimateTokens([trimCandidates[j]])
          } else {
            break
          }
        }
        removed += groupSize
        i += groupSize - 1
      } else {
        removed++
      }

      currentTokens -= groupTokens
    }

    trimCandidates = trimCandidates.slice(Math.min(removed, trimCandidates.length))

    const final: ChatMessage[] = []
    if (systemMsg) final.push(systemMsg)
    final.push(...trimCandidates)
    final.push(...protectedMessages)

    return final
  }

  /**
   * 按消息总数裁剪：兜底逻辑
   */
  private static trimByCount(
    messages: ChatMessage[],
    maxTotal: number,
    keepRecentRounds: number
  ): ChatMessage[] {
    const systemMsg = messages[0]?.role === 'system' ? messages[0] : null
    const rest = systemMsg ? messages.slice(1) : [...messages]

    const roundStartIndices: number[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].role === 'user') {
        roundStartIndices.push(i)
      }
    }

    const protectedStartIdx = roundStartIndices.length > keepRecentRounds
      ? roundStartIndices[roundStartIndices.length - keepRecentRounds]
      : 0

    const protectedMessages = rest.slice(protectedStartIdx)
    let trimCandidates = rest.slice(0, protectedStartIdx)

    const systemCount = systemMsg ? 1 : 0
    const neededRemoval = (systemCount + trimCandidates.length + protectedMessages.length) - maxTotal

    if (neededRemoval > 0) {
      let removed = 0

      for (let i = 0; i < trimCandidates.length && removed < neededRemoval; i++) {
        const msg = trimCandidates[i]

        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
          const toolCallIds = new Set(msg.tool_calls.map(tc => tc.id))
          let groupSize = 1
          for (let j = i + 1; j < trimCandidates.length; j++) {
            if (trimCandidates[j].role === 'tool' && trimCandidates[j].tool_call_id && toolCallIds.has(trimCandidates[j].tool_call_id!)) {
              groupSize++
            } else {
              break
            }
          }
          removed += groupSize
          i += groupSize - 1
        } else {
          removed++
        }
      }

      trimCandidates = trimCandidates.slice(Math.min(removed, trimCandidates.length))
    }

    const final: ChatMessage[] = []
    if (systemMsg) final.push(systemMsg)
    final.push(...trimCandidates)
    final.push(...protectedMessages)

    return final
  }

  static createResumeStateKey(workspaceRoot: string, sessionId?: string): string {
    const crypto = require('crypto')
    const wsHash = crypto.createHash('md5').update(path.resolve(workspaceRoot)).digest('hex')
    return sessionId ? `workspace_${wsHash}_${sessionId}` : `workspace_${wsHash}`
  }

  /**
   * 存储任务核心状态
   */
  static async saveResumeState(sessionId: string, state: ResumeState): Promise<void> {
    const dir = path.join(app.getPath('userData'), 'agent-sessions')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${sessionId}.json`)
    await fs.writeFile(file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf-8')
  }

  /**
   * 加载任务核心状态
   */
  static async loadResumeState(sessionId: string): Promise<ResumeState | null> {
    const file = path.join(app.getPath('userData'), 'agent-sessions', `${sessionId}.json`)
    try {
      const data = await fs.readFile(file, 'utf-8')
      return JSON.parse(data) as ResumeState
    } catch {
      return null
    }
  }
}
