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
    expect(payload).toEqual({ reasoning: { enabled: true } })
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
    expect(payload).toEqual({ reasoning: { enabled: true } })
  })
})
