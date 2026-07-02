import React from 'react'

interface DiffViewerProps {
  type: 'write' | 'edit' | 'replace'
  targetContent?: string
  replacementContent?: string
  codeContent?: string
}

export function DiffViewer({
  type,
  targetContent,
  replacementContent,
  codeContent
}: DiffViewerProps): React.ReactElement {
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
          <span className="diff-line-number-deleted">{idx + 1}</span>
          <span className="diff-line-sign-deleted">-</span>
          <span className="diff-line-text">{line}</span>
        </div>
      ))}
      {addedLines.map((line, idx) => (
        <div key={`add-${idx}`} className="diff-line-added">
          <span className="diff-line-number-added">{idx + 1}</span>
          <span className="diff-line-sign-added">+</span>
          <span className="diff-line-text">{line}</span>
        </div>
      ))}
    </div>
  )
}
