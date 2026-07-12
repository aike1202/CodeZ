import { describe, expect, it } from 'vitest'
import { normalizePreviewBytes } from '../renderer/src/components/chat/attachmentPreviewBytes'

describe('attachment preview byte normalization', () => {
  it('keeps structured-clone typed arrays intact', () => {
    expect(normalizePreviewBytes(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('restores contextBridge indexed objects', () => {
    expect(normalizePreviewBytes({ 0: 0x89, 1: 0x50, 2: 0x4e, 3: 0x47 }))
      .toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  it('restores Buffer-style and array payloads', () => {
    expect(normalizePreviewBytes({ type: 'Buffer', data: [9, 8, 7] }))
      .toEqual(new Uint8Array([9, 8, 7]))
    expect(normalizePreviewBytes([6, 5, 4])).toEqual(new Uint8Array([6, 5, 4]))
  })

  it('rejects empty or unsupported payloads', () => {
    expect(() => normalizePreviewBytes({})).toThrow('Invalid attachment preview byte payload')
    expect(() => normalizePreviewBytes(null)).toThrow('Invalid attachment preview byte payload')
  })
})
