export function normalizePreviewBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Array.isArray(value)) return Uint8Array.from(value)

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Array.isArray(record.data)) return Uint8Array.from(record.data)

    const indexedBytes = Object.entries(record)
      .filter(([key, byte]) => /^\d+$/.test(key) && typeof byte === 'number')
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, byte]) => byte as number)
    if (indexedBytes.length > 0) return Uint8Array.from(indexedBytes)
  }

  throw new Error('Invalid attachment preview byte payload')
}

export function createPreviewObjectUrl(value: unknown, mimeType: string): string {
  const bytes = normalizePreviewBytes(value)
  if (bytes.byteLength === 0) throw new Error('Attachment preview is empty')
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return URL.createObjectURL(new Blob([buffer], { type: mimeType }))
}
