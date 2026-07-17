import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, LoaderCircle, X } from 'lucide-react'
import type { ComposerImageAttachment } from '@shared/types/attachment'
import { nextPreviewIndex } from './imageAttachmentState'
import { createPreviewObjectUrl } from './attachmentPreviewBytes'
import { desktopApi } from '../../shared/desktop'
import './ImagePreviewModal.css'

interface ImagePreviewModalProps {
  attachments: ComposerImageAttachment[]
  initialIndex: number
  onClose: () => void
}

export default function ImagePreviewModal({
  attachments,
  initialIndex,
  onClose
}: ImagePreviewModalProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), attachments.length - 1))
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const safeIndex = Math.min(Math.max(index, 0), Math.max(attachments.length - 1, 0))
  const current = attachments[safeIndex]

  useEffect(() => {
    setIndex(Math.min(Math.max(initialIndex, 0), Math.max(attachments.length - 1, 0)))
  }, [attachments.length, initialIndex])

  useEffect(() => {
    const attachment = current
    if (!attachment) return
    let cancelled = false
    let objectUrl: string | null = null
    setPreviewUrl(null)
    setLoadError(false)

    void desktopApi.attachment.readPreview(attachment, 'original')
      .then((preview) => {
        if (cancelled) return
        objectUrl = createPreviewObjectUrl(preview.bytes, preview.mimeType)
        setPreviewUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachments, current])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (attachments.length > 1 && event.key === 'ArrowLeft') {
        setIndex((current) => nextPreviewIndex(current, attachments.length, -1))
      }
      if (attachments.length > 1 && event.key === 'ArrowRight') {
        setIndex((current) => nextPreviewIndex(current, attachments.length, 1))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [attachments.length, onClose])

  if (attachments.length === 0) return null

  return createPortal(
    <div
      className="image-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`照片预览：${current.name}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="image-preview-toolbar">
        <span className="image-preview-counter">{safeIndex + 1} / {attachments.length}</span>
        <button type="button" onClick={onClose} title="关闭预览" aria-label="关闭预览">
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      {attachments.length > 1 ? (
        <button
          type="button"
          className="image-preview-nav image-preview-nav--previous"
          onClick={() => setIndex((currentIndex) => nextPreviewIndex(currentIndex, attachments.length, -1))}
          title="上一张"
          aria-label="上一张"
        >
          <ChevronLeft size={26} aria-hidden="true" />
        </button>
      ) : null}

      <div className="image-preview-stage">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={current.name}
            onError={() => {
              URL.revokeObjectURL(previewUrl)
              setPreviewUrl(null)
              setLoadError(true)
            }}
          />
        ) : loadError ? (
          <span>照片无法加载</span>
        ) : (
          <LoaderCircle className="image-preview-spinner" size={28} aria-label="正在加载照片" />
        )}
      </div>

      {attachments.length > 1 ? (
        <button
          type="button"
          className="image-preview-nav image-preview-nav--next"
          onClick={() => setIndex((currentIndex) => nextPreviewIndex(currentIndex, attachments.length, 1))}
          title="下一张"
          aria-label="下一张"
        >
          <ChevronRight size={26} aria-hidden="true" />
        </button>
      ) : null}
    </div>,
    document.body
  )
}

export type { ImagePreviewModalProps }
