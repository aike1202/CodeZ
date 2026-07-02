import React, { useEffect, useRef, useMemo } from 'react'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import IconFile from '../icons/IconFile'
import IconClose from '../icons/IconClose'
import { parseArgs } from '../../utils/parseArgs'

import './FilePreviewPanel.css'
import type { FilePreviewPanelProps } from './types'
import { DiffViewer } from './components/DiffViewer'
import { FileContentRenderer } from './components/FileContentRenderer'

export default function FilePreviewPanel({
  previewPath = null,
  previewDiff = null,
  previewLoading = false,
  previewContent = null,
  messages = [],
  onClose = () => {},
  onFileClick = () => {}
}: FilePreviewPanelProps): React.ReactElement | null {
  const activeToolCall = useMemo(() => {
    if (!previewPath) return null
    const streamingMsg = messages.find((m) => m.streaming)
    if (!streamingMsg || !streamingMsg.toolCalls) return null

    return (
      streamingMsg.toolCalls.find((tc: any) => {
        if (tc.status !== 'running') return false
        if (tc.name !== 'write_to_file' && tc.name !== 'replace_file_content') return false

        const argsObj = parseArgs(tc.args)
        const targetFile = argsObj.targetFile || argsObj.TargetFile || argsObj.filePath || argsObj.path
        if (typeof targetFile !== 'string') return false

        const cleanTarget = targetFile.replace(/\\/g, '/').replace(/(:\d+)$/, '')
        const cleanPreview = previewPath.replace(/\\/g, '/').replace(/(:\d+)$/, '')

        return cleanTarget === cleanPreview || cleanPreview.endsWith(cleanTarget) || cleanTarget.endsWith(cleanPreview)
      }) || null
    )
  }, [previewPath, messages])

  const renderedPreviewContent = useMemo(() => {
    if (!previewPath) return ''
    if (!activeToolCall) return previewContent?.content || ''

    const argsObj = parseArgs(activeToolCall.args)
    if (activeToolCall.name === 'write_to_file') {
      const code = argsObj.codeContent || argsObj.code_content || ''
      const cursor = activeToolCall.status === 'running' ? '▊' : ''
      return code + cursor
    }

    if (activeToolCall.name === 'replace_file_content') {
      const original = previewContent?.content || ''
      const target = argsObj.targetContent
      const replacement = argsObj.replacementContent

      if (typeof replacement === 'string' && target) {
        const normOriginal = original.replace(/\r\n/g, '\n')
        const normTarget = target.replace(/\r\n/g, '\n')

        if (normOriginal.includes(normTarget)) {
          const isStreaming = activeToolCall.status === 'running'
          const cursor = isStreaming ? '▊' : ''
          return normOriginal.replace(normTarget, replacement + cursor)
        }
      }
      return original
    }

    return previewContent?.content || ''
  }, [previewPath, activeToolCall, previewContent])

  const prevRunningRef = useRef<boolean>(false)
  const isCurrentlyRunning = activeToolCall !== null

  useEffect(() => {
    if (prevRunningRef.current && !isCurrentlyRunning && previewPath) {
      onFileClick(previewPath)
    }
    prevRunningRef.current = isCurrentlyRunning
  }, [isCurrentlyRunning, previewPath, onFileClick])

  if (!previewPath && !previewDiff) return null

  const sideTitle = previewPath || (previewDiff ? `Diff: ${previewDiff.filePath}` : '')

  return (
    <div className="preview-panel-container" style={{ width: '100%' }}>
      <Flex align="center" justify="between" className="preview-panel-header">
        <Flex align="center" gap={2} className="preview-panel-title-area">
          <IconFile className="preview-file-icon" />
          <span className="preview-panel-title-text">{sideTitle}</span>
        </Flex>
        <Button variant="ghost" size="none" className="preview-close-btn" onClick={onClose}>
          <IconClose className="preview-close-icon" />
        </Button>
      </Flex>
      <div className="preview-body-container">
        {previewDiff ? (
          <DiffViewer
            type={previewDiff.type}
            targetContent={previewDiff.targetContent}
            replacementContent={previewDiff.replacementContent}
            codeContent={previewDiff.codeContent}
          />
        ) : previewLoading && !activeToolCall ? (
          <div className="preview-loading-state">加载中...</div>
        ) : (
          <FileContentRenderer
            code={renderedPreviewContent}
            filePath={previewPath || ''}
            onFileClick={onFileClick}
          />
        )}
      </div>
    </div>
  )
}

export type { FilePreviewPanelProps } from './types'
export { DiffViewer }
