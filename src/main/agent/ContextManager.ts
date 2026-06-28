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
  originalPrompt: string
  keyRequirements: string[]
}

export interface TaskPlan {
  currentStep: string
  completedSteps: string[]
  pendingSteps: string[]
}

export interface ResumeState {
  goal: GoalSnapshot
  plan: TaskPlan
  contextFiles: string[]
  lastTrimmedAt?: number
}

const DEFAULT_MAX_TOOL_OUTPUT = 3000
const DEFAULT_MAX_TOTAL_MESSAGES = 40
const DEFAULT_KEEP_RECENT_ROUNDS = 3

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
   * 对消息数组进行智能裁剪，返回新数组（不修改原数组）。
   */
  static trimMessages(messages: ChatMessage[], options?: TrimOptions): ChatMessage[] {
    const maxToolOutput = options?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT
    const maxTotal = options?.maxTotalMessages ?? DEFAULT_MAX_TOTAL_MESSAGES
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

    // 步骤 2: 数量裁剪
    if (result.length > maxTotal) {
      result = ContextManager.trimByCount(result, maxTotal, keepRecent)
    }

    return result
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
   * 按消息总数裁剪：
   * - 始终保留 messages[0]（System Prompt）
   * - 始终保留最近 keepRecentRounds 轮的完整 user→assistant→tool 组
   * - 从最旧的消息开始移除，保证 assistant(带 tool_calls) 和对应 tool 结果成组删除
   */
  private static trimByCount(
    messages: ChatMessage[],
    maxTotal: number,
    keepRecentRounds: number
  ): ChatMessage[] {
    // 分离 System Prompt
    const systemMsg = messages[0]?.role === 'system' ? messages[0] : null
    const rest = systemMsg ? messages.slice(1) : [...messages]

    // 找出需要保护的最近 N 轮对话的起始索引
    // 一"轮"定义为: user 消息 + 后续的 assistant/tool 消息直到下一个 user
    const roundStartIndices: number[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].role === 'user') {
        roundStartIndices.push(i)
      }
    }

    // 保护最近 keepRecentRounds 轮
    const protectedStartIdx = roundStartIndices.length > keepRecentRounds
      ? roundStartIndices[roundStartIndices.length - keepRecentRounds]
      : 0

    const protectedMessages = rest.slice(protectedStartIdx)
    let trimCandidates = rest.slice(0, protectedStartIdx)

    // 从 trimCandidates 中删除消息直到总数满足限制
    const systemCount = systemMsg ? 1 : 0
    const neededRemoval = (systemCount + trimCandidates.length + protectedMessages.length) - maxTotal

    if (neededRemoval > 0) {
      // 从头部移除，但要保证 assistant+tool 成组删除
      let removed = 0
      const keepSet = new Set<number>()

      for (let i = 0; i < trimCandidates.length && removed < neededRemoval; i++) {
        if (keepSet.has(i)) continue

        const msg = trimCandidates[i]

        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
          // 找出对应的 tool 结果消息
          const toolCallIds = new Set(msg.tool_calls.map(tc => tc.id))
          let groupSize = 1 // assistant 本身
          for (let j = i + 1; j < trimCandidates.length; j++) {
            if (trimCandidates[j].role === 'tool' && trimCandidates[j].tool_call_id && toolCallIds.has(trimCandidates[j].tool_call_id!)) {
              groupSize++
            } else {
              break
            }
          }
          removed += groupSize
          // 不加入 keepSet，让默认移除生效
        } else {
          removed++
        }
      }

      // 实际移除
      trimCandidates = trimCandidates.slice(Math.min(removed, trimCandidates.length))
    }

    // 重组
    const final: ChatMessage[] = []
    if (systemMsg) final.push(systemMsg)
    final.push(...trimCandidates)
    final.push(...protectedMessages)

    return final
  }

  /**
   * 存储任务核心状态
   */
  static async saveResumeState(sessionId: string, state: ResumeState): Promise<void> {
    const dir = path.join(app.getPath('userData'), 'agent-sessions')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${sessionId}.json`)
    await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf-8')
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
