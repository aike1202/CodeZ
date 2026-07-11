import type { ApiFormat } from './provider'

export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface ImageAttachmentBase {
  id: string
  kind: 'image'
  name: string
  mimeType: ImageMimeType
  width: number
  height: number
  sizeBytes: number
  storageKey: string
}

export interface ImageAttachment extends ImageAttachmentBase {
  scope: 'session'
  sessionId: string
}

export interface DraftImageAttachment extends ImageAttachmentBase {
  scope: 'draft'
  draftId: string
}

export type ComposerImageAttachment = ImageAttachment | DraftImageAttachment

export interface AttachmentPreviewBytes {
  mimeType: ImageMimeType
  bytes: Uint8Array
}

export interface ResolvedImageAttachment {
  mimeType: ImageMimeType
  dataBase64: string
}

export type ResolveImageAttachment = (
  attachment: ImageAttachment
) => Promise<ResolvedImageAttachment>

export interface ProviderImagePolicy {
  apiFormat: ApiFormat
  acceptedMimeTypes: ImageMimeType[]
  maxImages?: number
  maxImageBytes?: number
  /** Budget for Base64-encoded image data in the request body. */
  maxTotalBytes: number
}

export interface PendingPromptDraft {
  text: string
  attachments: ComposerImageAttachment[]
}
