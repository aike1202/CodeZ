import { describe, expect, it } from 'vitest'
import {
  getImageInputCapability,
  getProviderImagePolicy,
  inferImageInputSupport,
  supportsImageInput
} from '../shared/utils/imageCapabilities'

describe('image capabilities', () => {
  it('uses an explicit user setting before model defaults', () => {
    expect(supportsImageInput(undefined)).toBe(false)
    expect(supportsImageInput({ name: 'gpt-5.6-sol', supportsVision: false })).toBe(false)
    expect(supportsImageInput({ name: 'unknown-model', supportsVision: true })).toBe(true)
  })

  it('recognizes current multimodal model families', () => {
    expect(inferImageInputSupport('gpt-5.4')).toBe(true)
    expect(inferImageInputSupport('gpt-5.5')).toBe(true)
    expect(inferImageInputSupport('gpt-5.6-sol')).toBe(true)
    expect(inferImageInputSupport('gpt-5.6-luna')).toBe(true)
    expect(inferImageInputSupport('gpt-5.6-terra')).toBe(true)
    expect(inferImageInputSupport('openai/gpt-4.1-mini')).toBe(true)
    expect(inferImageInputSupport('anthropic/claude-sonnet-4-5')).toBe(true)
    expect(inferImageInputSupport('models/gemini-3.5-flash')).toBe(true)
    expect(inferImageInputSupport('gemini-pro-vision')).toBe(true)
    expect(inferImageInputSupport('qwen2.5-vl-72b')).toBe(true)
  })

  it('recognizes Chinese multimodal model families', () => {
    expect(inferImageInputSupport('qwen3.6-plus')).toBe(true)
    expect(inferImageInputSupport('qwen3-vl-235b-a22b-instruct')).toBe(true)
    expect(inferImageInputSupport('qvq-max')).toBe(true)
    expect(inferImageInputSupport('qwen3.5-omni-flash')).toBe(true)
    expect(inferImageInputSupport('glm-4.6v-flash')).toBe(true)
    expect(inferImageInputSupport('glm-5v-turbo')).toBe(true)
    expect(inferImageInputSupport('kimi-k2.5')).toBe(true)
    expect(inferImageInputSupport('kimi-k2.7-code')).toBe(true)
    expect(inferImageInputSupport('MiniMax-M3')).toBe(true)
    expect(inferImageInputSupport('MiMo-V2.5')).toBe(true)
    expect(inferImageInputSupport('step-2v-mini')).toBe(true)
    expect(inferImageInputSupport('baichuan-omni-1.5')).toBe(true)
    expect(inferImageInputSupport('deepseek-vl2')).toBe(true)
    expect(inferImageInputSupport('internvl3-78b')).toBe(true)
    expect(inferImageInputSupport('doubao-1-5-vision-pro-32k')).toBe(true)
  })

  it('recognizes common Chinese text-only models', () => {
    expect(inferImageInputSupport('deepseek-chat')).toBe(false)
    expect(inferImageInputSupport('deepseek-reasoner')).toBe(false)
    expect(inferImageInputSupport('qwen-plus')).toBe(false)
    expect(inferImageInputSupport('glm-5')).toBe(false)
    expect(inferImageInputSupport('glm-5.2')).toBe(false)
    expect(inferImageInputSupport('MiniMax-M2.5')).toBe(false)
    expect(inferImageInputSupport('MiMo-V2.5-Pro')).toBe(false)
    expect(inferImageInputSupport('moonshot-v1-128k')).toBe(false)
    expect(inferImageInputSupport('kimi-k2-thinking')).toBe(false)
    expect(getImageInputCapability({ name: 'deepseek-chat' })).toEqual({
      supported: false,
      source: 'model-default'
    })
  })

  it('keeps known text-only and unknown models disabled by default', () => {
    expect(inferImageInputSupport('gpt-3.5-turbo')).toBe(false)
    expect(inferImageInputSupport('o3-mini')).toBe(false)
    expect(inferImageInputSupport('claude-2.1')).toBe(false)
    expect(inferImageInputSupport('text-embedding-3-large')).toBe(false)
    expect(supportsImageInput({ name: 'custom-china-model' })).toBe(false)
    expect(getImageInputCapability({ name: 'custom-china-model' }).source).toBe('unknown')
  })

  it('does not infer unknown aliases from the provider protocol', () => {
    expect(supportsImageInput({ name: 'vendor-current' })).toBe(false)
    expect(supportsImageInput({ name: 'text-embedding-004' })).toBe(false)
  })

  it('provides protocol-specific limits without a renderer-only global limit', () => {
    expect(getProviderImagePolicy('openai')).toMatchObject({
      acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxImages: 500,
      maxTotalBytes: 50 * 1024 * 1024
    })
    expect(getProviderImagePolicy('anthropic')).toMatchObject({
      maxImages: 100,
      maxImageBytes: 5 * 1024 * 1024
    })
    expect(getProviderImagePolicy('gemini')).toMatchObject({
      maxTotalBytes: 20 * 1024 * 1024
    })
  })
})
