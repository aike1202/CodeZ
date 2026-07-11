import { nativeImage } from 'electron'
import type { ImageMimeType } from '../../../shared/types/attachment'
import type { DecodedImage, ImageCodec } from '../AttachmentService'

export function detectImageMime(bytes: Uint8Array): ImageMimeType {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  throw new Error('Unsupported image format')
}

export class NativeImageCodec implements ImageCodec {
  async inspect(bytes: Uint8Array): Promise<DecodedImage> {
    const mimeType = detectImageMime(bytes)
    const image = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (image.isEmpty()) throw new Error('Image cannot be decoded')
    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) throw new Error('Image has invalid dimensions')
    return { bytes, mimeType, width, height }
  }

  async thumbnail(image: DecodedImage): Promise<Uint8Array> {
    const source = nativeImage.createFromBuffer(Buffer.from(image.bytes))
    const scale = Math.min(1, 320 / Math.max(image.width, image.height))
    const resized = source.resize({
      width: Math.max(1, Math.round(image.width * scale)),
      height: Math.max(1, Math.round(image.height * scale)),
      quality: 'good'
    })
    return new Uint8Array(resized.toJPEG(80))
  }

  async optimize(image: DecodedImage, maxBytes: number): Promise<DecodedImage> {
    if (image.bytes.byteLength <= maxBytes) return image
    const source = nativeImage.createFromBuffer(Buffer.from(image.bytes))
    const longestEdge = Math.max(image.width, image.height)
    const targets = [4096, 3072, 2048, 1536, 1024]
    const qualities = [88, 80, 72, 64]

    for (const target of targets) {
      const scale = Math.min(1, target / longestEdge)
      const width = Math.max(1, Math.round(image.width * scale))
      const height = Math.max(1, Math.round(image.height * scale))
      const resized = source.resize({ width, height, quality: 'good' })
      for (const quality of qualities) {
        const bytes = new Uint8Array(resized.toJPEG(quality))
        if (bytes.byteLength <= maxBytes) {
          return { bytes, mimeType: 'image/jpeg', width, height }
        }
      }
    }
    throw Object.assign(new Error('Image cannot fit the provider limit'), {
      code: 'IMAGE_CANNOT_FIT_PROVIDER_LIMIT'
    })
  }
}
