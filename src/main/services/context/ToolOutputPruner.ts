import { createHash } from 'crypto'
import type { NormalizedModelMessage } from '../../../shared/types/context'
import { ContextBudgetService } from './ContextBudgetService'

export interface ToolOutputPruneOptions {
  targetTokens: number
  protectedTailStart: number
}

export interface ToolOutputPruneRecord {
  messageId: string
  toolName: string
  originalChars: number
  originalTokensEstimate: number
  sha256: string
}

export interface ToolOutputPruneResult {
  messages: NormalizedModelMessage[]
  records: ToolOutputPruneRecord[]
  tokensBefore: number
  tokensAfter: number
}

const PROTECTED_TOOLS = new Set(['Skill'])

function isErrorResult(content: string): boolean {
  try {
    const parsed = JSON.parse(content)
    return parsed?.ok === false || Boolean(parsed?.error && parsed?.ok !== true)
  } catch {
    return /(^|\n)\s*(error|fatal|failed|access denied)\b/i.test(content)
  }
}

export class ToolOutputPruner {
  constructor(private readonly budget = new ContextBudgetService()) {}

  prune(
    source: NormalizedModelMessage[],
    options: ToolOutputPruneOptions
  ): ToolOutputPruneResult {
    const messages = source.map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map((call) => ({ ...call }))
    }))
    const estimateTotal = () => messages.reduce(
      (total, message) => total + this.budget.estimateValueTokens(message), 0
    )
    const tokensBefore = estimateTotal()
    const candidates = messages
      .map((message, index) => ({ message, index, tokens: this.budget.estimateStringTokens(message.content) }))
      .filter(({ message, index }) =>
        index < options.protectedTailStart &&
        message.role === 'tool' &&
        message.status === 'complete' &&
        !PROTECTED_TOOLS.has(message.name || '') &&
        !isErrorResult(message.content)
      )
      .sort((left, right) => right.tokens - left.tokens || left.index - right.index)

    const records: ToolOutputPruneRecord[] = []
    let currentTokens = tokensBefore
    for (const candidate of candidates) {
      if (currentTokens <= options.targetTokens) break
      const content = candidate.message.content
      const record: ToolOutputPruneRecord = {
        messageId: candidate.message.id,
        toolName: candidate.message.name || 'unknown',
        originalChars: content.length,
        originalTokensEstimate: candidate.tokens,
        sha256: createHash('sha256').update(content).digest('hex')
      }
      const headLength = Math.min(160, Math.floor(content.length * 0.6))
      const tailLength = Math.min(80, Math.max(0, content.length - headLength))
      candidate.message.content = JSON.stringify({
        code: 'TOOL_OUTPUT_PRUNED',
        toolName: record.toolName,
        originalChars: record.originalChars,
        originalTokensEstimate: record.originalTokensEstimate,
        sha256: record.sha256,
        head: content.slice(0, headLength),
        tail: tailLength ? content.slice(-tailLength) : ''
      })
      currentTokens -= Math.max(0, candidate.tokens - this.budget.estimateStringTokens(candidate.message.content))
      records.push(record)
    }

    return { messages, records, tokensBefore, tokensAfter: estimateTotal() }
  }
}
