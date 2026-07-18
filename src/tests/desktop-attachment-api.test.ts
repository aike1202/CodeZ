import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
  }
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

import { desktopApi } from '../renderer/src/shared/desktop/api'

const draft = {
  id: 'draft-image-1',
  kind: 'image',
  name: 'diagram.png',
  mimeType: 'image/png',
  width: 128,
  height: 64,
  sizeBytes: 3,
  storageKey: 'attachment:drafts/draft-1/draft-image-1',
  scope: 'draft',
  draftId: 'draft-1'
} as const

const sessionAttachment = {
  id: 'session-image-1',
  kind: 'image',
  name: 'diagram.png',
  mimeType: 'image/png',
  width: 128,
  height: 64,
  sizeBytes: 3,
  storageKey: 'attachment:sessions/session-1/session-image-1',
  scope: 'session',
  sessionId: 'session-1'
} as const

let originalWindow: unknown

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
    writable: true
  })
}

describe('desktop attachment adapter', () => {
  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    tauriMocks.invoke.mockReset()
  })

  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window')
      return
    }
    setWindow(originalWindow)
  })

  it('maps attachment lifecycle and preview operations to Tauri commands', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce([sessionAttachment])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ mimeType: 'image/png', bytes: [137, 80, 78, 71] })

    await expect(
      desktopApi.attachment.importDraft('diagram.png', 'image/png', new Uint8Array([1, 2, 3]))
    ).resolves.toEqual(draft)
    await expect(desktopApi.attachment.promoteDrafts('session-1', [draft])).resolves.toEqual([
      sessionAttachment
    ])
    await desktopApi.attachment.rollbackPromotion('session-1', [sessionAttachment.id])
    await desktopApi.attachment.discardDrafts([draft.draftId])
    await expect(desktopApi.attachment.readPreview(sessionAttachment, 'thumbnail')).resolves.toEqual({
      mimeType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71])
    })
    expect(tauriMocks.invoke.mock.calls).toEqual([
      ['attachment_import_draft', {
        name: 'diagram.png',
        declaredMimeType: 'image/png',
        bytes: [1, 2, 3]
      }],
      ['attachment_promote_drafts', { sessionId: 'session-1', attachments: [draft] }],
      ['attachment_rollback_promotion', {
        sessionId: 'session-1',
        attachmentIds: [sessionAttachment.id]
      }],
      ['attachment_discard_drafts', { draftIds: [draft.draftId] }],
      ['attachment_read_preview', { attachment: sessionAttachment, variant: 'thumbnail' }]
    ])
  })

  it('rejects unsupported preview MIME types before they reach renderer components', async () => {
    setWindow({ __TAURI_INTERNALS__: {} })
    tauriMocks.invoke.mockResolvedValueOnce({ mimeType: 'image/gif', bytes: [1] })

    await expect(
      desktopApi.attachment.readPreview(sessionAttachment, 'thumbnail')
    ).rejects.toThrow('unsupported attachment MIME type')
  })
})
