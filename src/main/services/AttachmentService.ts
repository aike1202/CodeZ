import { randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  AttachmentPreviewBytes,
  ComposerImageAttachment,
  DraftImageAttachment,
  ImageAttachment,
  ImageMimeType,
  ProviderImagePolicy,
  ResolveImageAttachment
} from '../../shared/types/attachment'

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

export interface DecodedImage {
  bytes: Uint8Array
  mimeType: ImageMimeType
  width: number
  height: number
}

export interface ImageCodec {
  inspect(bytes: Uint8Array, declaredMimeType?: string): Promise<DecodedImage>
  thumbnail(image: DecodedImage): Promise<Uint8Array>
  optimize(image: DecodedImage, maxBytes: number): Promise<DecodedImage>
}

export interface ImportImageDraftInput {
  name: string
  declaredMimeType: string
  bytes: Uint8Array
}

interface AttachmentMetadata {
  attachment: ComposerImageAttachment
  createdAt: number
}

function encodedSize(sizeBytes: number): number {
  return Math.ceil(sizeBytes / 3) * 4
}

export class AttachmentService {
  constructor(
    private readonly rootPath: string,
    private readonly codec: ImageCodec
  ) {}

  async importDraft(input: ImportImageDraftInput): Promise<DraftImageAttachment> {
    if (!input.name.trim()) throw new Error('Image name is required')
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new Error('Image bytes are empty')
    }
    const decoded = await this.codec.inspect(input.bytes, input.declaredMimeType)
    const thumbnail = await this.codec.thumbnail(decoded)
    const id = randomUUID()
    const draftId = randomUUID()
    const storageKey = `attachment:drafts/${draftId}/${id}`
    const attachment: DraftImageAttachment = {
      id,
      draftId,
      scope: 'draft',
      kind: 'image',
      name: path.basename(input.name),
      mimeType: decoded.mimeType,
      width: decoded.width,
      height: decoded.height,
      sizeBytes: decoded.bytes.byteLength,
      storageKey
    }
    await this.writeAttachment(attachment, decoded.bytes, thumbnail)
    return attachment
  }

  async promoteDrafts(
    sessionId: string,
    attachments: ComposerImageAttachment[]
  ): Promise<ImageAttachment[]> {
    this.assertIdentifier(sessionId, 'session')
    const created: string[] = []
    try {
      const promoted: ImageAttachment[] = []
      for (const attachment of attachments) {
        if (attachment.scope === 'session') {
          this.assertSessionAttachment(sessionId, attachment)
          promoted.push({ ...attachment })
          continue
        }
        this.assertAttachmentReference(attachment)
        const destinationKey = `attachment:sessions/${sessionId}/${attachment.id}`
        const sourceDir = this.directoryFor(attachment.storageKey)
        const destinationDir = this.directoryFor(destinationKey)
        await fs.mkdir(path.dirname(destinationDir), { recursive: true })
        await fs.cp(sourceDir, destinationDir, { recursive: true, errorOnExist: true, force: false })
        created.push(attachment.id)
        const stored: ImageAttachment = {
          id: attachment.id,
          kind: 'image',
          name: attachment.name,
          mimeType: attachment.mimeType,
          width: attachment.width,
          height: attachment.height,
          sizeBytes: attachment.sizeBytes,
          scope: 'session',
          sessionId,
          storageKey: destinationKey
        }
        await this.writeMetadata(stored)
        promoted.push(stored)
      }
      return promoted
    } catch (error) {
      await this.rollbackPromotion(sessionId, created)
      throw error
    }
  }

  async rollbackPromotion(sessionId: string, attachmentIds: string[]): Promise<void> {
    this.assertIdentifier(sessionId, 'session')
    await Promise.all(attachmentIds.map(async (id) => {
      this.assertIdentifier(id, 'attachment')
      await fs.rm(this.directoryFor(`attachment:sessions/${sessionId}/${id}`), {
        recursive: true,
        force: true
      })
    }))
  }

  async discardDrafts(draftIds: string[]): Promise<void> {
    await Promise.all(draftIds.map(async (draftId) => {
      this.assertIdentifier(draftId, 'draft')
      const target = path.resolve(this.rootPath, 'drafts', draftId)
      this.assertContained(target)
      await fs.rm(target, { recursive: true, force: true })
    }))
  }

  async readPreview(
    attachment: ComposerImageAttachment,
    variant: 'thumbnail' | 'original'
  ): Promise<AttachmentPreviewBytes> {
    this.assertAttachmentReference(attachment)
    try {
      const bytes = new Uint8Array(await fs.readFile(this.pathFor(attachment.storageKey, variant)))
      return {
        mimeType: variant === 'thumbnail' ? 'image/jpeg' : attachment.mimeType,
        bytes
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Attachment not found')
      throw error
    }
  }

  async prepareSessionImages(
    sessionId: string,
    attachments: ImageAttachment[],
    policy: ProviderImagePolicy
  ): Promise<ResolveImageAttachment> {
    this.assertIdentifier(sessionId, 'session')
    if (policy.maxImages !== undefined && attachments.length > policy.maxImages) {
      throw Object.assign(new Error(`Too many images for ${policy.apiFormat}`), { code: 'IMAGE_COUNT_LIMIT' })
    }

    const decodedById = new Map<string, DecodedImage>()
    for (const attachment of attachments) {
      this.assertSessionAttachment(sessionId, attachment)
      if (decodedById.has(attachment.id)) continue
      let decoded = await this.codec.inspect(
        new Uint8Array(await fs.readFile(this.pathFor(attachment.storageKey, 'original'))),
        attachment.mimeType
      )
      if (!policy.acceptedMimeTypes.includes(decoded.mimeType)) {
        decoded = await this.codec.optimize(decoded, policy.maxImageBytes || decoded.bytes.byteLength)
      }
      if (policy.maxImageBytes !== undefined && decoded.bytes.byteLength > policy.maxImageBytes) {
        decoded = await this.codec.optimize(decoded, policy.maxImageBytes)
      }
      decodedById.set(attachment.id, decoded)
    }

    const totalEncodedBytes = () => attachments.reduce(
      (total, attachment) => total + encodedSize(decodedById.get(attachment.id)!.bytes.byteLength),
      0
    )
    if (attachments.length > 0 && totalEncodedBytes() > policy.maxTotalBytes) {
      const rawTarget = Math.max(1, Math.floor((policy.maxTotalBytes / attachments.length) * 0.75))
      for (const [id, decoded] of decodedById) {
        if (decoded.bytes.byteLength > rawTarget) {
          decodedById.set(id, await this.codec.optimize(decoded, rawTarget))
        }
      }
    }
    if (totalEncodedBytes() > policy.maxTotalBytes) {
      throw Object.assign(new Error(`Images exceed the ${policy.apiFormat} request limit`), {
        code: 'IMAGE_REQUEST_TOO_LARGE'
      })
    }

    return async (attachment) => {
      this.assertSessionAttachment(sessionId, attachment)
      const decoded = decodedById.get(attachment.id)
      if (!decoded) throw new Error('Attachment was not prepared for this request')
      return {
        mimeType: decoded.mimeType,
        dataBase64: Buffer.from(decoded.bytes).toString('base64')
      }
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertIdentifier(sessionId, 'session')
    const target = path.resolve(this.rootPath, 'sessions', sessionId)
    this.assertContained(target)
    await fs.rm(target, { recursive: true, force: true })
  }

  async cleanupOrphans(liveSessionIds: Set<string>, now = Date.now()): Promise<void> {
    const sessionRoot = path.resolve(this.rootPath, 'sessions')
    for (const entry of await this.readDirectories(sessionRoot)) {
      if (!liveSessionIds.has(entry)) {
        await fs.rm(path.join(sessionRoot, entry), { recursive: true, force: true })
      }
    }

    const draftRoot = path.resolve(this.rootPath, 'drafts')
    for (const draftId of await this.readDirectories(draftRoot)) {
      const draftDir = path.join(draftRoot, draftId)
      const attachmentIds = await this.readDirectories(draftDir)
      const metaPath = attachmentIds[0] ? path.join(draftDir, attachmentIds[0], 'meta.json') : ''
      let createdAt = 0
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as AttachmentMetadata
        createdAt = Number(meta.createdAt || 0)
      } catch {
        createdAt = 0
      }
      if (now - createdAt > DRAFT_TTL_MS) {
        await fs.rm(draftDir, { recursive: true, force: true })
      }
    }
  }

  private async writeAttachment(
    attachment: ComposerImageAttachment,
    original: Uint8Array,
    thumbnail: Uint8Array
  ): Promise<void> {
    const finalDir = this.directoryFor(attachment.storageKey)
    const tempDir = `${finalDir}.tmp-${randomUUID()}`
    await fs.mkdir(tempDir, { recursive: true })
    try {
      await Promise.all([
        fs.writeFile(path.join(tempDir, 'original'), original),
        fs.writeFile(path.join(tempDir, 'thumbnail'), thumbnail),
        fs.writeFile(path.join(tempDir, 'meta.json'), JSON.stringify({
          attachment,
          createdAt: Date.now()
        } satisfies AttachmentMetadata), 'utf8')
      ])
      await fs.mkdir(path.dirname(finalDir), { recursive: true })
      await fs.rename(tempDir, finalDir)
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true })
      throw error
    }
  }

  private async writeMetadata(attachment: ImageAttachment): Promise<void> {
    const metaPath = this.pathFor(attachment.storageKey, 'meta.json')
    let createdAt = Date.now()
    try {
      const existing = JSON.parse(await fs.readFile(metaPath, 'utf8')) as AttachmentMetadata
      createdAt = existing.createdAt || createdAt
    } catch {
      // The copied original and thumbnail remain authoritative.
    }
    await fs.writeFile(metaPath, JSON.stringify({ attachment, createdAt } satisfies AttachmentMetadata), 'utf8')
  }

  private assertSessionAttachment(sessionId: string, attachment: ImageAttachment): void {
    if (attachment.scope !== 'session' || attachment.sessionId !== sessionId) {
      throw new Error('Attachment does not belong to this session')
    }
    this.assertAttachmentReference(attachment)
  }

  private assertAttachmentReference(attachment: ComposerImageAttachment): void {
    this.assertIdentifier(attachment.id, 'attachment')
    const expected = attachment.scope === 'draft'
      ? `attachment:drafts/${attachment.draftId}/${attachment.id}`
      : `attachment:sessions/${attachment.sessionId}/${attachment.id}`
    if (attachment.storageKey !== expected) throw new Error('Invalid attachment storage key')
  }

  private assertIdentifier(value: string, label: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${label} identifier`)
  }

  private directoryFor(storageKey: string): string {
    if (!storageKey.startsWith('attachment:')) throw new Error('Invalid attachment storage key')
    const resolved = path.resolve(this.rootPath, storageKey.slice('attachment:'.length))
    this.assertContained(resolved)
    return resolved
  }

  private pathFor(storageKey: string, variant: string): string {
    const resolved = path.resolve(this.directoryFor(storageKey), variant)
    this.assertContained(resolved)
    return resolved
  }

  private assertContained(target: string): void {
    const root = path.resolve(this.rootPath)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('Invalid attachment storage key')
    }
  }

  private async readDirectories(root: string): Promise<string[]> {
    try {
      return (await fs.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
