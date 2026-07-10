import { describe, it, expect } from 'vitest'
import { buildThinkingPayload } from '../main/services/chat/utils'
import { processDeltaWithThinkTags, ThinkParserState } from '../main/services/chat/OpenAIProvider'
import { mapAnthropicStopReason, extractAnthropicDelta } from '../main/services/chat/AnthropicProvider'

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
      'http://127.0.0.1:8045/v1',
      false,
      'gemini'
    )
    expect(payload).toEqual({
      google: { thinkingConfig: { includeThoughts: true } }
    })
  })

  it('does not enable reasoning for known non-reasoning models through OpenRouter', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'auto' },
      'gpt-4o',
      'https://openrouter.ai/api/v1'
    )
    expect(payload).toEqual({})
  })

  it('uses documented OpenAI and Grok reasoning_effort values', () => {
    expect(buildThinkingPayload(
      { enabled: true, mode: 'openai', effort: 'max' },
      'gpt-5.6',
      'https://api.openai.com/v1'
    )).toEqual({ reasoning_effort: 'max' })

    expect(buildThinkingPayload(
      { enabled: true, mode: 'grok', effort: 'high' },
      'grok-4.5',
      'https://api.x.ai/v1'
    )).toEqual({ reasoning_effort: 'high' })
  })

  it('uses OpenRouter unified reasoning effort', () => {
    expect(buildThinkingPayload(
      { enabled: true, mode: 'auto', effort: 'xhigh' },
      'anthropic/claude-opus-4.8',
      'https://openrouter.ai/api/v1'
    )).toEqual({ reasoning: { effort: 'xhigh' } })

    expect(buildThinkingPayload(
      { enabled: true, mode: 'auto', effort: 'high' },
      'openai/o3',
      'https://openrouter.ai/api/v1'
    )).toEqual({ reasoning: { effort: 'high' } })
  })

  it('uses OpenRouter unified reasoning token budgets', () => {
    expect(buildThinkingPayload(
      { enabled: true, mode: 'auto', effort: 'custom', budgetTokens: 8192 },
      'anthropic/claude-3.7-sonnet',
      'https://openrouter.ai/api/v1'
    )).toEqual({ reasoning: { max_tokens: 8192 } })

    expect(buildThinkingPayload(
      { enabled: true, mode: 'auto', effort: 'low', budgetTokens: 8192 },
      'anthropic/claude-opus-4.5',
      'https://openrouter.ai/api/v1'
    )).toEqual({ reasoning: { max_tokens: 8192 } })
  })

  it('uses adaptive thinking for Claude Opus 4.8 without budget_tokens', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'anthropic', effort: 'high' },
      'claude-opus-4-8',
      'https://api.anthropic.com/v1'
    )

    expect(payload).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' }
    })
    expect(JSON.stringify(payload)).not.toContain('budget_tokens')
  })

  it('uses adaptive thinking for Claude Sonnet 5 custom effort without custom budget_tokens', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'anthropic', effort: 'custom', budgetTokens: 2000 },
      'claude-sonnet-5',
      'https://api.anthropic.com/v1'
    )

    expect(payload).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' }
    })
    expect(JSON.stringify(payload)).not.toContain('budget_tokens')
  })

  it('infers adaptive Anthropic thinking for Claude Fable 5 in auto mode', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'auto', effort: 'medium' },
      'claude-fable-5',
      'https://api.anthropic.com/v1'
    )

    expect(payload).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' }
    })
    expect(JSON.stringify(payload)).not.toContain('budget_tokens')
  })

  it('uses adaptive thinking with effort for Claude Mythos Preview', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'anthropic', effort: 'max' },
      'claude-mythos-preview',
      'https://api.anthropic.com/v1'
    )

    expect(payload).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'max' }
    })
    expect(JSON.stringify(payload)).not.toContain('budget_tokens')
  })

  it('应当在 mode 为 auto 时，基于 model 自动选用 deepseek 配置', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'auto' },
      'deepseek-r1-chat',
      'https://api.deepseek.com/v1'
    )
    expect(payload).toEqual({ thinking: { type: 'enabled' } })
  })

  it('应当在 mode 为 auto 时，基于 model 自动选用 qwen 配置', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'auto' },
      'qwen-max-thinking',
      'https://dashscope.aliyuncs.com/api/v1'
    )
    expect(payload).toEqual({ enable_thinking: true })
  })

  it('应当直接输出显式指定的模式配置，不进行推导', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'deepseek' },
      'gemini-3.5-flash-high',
      'http://127.0.0.1:8045/v1'
    )
    expect(payload).toEqual({ thinking: { type: 'enabled' } })
  })

  it('only sends token budgets to providers that document token budgets', () => {
    const payload = buildThinkingPayload(
      { enabled: true, mode: 'deepseek', budgetTokens: 2000, effort: 'custom' },
      'deepseek-r1-chat',
      'https://api.deepseek.com/v1'
    )
    expect(payload).toEqual({ thinking: { type: 'enabled' } })

    const payloadQwen = buildThinkingPayload(
      { enabled: true, mode: 'qwen', budgetTokens: 2000, effort: 'custom' },
      'qwen3.7-plus',
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    )
    expect(payloadQwen).toEqual({ enable_thinking: true, thinking_budget: 2000 })

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
    expect(payloadLow).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } })

    // Medium -> 4096 (Deepseek mode)
    const payloadMedium = buildThinkingPayload(
      { enabled: true, mode: 'deepseek', effort: 'medium' },
      'deepseek-r1',
      'https://api.deepseek.com/v1'
    )
    expect(payloadMedium).toEqual({ thinking: { type: 'enabled' } })

    // High -> 16384 (Qwen mode)
    const payloadHigh = buildThinkingPayload(
      { enabled: true, mode: 'qwen', effort: 'high' },
      'qwen-max-thinking',
      'https://dashscope.aliyuncs.com/api/v1'
    )
    expect(payloadHigh).toEqual({ enable_thinking: true, thinking_budget: 16384 })
  })

  it('uses native and OpenAI-compatible Gemini reasoning fields', () => {
    expect(buildThinkingPayload(
      { enabled: true, mode: 'gemini', effort: 'low' },
      'gemini-3.5-flash',
      'https://generativelanguage.googleapis.com/v1beta',
      false,
      'gemini'
    )).toEqual({
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' }
      }
    })

    expect(buildThinkingPayload(
      { enabled: true, mode: 'gemini', effort: 'minimal' },
      'gemini-2.5-flash',
      'https://generativelanguage.googleapis.com/v1beta/openai',
      false,
      'openai'
    )).toEqual({ reasoning_effort: 'minimal' })
  })
})

describe('AnthropicProvider - stream helpers', () => {
  it('maps Anthropic stop_reason values to internal stop reasons', () => {
    expect(mapAnthropicStopReason('end_turn')).toBe('stop')
    expect(mapAnthropicStopReason('stop_sequence')).toBe('stop')
    expect(mapAnthropicStopReason('max_tokens')).toBe('length')
    expect(mapAnthropicStopReason('tool_use')).toBe('tool_calls')
    expect(mapAnthropicStopReason('refusal')).toBe('content_filter')
    expect(mapAnthropicStopReason('safety')).toBe('content_filter')
    expect(mapAnthropicStopReason('pause_turn')).toBe('tool_calls')
    expect(mapAnthropicStopReason('unknown_reason')).toBe('unknown')
  })

  it('extracts text from Anthropic text_delta', () => {
    expect(extractAnthropicDelta({ type: 'text_delta', text: 'hello' })).toEqual({
      textDelta: 'hello',
      reasoningDelta: '',
      toolInputDelta: ''
    })
  })

  it('extracts reasoning from Anthropic thinking_delta', () => {
    expect(extractAnthropicDelta({ type: 'thinking_delta', thinking: 'reasoning' })).toEqual({
      textDelta: '',
      reasoningDelta: 'reasoning',
      toolInputDelta: ''
    })
  })

  it('extracts partial JSON from Anthropic tool input deltas', () => {
    expect(extractAnthropicDelta({ type: 'tool_use_input_delta', partial_json: '{"a"' })).toEqual({
      textDelta: '',
      reasoningDelta: '',
      toolInputDelta: '{"a"'
    })

    expect(extractAnthropicDelta({ type: 'input_json_delta', partial_json: ':1}' })).toEqual({
      textDelta: '',
      reasoningDelta: '',
      toolInputDelta: ':1}'
    })
  })
})
