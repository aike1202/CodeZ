import { describe, expect, it } from 'vitest'
import {
  getReasoningCapabilities,
  mergeModelThinkingConfig,
  resolveReasoningBudgetTokens
} from '../shared/utils/reasoningCapabilities'

const openAI = (model: string) => getReasoningCapabilities({
  model,
  apiFormat: 'openai',
  baseUrl: 'https://api.openai.com/v1'
})

describe('reasoning capabilities', () => {
  it('exposes the documented GPT-5.6 effort levels', () => {
    expect(openAI('gpt-5.6')).toMatchObject({
      mode: 'openai',
      control: 'effort',
      efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max']
    })
  })

  it('hides reasoning controls for known non-reasoning OpenAI models', () => {
    expect(openAI('gpt-4o').control).toBe('none')
    expect(openAI('gpt-4.1').control).toBe('none')
  })

  it('allows a conservative effort set for explicit OpenAI-compatible overrides', () => {
    expect(getReasoningCapabilities({
      model: 'local-reasoner-v2',
      apiFormat: 'openai',
      baseUrl: 'http://localhost:8000/v1',
      mode: 'openai'
    }).efforts).toEqual(['low', 'medium', 'high'])

    expect(getReasoningCapabilities({
      model: 'local-reasoner-v2',
      apiFormat: 'openai',
      baseUrl: 'http://localhost:8000/v1'
    }).control).toBe('none')
  })

  it('uses model-specific Claude effort subsets', () => {
    expect(getReasoningCapabilities({
      model: 'claude-opus-4-8',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com'
    }).efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])

    expect(getReasoningCapabilities({
      model: 'claude-sonnet-4-6',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com'
    }).efforts).toEqual(['low', 'medium', 'high', 'max'])

    expect(getReasoningCapabilities({
      model: 'claude-3-7-sonnet',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com'
    }).control).toBe('budget')

    expect(getReasoningCapabilities({
      model: 'claude-3-5-sonnet',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com'
    }).control).toBe('none')

    expect(getReasoningCapabilities({
      model: 'custom-claude-compatible',
      apiFormat: 'anthropic',
      baseUrl: 'http://localhost:8000',
      mode: 'anthropic'
    }).control).toBe('budget')
  })

  it('uses thinking levels for Gemini 3 and budgets for Gemini 2.5 native', () => {
    expect(getReasoningCapabilities({
      model: 'gemini-3.5-flash',
      apiFormat: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com'
    }).efforts).toEqual(['minimal', 'low', 'medium', 'high'])

    expect(getReasoningCapabilities({
      model: 'gemini-3.1-pro-preview',
      apiFormat: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com'
    }).efforts).toEqual(['low', 'medium', 'high'])

    expect(getReasoningCapabilities({
      model: 'gemini-2.5-flash',
      apiFormat: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com'
    })).toMatchObject({
      control: 'budget',
      budgetPresets: [1024, 4096, 8192, 16384, 24576]
    })

    expect(getReasoningCapabilities({
      model: 'gemini-1.5-pro',
      apiFormat: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com'
    }).control).toBe('none')

    expect(getReasoningCapabilities({
      model: 'custom-gemini-compatible',
      apiFormat: 'gemini',
      baseUrl: 'http://localhost:8000',
      mode: 'gemini'
    }).control).toBe('toggle')
  })

  it('maps Gemini OpenAI compatibility to reasoning_effort options', () => {
    expect(getReasoningCapabilities({
      model: 'gemini-2.5-flash',
      apiFormat: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'
    }).efforts).toEqual(['none', 'minimal', 'low', 'medium', 'high'])

    expect(getReasoningCapabilities({
      model: 'gemini-1.5-pro',
      apiFormat: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'
    }).control).toBe('none')

    expect(getReasoningCapabilities({
      model: 'custom-gemini-compatible',
      apiFormat: 'openai',
      baseUrl: 'http://localhost:8000/v1',
      mode: 'gemini'
    }).efforts).toEqual(['low', 'medium', 'high'])
  })

  it('limits DeepSeek V4 to high and max while older reasoning models are toggle-only', () => {
    expect(getReasoningCapabilities({
      model: 'deepseek-v4-pro',
      apiFormat: 'openai',
      baseUrl: 'https://api.deepseek.com'
    }).efforts).toEqual(['high', 'max'])

    expect(getReasoningCapabilities({
      model: 'deepseek-r1',
      apiFormat: 'openai',
      baseUrl: 'https://api.deepseek.com'
    }).control).toBe('toggle')
  })

  it('uses token budgets for Qwen thinking models', () => {
    expect(getReasoningCapabilities({
      model: 'qwen3.7-plus',
      apiFormat: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    })).toMatchObject({
      mode: 'qwen',
      control: 'budget',
      supportsBudget: true
    })
  })

  it('uses the documented Grok effort subsets', () => {
    expect(getReasoningCapabilities({
      model: 'grok-4.5',
      apiFormat: 'openai',
      baseUrl: 'https://api.x.ai/v1'
    })).toMatchObject({
      control: 'effort',
      efforts: ['low', 'medium', 'high'],
      mandatory: true
    })

    expect(getReasoningCapabilities({
      model: 'grok-4.3',
      apiFormat: 'openai',
      baseUrl: 'https://api.x.ai/v1'
    }).efforts).toEqual(['none', 'low', 'medium', 'high'])
  })

  it('uses model-specific controls through OpenRouter', () => {
    expect(getReasoningCapabilities({
      model: 'anthropic/claude-opus-4.8',
      apiFormat: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1'
    })).toMatchObject({
      mode: 'openrouter',
      control: 'effort',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max']
    })

    expect(getReasoningCapabilities({
      model: 'openai/gpt-4o',
      apiFormat: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1'
    }).control).toBe('none')

    expect(getReasoningCapabilities({
      model: 'openai/o3',
      apiFormat: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1'
    }).efforts).toEqual(['low', 'medium', 'high'])
  })

  it('merges model overrides without leaking provider defaults', () => {
    const merged = mergeModelThinkingConfig(
      { enabled: true, mode: 'auto', effort: 'low', budgetTokens: 8192 },
      {
        id: 'm1',
        name: 'qwen3.7-plus',
        maxContextTokens: 128000,
        thinkingEffort: 'auto',
        thinkingBudgetTokens: null
      }
    )

    expect(merged).toEqual({
      enabled: true,
      mode: 'auto',
      effort: 'auto',
      budgetTokens: undefined
    })
    expect(resolveReasoningBudgetTokens(merged)).toBeUndefined()
  })

  it('prefers an explicit token budget when effort and budget are both supported', () => {
    expect(resolveReasoningBudgetTokens({
      enabled: true,
      mode: 'anthropic',
      effort: 'low',
      budgetTokens: 8192
    })).toBe(8192)

    expect(getReasoningCapabilities({
      model: 'claude-opus-4-5',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com'
    })).toMatchObject({
      control: 'effort',
      supportsBudget: true
    })

    expect(mergeModelThinkingConfig(
      { enabled: true, mode: 'auto', effort: 'auto', budgetTokens: 8192 },
      {
        id: 'm2',
        name: 'anthropic/claude-opus-4.5',
        maxContextTokens: 200000,
        thinkingEffort: 'high',
        thinkingBudgetTokens: null
      }
    )).toEqual({
      enabled: true,
      mode: 'auto',
      effort: 'high',
      budgetTokens: undefined
    })
  })
})
