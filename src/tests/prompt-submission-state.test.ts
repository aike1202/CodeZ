import { describe, expect, it } from 'vitest'
import type { ComposerImageAttachment } from '../shared/types/attachment'
import {
  mergeRejectedAttachments,
  restoreRejectedPromptText
} from '../renderer/src/components/PromptArea/promptSubmissionState'

function draft(id: string): ComposerImageAttachment {
  return {
    id,
    draftId: `draft-${id}`,
    kind: 'image',
    name: `${id}.png`,
    mimeType: 'image/png',
    width: 10,
    height: 10,
    sizeBytes: 100,
    storageKey: `attachment:drafts/${id}`,
    scope: 'draft'
  }
}

describe('prompt submission state', () => {
  it('restores a rejected prompt without overwriting newer input', () => {
    expect(restoreRejectedPromptText('', 'original')).toBe('original')
    expect(restoreRejectedPromptText('new input', 'original'))
      .toBe('original\n\nnew input')
    expect(restoreRejectedPromptText('new input', '')).toBe('new input')
    expect(restoreRejectedPromptText('  \n', 'original\n'))
      .toBe('original\n\n\n  \n')
  })

  it('restores rejected attachments while preserving and de-duplicating newer drafts', () => {
    const original = draft('original')
    const newer = draft('newer')

    expect(mergeRejectedAttachments([newer, original], [original]))
      .toEqual([newer, original])
    expect(mergeRejectedAttachments([newer], [original]))
      .toEqual([original, newer])
  })
})
