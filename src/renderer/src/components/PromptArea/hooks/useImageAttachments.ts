import { useCallback, useRef, useState } from 'react'
import type { ComposerImageAttachment } from '@shared/types/attachment'
import { mergeRejectedAttachments } from '../promptSubmissionState'
import { desktopApi } from '../../../shared/desktop'

interface UseImageAttachmentsResult {
  attachments: ComposerImageAttachment[]
  importing: boolean
  errors: string[]
  addFiles: (files: File[]) => Promise<void>
  removeAttachment: (id: string) => Promise<void>
  replaceAttachments: (attachments: ComposerImageAttachment[]) => void
  clearComposerAttachments: () => void
  restoreRejectedDrafts: (attachments: ComposerImageAttachment[]) => void
}

type ImportResult =
  | { attachment: ComposerImageAttachment; error?: never }
  | { attachment?: never; error: string }

export function useImageAttachments(): UseImageAttachmentsResult {
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([])
  const [importing, setImporting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const activeImports = useRef(0)

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return

    activeImports.current += 1
    setImporting(true)
    try {
      const results = await Promise.all(files.map(async (file): Promise<ImportResult> => {
        if (!file.type.startsWith('image/')) {
          return { error: `${file.name || '未命名文件'}：不是支持的照片格式` }
        }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const attachment = await desktopApi.attachment.importDraft(
            file.name || 'photo',
            file.type,
            bytes
          )
          return { attachment }
        } catch (error) {
          return {
            error: `${file.name || '未命名照片'}：${error instanceof Error ? error.message : String(error)}`
          }
        }
      }))

      const imported = results.flatMap((result) => result.attachment ? [result.attachment] : [])
      const nextErrors = results.flatMap((result) => result.error ? [result.error] : [])
      if (imported.length > 0) {
        setAttachments((current) => [...current, ...imported])
      }
      setErrors(nextErrors)
    } finally {
      activeImports.current -= 1
      if (activeImports.current === 0) setImporting(false)
    }
  }, [])

  const removeAttachment = useCallback(async (id: string) => {
    const removed = attachments.find((attachment) => attachment.id === id)
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
    if (removed?.scope === 'draft') {
      await desktopApi.attachment.discardDrafts([removed.draftId]).catch(() => undefined)
    }
  }, [attachments])

  const replaceAttachments = useCallback((next: ComposerImageAttachment[]) => {
    setAttachments(next.map((attachment) => ({ ...attachment })))
    setErrors([])
  }, [])

  const clearComposerAttachments = useCallback(() => {
    setAttachments([])
    setErrors([])
  }, [])

  const restoreRejectedDrafts = useCallback((rejected: ComposerImageAttachment[]) => {
    setAttachments((current) => mergeRejectedAttachments(current, rejected))
  }, [])

  return {
    attachments,
    importing,
    errors,
    addFiles,
    removeAttachment,
    replaceAttachments,
    clearComposerAttachments,
    restoreRejectedDrafts
  }
}
