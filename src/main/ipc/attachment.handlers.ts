import { app, ipcMain } from 'electron'
import * as path from 'path'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type { ComposerImageAttachment } from '../../shared/types/attachment'
import { AttachmentService } from '../services/AttachmentService'
import { NativeImageCodec } from '../services/attachment/NativeImageCodec'

let attachmentService: AttachmentService | null = null

export function getAttachmentService(): AttachmentService {
  if (!attachmentService) {
    attachmentService = new AttachmentService(
      path.join(app.getPath('userData'), 'attachments'),
      new NativeImageCodec()
    )
  }
  return attachmentService
}

export async function deleteSessionWithAttachments(
  store: {
    get: (sessionId: string) => { isDeleted?: boolean } | undefined
    delete: (sessionId: string) => Promise<void>
  },
  attachments: Pick<AttachmentService, 'deleteSession'>,
  sessionId: string
): Promise<void> {
  const wasDeleted = store.get(sessionId)?.isDeleted === true
  await store.delete(sessionId)
  if (wasDeleted) await attachments.deleteSession(sessionId)
}

export function registerAttachmentIpc(): void {
  const service = getAttachmentService()

  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_IMPORT_DRAFT, async (_event, input) => {
    if (!(input?.bytes instanceof Uint8Array)) throw new Error('Invalid image byte payload')
    if (input.bytes.byteLength > 100 * 1024 * 1024) throw new Error('Image exceeds the import safety limit')
    return service.importDraft(input)
  })

  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_PROMOTE_DRAFTS,
    (_event, sessionId: string, attachments: ComposerImageAttachment[]) =>
      service.promoteDrafts(sessionId, attachments)
  )

  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_ROLLBACK_PROMOTION,
    (_event, sessionId: string, attachmentIds: string[]) =>
      service.rollbackPromotion(sessionId, attachmentIds)
  )

  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_DISCARD_DRAFTS,
    (_event, draftIds: string[]) => service.discardDrafts(draftIds)
  )

  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_READ_PREVIEW,
    (_event, attachment: ComposerImageAttachment, variant: 'thumbnail' | 'original') =>
      service.readPreview(attachment, variant)
  )
}
