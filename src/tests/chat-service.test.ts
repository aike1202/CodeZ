import { describe, it, expect } from 'vitest'
import { buildThinkingPayload } from '../main/services/chat/utils'
import { processDeltaWithThinkTags, ThinkParserState } from '../main/services/chat/OpenAIProvider'

describe('ChatService - processDeltaWithThinkTags', () => {
  it('应当直接输出不带 think 标签的标准文本', () => {
    const state: ThinkParserState = { inThinkTag: false, streamBuffer: '' }
    const chunks: { delta: string; reasoning: string }[] = []

    processDeltaWithThinkTags('hello', state, (delta: string, reasoning: string) => {
      chunks.push({ delta, reasoning })
    })

    processDeltaWithThinkTags(' world', state, (delta: string, reasoning: string) => {
      chunks.push({ delta, reasoning })
    })

    expect(chunks).toEqual([
      { delta: 'hello', reasoning: '' },
      { delta: ' world', reasoning: '' }
    ])
    expect(state).toEqual({ inThinkTag: false, streamBuffer: '' })
  })

  it('应当正确提取完整的 think 标签内容为 reasoning', () => {
    const state: ThinkParserState = { inThinkTag: false, streamBuffer: '' }
    const chunks: { delta: string; reasoning: string }[] = []

    processDeltaWithThinkTags('hello <think>some thought</think> response', state, (delta: string, reasoning: string) => {
      chunks.push({ delta, reasoning })
    })

    expect(chunks).toEqual([
      { delta: 'hello ', reasoning: '' },
      { delta: '', reasoning: 'some thought' },
      { delta: ' response', reasoning: '' }
    ])
    expect(state).toEqual({ inThinkTag: false, streamBuffer: '' })
  })

  it('应当处理跨分片边界的 <think> 标签', () => {
    const state: ThinkParserState = { inThinkTag: false, streamBuffer: '' }
    const chunks: { delta: string; reasoning: string }[] = []

    // 1. 发送 "hello <th" -> 应暂存 "<th"，输出 "hello "
    processDeltaWithThinkTags('hello <th', state, (delta: string, reasoning: string) => {
      chunks.push({ delta, reasoning })
    })
    expect(chunks).toEqual([
      { delta: 'hello ', reasoning: '' }
    ])
    expect(state).toEqual({ inThinkTag: false, streamBuffer: '<th' })

    // 2. 发送 "ink>thinking..." -> 拼接为 "<think>thinking..."，转换状态，输出 reasoning
    processDeltaWithThinkTags('ink>thinking...', state, (delta: string, reasoning: string) => {
      chunks.push({ delta, reasoning })
    })
    expect(chunks).toEqual([
      { delta: 'hello ', reasoning: '' },
      { delta: '', reasoning: 'thinking...' }
    ])
    expect(state).toEqual({ inThinkTag: true, streamBuffer: '' })

    // 3. 发送 " </th" -> 应暂存 "</th"，输出 " "
    processDeltaWithThinkTags(' </th', state, (delta: string, reasoning: string) => {
      chunks.push({ delta, reasoning })
    })
    expect(chunks).toEqual([
      { delta: 'hello ', reasoning: '' },
      { delta: '', reasoning: 'thinking...' },
      { delta: '', reasoning: ' ' }
    ])
    expect(state).toEqual({ inThinkTag: true, streamBuffer: '</th' })

    // 4. 发送 "ink> done" -> 拼接为 "</think> done"，转换状态，输出 " done"
    processDeltaWithThinkTags('ink> done', state, (delta: string, reasoning: string) => {
      chunks.push({ delta, reasoning })
    })
    expect(chunks).toEqual([
      { delta: 'hello ', reasoning: '' },
      { delta: '', reasoning: 'thinking...' },
      { delta: '', reasoning: ' ' },
      { delta: ' done', reasoning: '' }
    ])
    expect(state).toEqual({ inThinkTag: false, streamBuffer: '' })
  })
})

describe('ChatService - buildThinkingPayload (自动适配与推导)', () => {
  it('应当在 mode 为 auto 时，基于 model 自动选用 gemini 配置', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'auto' },
      'gemini-3.5-flash-high',
      'http://127.0.0.1:8045/v1'
    )
    expect(payload).toHaveProperty('thinking_config')
    expect(payload).toHaveProperty('google')
  })

  it('应当在 mode 为 auto 时，基于 baseUrl 自动选用 openrouter 配置', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'auto' },
      'gpt-4o',
      'https://openrouter.ai/api/v1'
    )
    expect(payload).toEqual({ include_reasoning: true })
  })

  it('应当在 mode 为 auto 时，基于 model 自动选用 deepseek 配置', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'auto' },
      'deepseek-r1-chat',
      'https://api.deepseek.com/v1'
    )
    expect(payload).toEqual({ reasoning: { enabled: true }, thinking: { type: 'enabled' }, max_completion_tokens: undefined })
  })

  it('应当在 mode 为 auto 时，基于 model 自动选用 qwen 配置', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'auto' },
      'qwen-max-thinking',
      'https://dashscope.aliyuncs.com/api/v1'
    )
    expect(payload).toEqual({ enable_thinking: true, max_completion_tokens: undefined })
  })

  it('应当直接输出显式指定的模式配置，不进行推导', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'deepseek' },
      'gemini-3.5-flash-high',
      'http://127.0.0.1:8045/v1'
    )
    expect(payload).toEqual({ reasoning: { enabled: true }, thinking: { type: 'enabled' }, max_completion_tokens: undefined })
  })

  it('应当在设置了 budgetTokens 时注入相应参数', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'deepseek', budgetTokens: 2000, effort: 'custom' },
      'deepseek-r1-chat',
      'https://api.deepseek.com/v1'
    )
    expect(payload).toEqual({ reasoning: { enabled: true }, thinking: { type: 'enabled' }, max_completion_tokens: 2000 })

    const payloadAnthropic = buildThinkingPayload(
      { enabled: true, mode: 'anthropic', budgetTokens: 2000, effort: 'custom' },
      'claude-3-7-sonnet',
      'https://api.anthropic.com/v1'
    )
    expect(payloadAnthropic).toEqual({ thinking: { type: 'enabled', budget_tokens: 2000 } })
  })

  it('应当在配置了 effort 级别时自动映射对应的 Tokens', () => {
    // Low -> 1024
    const payloadLow = buildThinkingPayload(
      { enabled: true, mode: 'anthropic', effort: 'low' },
      'claude-3-7-sonnet',
      'https://api.anthropic.com/v1'
    )
    expect(payloadLow).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'low' } })

    // Medium -> 4096 (Deepseek mode)
    const payloadMedium = buildThinkingPayload(
      { enabled: true, mode: 'deepseek', effort: 'medium' },
      'deepseek-r1',
      'https://api.deepseek.com/v1'
    )
    expect(payloadMedium).toEqual({ reasoning: { enabled: true }, thinking: { type: 'enabled' }, max_completion_tokens: 4096, reasoning_effort: 'medium' })

    // High -> 16384 (Qwen mode)
    const payloadHigh = buildThinkingPayload(
      { enabled: true, mode: 'qwen', effort: 'high' },
      'qwen-max-thinking',
      'https://dashscope.aliyuncs.com/api/v1'
    )
    expect(payloadHigh).toEqual({ enable_thinking: true, max_completion_tokens: 16384, reasoning_effort: 'high' })
  })
})
