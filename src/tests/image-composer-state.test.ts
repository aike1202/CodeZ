import { describe, expect, it } from 'vitest'
import {
  evaluateImageSendState,
  nextPreviewIndex
} from '../renderer/src/components/chat/imageAttachmentState'

describe('image composer state', () => {
  it('allows image-only sends and blocks importing or unsupported models', () => {
    expect(evaluateImageSendState({
      text: '',
      attachmentCount: 1,
      importing: false,
      supportsVision: true
    })).toEqual({ canSend: true, reason: null })

    expect(evaluateImageSendState({
      text: '',
      attachmentCount: 1,
      importing: true,
      supportsVision: true
    }).canSend).toBe(false)

    expect(evaluateImageSendState({
      text: 'inspect',
      attachmentCount: 1,
      importing: false,
      supportsVision: false
    }).reason).toBe('当前模型未启用图片输入')
  })

  it('wraps preview navigation', () => {
    expect(nextPreviewIndex(0, 3, -1)).toBe(2)
    expect(nextPreviewIndex(2, 3, 1)).toBe(0)
  })
})
