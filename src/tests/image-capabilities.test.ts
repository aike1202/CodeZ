import { describe, expect, it } from 'vitest'
import { getProviderImagePolicy, supportsImageInput } from '../shared/utils/imageCapabilities'

describe('image capabilities', () => {
  it('requires an explicit vision opt-in', () => {
    expect(supportsImageInput(undefined)).toBe(false)
    expect(supportsImageInput({ supportsVision: false })).toBe(false)
    expect(supportsImageInput({ supportsVision: true })).toBe(true)
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
