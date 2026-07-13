export interface FilePreviewPanelProps {
  previewPath?: string | null
  previewDiff?: {
    type: 'write' | 'edit' | 'replace'
    targetContent?: string
    replacementContent?: string
    codeContent?: string
    filePath: string
  } | null
  previewLoading?: boolean
  previewContent?: {
    path: string
    content: string
    truncated?: boolean
    totalLines?: number
  } | null
  messages?: any[]
  onClose?: () => void
  onFileClick?: (path: string) => void
  hideHeader?: boolean
}
