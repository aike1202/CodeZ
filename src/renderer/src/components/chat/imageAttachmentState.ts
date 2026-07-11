export interface ImageSendStateInput {
  text: string
  attachmentCount: number
  importing: boolean
  supportsVision: boolean
}

export function evaluateImageSendState(input: ImageSendStateInput): {
  canSend: boolean
  reason: string | null
} {
  if (input.importing) return { canSend: false, reason: '照片仍在导入' }
  if (input.attachmentCount > 0 && !input.supportsVision) {
    return { canSend: false, reason: '当前模型未启用图片输入' }
  }
  return {
    canSend: Boolean(input.text.trim() || input.attachmentCount > 0),
    reason: null
  }
}

export function nextPreviewIndex(current: number, length: number, delta: -1 | 1): number {
  if (length <= 0) return 0
  return (current + delta + length) % length
}
