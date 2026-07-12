import { describe, expect, it } from 'vitest'
import {
  evaluateImageSendState,
  nextPreviewIndex
} from '../renderer/src/components/chat/imageAttachmentState'
import {
  getSessionComposerDraft,
  setSessionComposerDraft
} from '../renderer/src/stores/chatStore/composerDrafts'

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

    expect(evaluateImageSendState({
      text: 'continue',
      attachmentCount: 0,
      importing: false,
      supportsVision: true,
      blockedReason: '当前会话仍在运行'
    })).toEqual({ canSend: false, reason: '当前会话仍在运行' })
  })

  it('wraps preview navigation', () => {
    expect(nextPreviewIndex(0, 3, -1)).toBe(2)
    expect(nextPreviewIndex(2, 3, 1)).toBe(0)
  })

  it('keeps text and images isolated by session', () => {
    const attachment = {
      id: 'image-a', draftId: 'draft-a', scope: 'draft' as const, kind: 'image' as const,
      name: 'a.png', mimeType: 'image/png' as const, width: 10, height: 10, sizeBytes: 100,
      storageKey: 'attachment:drafts/draft-a/image-a'
    }
    const drafts = setSessionComposerDraft({}, 'session-a', {
      text: 'only in A',
      attachments: [attachment]
    })

    expect(getSessionComposerDraft(drafts, 'session-b')).toEqual({ text: '', attachments: [] })
    expect(getSessionComposerDraft(drafts, 'session-a')).toEqual({
      text: 'only in A',
      attachments: [attachment]
    })
  })
})
