import React, { useState, useEffect, useRef, useMemo } from 'react'
import Prism from 'prismjs'
import MessageBody from './chat/MessageBody'
import Button from './ui/Button'
import Flex from './ui/Flex'
import IconFile from './icons/IconFile'
import IconCopy from './icons/IconCopy'
import IconClose from './icons/IconClose'
import IconCheck from './icons/IconCheck'
import { parseArgs } from '../utils/parseArgs'
import './FilePreviewPanel.css'

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
  previewPanelWidth?: number
  onMouseDownResize?: (e: React.MouseEvent) => void
  onClose?: () => void
  onFileClick?: (path: string) => void
}

/* ============================================
   根据文件路径获取 Prism 支持的语言标识
   ============================================ */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const mapping: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    py: 'python',
    go: 'go',
    rs: 'rust',
    html: 'html',
    xml: 'markup',
    svg: 'markup',
    css: 'css',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'bash',
    bash: 'bash',
    bat: 'batch',
    ps1: 'powershell',
    sql: 'sql',
    md: 'markdown',
    markdown: 'markdown'
  }
  return mapping[ext] || 'text'
}

/* ============================================
   流式 Diff 差异对比呈现组件
   ============================================ */
export function DiffViewer({
  type,
  targetContent,
  replacementContent,
  codeContent
}: {
  type: 'write' | 'edit' | 'replace'
  targetContent?: string
  replacementContent?: string
  codeContent?: string
}) {
  if (type === 'write') {
    const lines = (codeContent || '').split('\n')
    return (
      <div className="diff-viewer-container">
        {lines.map((line, idx) => (
          <div key={idx} className="diff-line-added">
            <span className="diff-line-number-added">{idx + 1}</span>
            <span className="diff-line-sign-added">+</span>
            <span className="diff-line-text">{line}</span>
          </div>
        ))}
      </div>
    )
  }

  const deletedLines = (targetContent || '').split('\n')
  const addedLines = (replacementContent || '').split('\n')

  return (
    <div className="diff-viewer-container">
      {deletedLines.map((line, idx) => (
        <div key={`del-${idx}`} className="diff-line-deleted">
          <span className="diff-line-number-deleted">-</span>
          <span className="diff-line-sign-deleted">-</span>
          <span className="diff-line-text">{line}</span>
        </div>
      ))}
      {addedLines.map((line, idx) => (
        <div key={`add-${idx}`} className="diff-line-added">
          <span className="diff-line-number-added">+</span>
          <span className="diff-line-sign-added">+</span>
          <span className="diff-line-text">{line}</span>
        </div>
      ))}
    </div>
  )
}

/* ============================================
   智能文件内容预览组件（支持 Markdown 与语法高亮）
   ============================================ */
export function FilePreviewViewer({
  code,
  filePath,
  onFileClick
}: {
  code: string
  filePath: string
  onFileClick: (path: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const language = getLanguageFromPath(filePath)
  const codeRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (codeRef.current && language !== 'text') {
      Prism.highlightElement(codeRef.current)
    }
  }, [code, language])

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (language === 'markdown') {
    return (
      <div className="preview-markdown-container">
        <MessageBody content={code} onFileClick={onFileClick} />
      </div>
    )
  }

  return (
    <div className="preview-code-container">
      <div className="preview-toolbar">
        <span className="preview-language-label">{language === 'text' ? 'TXT' : language}</span>
        <Button
          htmlType="button"
          variant="ghost"
          size="none"
          onClick={handleCopy}
          className="preview-copy-btn"
        >
          {copied ? (
            <>
              <IconCheck className="preview-copy-icon" />
              <span>已复制</span>
            </>
          ) : (
            <>
              <IconCopy className="preview-copy-icon" />
              <span>复制</span>
            </>
          )}
        </Button>
      </div>

      <div className="preview-pre-wrapper">
        <pre className="preview-pre">
          <code ref={codeRef} className={`language-${language} whitespace-pre-wrap break-all`}>
            {code}
          </code>
        </pre>
      </div>
    </div>
  )
}

/* ============================================
   主面板导出组件
   ============================================ */
export default function FilePreviewPanel({
  previewPath = null,
  previewDiff = null,
  previewLoading = false,
  previewContent = null,
  messages = [],
  previewPanelWidth = 480,
  onMouseDownResize = () => {},
  onClose = () => {},
  onFileClick = () => {}
}: FilePreviewPanelProps): React.ReactElement | null {
  // 查找正在针对 previewPath 进行流式或物理修改的 active toolCall
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

  // 计算结合了内存流式预合成的代码预览内容
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

  // 工具执行结束物理落盘后，自动无感 Reload 该文件
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
    <>
      <div
        className="preview-resize-bar"
        onMouseDown={onMouseDownResize}
      />
      <div
        className="preview-panel-container"
        style={{ width: previewPanelWidth }}
      >
        <Flex align="center" justify="between" className="preview-panel-header">
          <Flex align="center" gap={2} className="preview-panel-title-area">
            <IconFile className="preview-file-icon" />
            <span className="preview-panel-title-text">{sideTitle}</span>
          </Flex>
          <Button
            variant="ghost"
            size="none"
            className="preview-close-btn"
            onClick={onClose}
          >
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
            <FilePreviewViewer
              code={renderedPreviewContent}
              filePath={previewPath || ''}
              onFileClick={onFileClick}
            />
          )}
        </div>
      </div>
    </>
  )
}
