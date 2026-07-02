import { useState, useCallback } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { FileContent } from '@shared/types/workspace'

export function useAppPreview() {
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<FileContent | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewDiff, setPreviewDiff] = useState<{
    filePath: string
    type: 'write' | 'replace'
    targetContent?: string
    replacementContent?: string
    codeContent?: string
  } | null>(null)

  const handleFileClick = useCallback(async (filePath: string, virtualContent?: string) => {
    setPreviewDiff(null)
    const ws = useWorkspaceStore.getState().workspace
    if (!ws) return

    const cleanPath = filePath.replace(/(:\d+)$/, '')
    setPreviewPath(filePath)
    setPreviewLoading(true)
    setPreviewContent(null)

    if (virtualContent !== undefined) {
      setPreviewContent({
        path: filePath,
        content: virtualContent,
        truncated: false,
        totalLines: virtualContent.split('\n').length
      })
      setPreviewLoading(false)
      return
    }

    try {
      const content = await window.api.workspace.readFile(cleanPath, ws.rootPath)
      setPreviewContent(content)
    } catch {
      setPreviewContent({
        path: cleanPath,
        content: `无法读取文件：${cleanPath}`,
        truncated: false,
        totalLines: 0
      })
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const handleDiffClick = useCallback(
    (
      filePath: string,
      editInfo: {
        type: 'write' | 'replace'
        targetContent?: string
        replacementContent?: string
        codeContent?: string
      }
    ) => {
      setPreviewPath(null)
      setPreviewContent(null)
      setPreviewDiff({
        filePath,
        ...editInfo
      })
    },
    []
  )

  const closePreview = useCallback(() => {
    setPreviewPath(null)
    setPreviewDiff(null)
  }, [])

  return {
    previewPath,
    previewContent,
    previewLoading,
    previewDiff,
    panelOpen: previewPath !== null || previewDiff !== null,
    handleFileClick,
    handleDiffClick,
    closePreview
  }
}
