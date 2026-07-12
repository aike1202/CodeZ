import { useEffect, useMemo, useState } from 'react'
import { Image as ImageIcon, LoaderCircle, X } from 'lucide-react'
import type { ComposerImageAttachment } from '@shared/types/attachment'
import { createPreviewObjectUrl } from './attachmentPreviewBytes'
import './ImageAttachmentGrid.css'

interface ImageAttachmentGridProps {
  attachments: ComposerImageAttachment[]
  mode: 'editable' | 'readonly'
  loadingIds?: Set<string>
  onRemove?: (attachment: ComposerImageAttachment) => void
  onOpen: (index: number) => void
}

export default function ImageAttachmentGrid({
  attachments,
  mode,
  loadingIds,
  onRemove,
  onOpen
}: ImageAttachmentGridProps) {
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const [unavailableIds, setUnavailableIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let cancelled = false
    const urls: string[] = []
    setPreviewUrls({})
    setUnavailableIds(new Set())

    void Promise.all(attachments.map(async (attachment) => {
      try {
        const preview = await window.api.attachment.readPreview(attachment, 'thumbnail')
        if (cancelled) return
        const url = createPreviewObjectUrl(preview.bytes, preview.mimeType)
        urls.push(url)
        setPreviewUrls((current) => ({ ...current, [attachment.id]: url }))
      } catch {
        if (!cancelled) {
          setUnavailableIds((current) => new Set(current).add(attachment.id))
        }
      }
    }))

    return () => {
      cancelled = true
      urls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [attachments])

  const activeLoadingIds = useMemo(() => loadingIds || new Set<string>(), [loadingIds])
  if (attachments.length === 0) return null

  return (
    <div className={`image-attachment-grid image-attachment-grid--${mode}`}>
      {attachments.map((attachment, index) => {
        const previewUrl = previewUrls[attachment.id]
        const unavailable = unavailableIds.has(attachment.id)
        const loading = activeLoadingIds.has(attachment.id) || (!previewUrl && !unavailable)
        return (
          <div className="image-attachment-tile" key={`${attachment.scope}:${attachment.id}`}>
            <button
              type="button"
              className="image-attachment-open"
              onClick={() => onOpen(index)}
              title={`预览 ${attachment.name}`}
              aria-label={`预览 ${attachment.name}`}
            >
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt={attachment.name}
                  onError={() => {
                    URL.revokeObjectURL(previewUrl)
                    setPreviewUrls((current) => {
                      const next = { ...current }
                      delete next[attachment.id]
                      return next
                    })
                    setUnavailableIds((current) => new Set(current).add(attachment.id))
                  }}
                />
              ) : loading ? (
                <LoaderCircle className="image-attachment-spinner" size={18} aria-hidden="true" />
              ) : (
                <ImageIcon size={20} aria-hidden="true" />
              )}
            </button>
            {mode === 'editable' ? (
              <button
                type="button"
                className="image-attachment-remove"
                onClick={() => onRemove?.(attachment)}
                title={`移除 ${attachment.name}`}
                aria-label={`移除 ${attachment.name}`}
              >
                <X size={13} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export type { ImageAttachmentGridProps }
