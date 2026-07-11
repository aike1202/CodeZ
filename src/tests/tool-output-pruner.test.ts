import { describe, expect, it } from 'vitest'
import { ToolOutputPruner } from '../main/services/context/ToolOutputPruner'
import type { NormalizedModelMessage } from '../shared/types/context'

function tool(id: string, content: string, name = 'Read'): NormalizedModelMessage {
  return {
    id, turnId: id, role: 'tool', toolCallId: `call-${id}`, name,
    content, status: 'complete', createdAt: '2026-07-10T00:00:00.000Z'
  }
}

describe('ToolOutputPruner', () => {
  it('prunes only old successful results and leaves the source untouched', () => {
    const old = 'A'.repeat(20_000)
    const recent = 'B'.repeat(20_000)
    const messages = [tool('old', old), tool('error', JSON.stringify({ ok: false, error: 'fatal' })), tool('recent', recent)]
    const result = new ToolOutputPruner().prune(messages, { targetTokens: 6_000, protectedTailStart: 2 })

    const placeholder = JSON.parse(result.messages[0].content)
    expect(placeholder).toMatchObject({ code: 'TOOL_OUTPUT_PRUNED', toolName: 'Read', originalChars: 20_000 })
    expect(result.messages[1].content).toContain('fatal')
    expect(result.messages[2].content).toBe(recent)
    expect(messages[0].content).toBe(old)
  })

  it('protects skill outputs even when they are old', () => {
    const messages = [tool('skill', 'S'.repeat(20_000), 'Skill'), tool('read', 'R'.repeat(20_000))]
    const result = new ToolOutputPruner().prune(messages, { targetTokens: 6_000, protectedTailStart: 2 })
    expect(result.messages[0].content).toBe(messages[0].content)
    expect(result.messages[1].content).toContain('TOOL_OUTPUT_PRUNED')
  })

  it('prunes an oversized successful result even inside the protected tail', () => {
    const huge = 'G'.repeat(621_396)
    const messages = [tool('recent-glob', huge, 'Glob')]
    const result = new ToolOutputPruner().prune(messages, {
      targetTokens: 100_000,
      protectedTailStart: 0,
      maxSingleToolTokens: 8_000
    })

    expect(result.messages[0].content).toContain('TOOL_OUTPUT_PRUNED')
    expect(JSON.parse(result.messages[0].content)).toMatchObject({
      toolName: 'Glob',
      originalChars: 621_396
    })
    expect(result.tokensAfter).toBeLessThan(1_000)
    expect(messages[0].content).toBe(huge)
  })
})
