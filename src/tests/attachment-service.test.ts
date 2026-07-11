import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { AttachmentService, type ImageCodec } from '../main/services/AttachmentService'
import { detectImageMime } from '../main/services/attachment/NativeImageCodec'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const codec: ImageCodec = {
  inspect: async (bytes) => ({ bytes, mimeType: 'image/jpeg', width: 800, height: 600 }),
  thumbnail: async () => new Uint8Array([9, 8, 7]),
  optimize: async (image, maxBytes) => ({
    ...image,
    bytes: image.bytes.slice(0, Math.max(1, Math.min(image.bytes.length, maxBytes)))
  })
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codez-attachments-'))
  roots.push(root)
  return { root, service: new AttachmentService(root, codec) }
}

describe('AttachmentService', () => {
  it('detects canonical MIME from bytes instead of trusting the file name', () => {
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg')
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      .toBe('image/png')
    expect(() => detectImageMime(new TextEncoder().encode('not an image'))).toThrow('Unsupported image format')
  })

  it('imports a draft and exposes thumbnail bytes without an absolute path', async () => {
    const { service } = await fixture()
    const draft = await service.importDraft({
      name: 'photo.jpg',
      declaredMimeType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3])
    })
    expect(draft).toMatchObject({ scope: 'draft', kind: 'image', mimeType: 'image/jpeg' })
    expect(draft.storageKey).not.toMatch(/^[A-Za-z]:[\\/]|^\//)
    await expect(service.readPreview(draft, 'thumbnail')).resolves.toMatchObject({
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([9, 8, 7])
    })
  })

  it('promotes by copying, keeps the draft for retry, and rolls back only copies', async () => {
    const { service } = await fixture()
    const draft = await service.importDraft({
      name: 'photo.jpg', declaredMimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3])
    })
    const [stored] = await service.promoteDrafts('session-1', [draft])
    await expect(service.readPreview(draft, 'original')).resolves.toBeTruthy()
    await service.rollbackPromotion('session-1', [stored.id])
    await expect(service.readPreview(stored, 'original')).rejects.toThrow('Attachment not found')
  })

  it('keeps live sessions and removes orphan session directories', async () => {
    const { root, service } = await fixture()
    const draft = await service.importDraft({
      name: 'photo.jpg', declaredMimeType: 'image/jpeg', bytes: new Uint8Array([1])
    })
    await service.promoteDrafts('live', [draft])
    await service.promoteDrafts('orphan', [draft])
    await service.cleanupOrphans(new Set(['live']))
    await expect(readFile(path.join(root, 'sessions', 'live', draft.id, 'original'))).resolves.toBeTruthy()
    await expect(readFile(path.join(root, 'sessions', 'orphan', draft.id, 'original'))).rejects.toThrow()
  })

  it('removes drafts after the retry window', async () => {
    const { service } = await fixture()
    const draft = await service.importDraft({
      name: 'photo.jpg', declaredMimeType: 'image/jpeg', bytes: new Uint8Array([1])
    })
    await service.cleanupOrphans(new Set(), Date.now() + 25 * 60 * 60 * 1000)
    await expect(service.readPreview(draft, 'original')).rejects.toThrow('Attachment not found')
  })

  it('validates and resolves a complete provider request in memory', async () => {
    const { service } = await fixture()
    const draft = await service.importDraft({
      name: 'photo.jpg', declaredMimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3])
    })
    const [stored] = await service.promoteDrafts('s1', [draft])
    const resolve = await service.prepareSessionImages('s1', [stored], {
      apiFormat: 'openai',
      acceptedMimeTypes: ['image/jpeg'],
      maxTotalBytes: 1024
    })
    await expect(resolve(stored)).resolves.toEqual({
      mimeType: 'image/jpeg',
      dataBase64: 'AQID'
    })
  })
})
