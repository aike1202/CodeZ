import React, { useMemo } from 'react'
import {
  type MarkdownBlock,
  parseInline,
  parseMarkdownBlocks
} from './MessageParser'
import CodeBlock from './CodeBlock'
import './MessageBody.css'

export default function MessageBody({
  content,
  streaming,
  reasoning,
  onFileClick
}: {
  content: string
  streaming?: boolean
  reasoning?: string
  onFileClick: (filePath: string) => void
}): React.ReactElement {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content])

  // 渲染列表块
  const renderListBlock = (block: MarkdownBlock, isLastBlock: boolean) => {
    const isOrdered = block.type === 'ol'

    return (
      <div className="msg-list-wrapper">
        {block.lines.map((line, idx) => {
          const match = isOrdered
            ? line.match(/^(\s*)(\d+)\.(?:$|\s+(.*))/u)
            : line.match(/^(\s*)([-*+])(?:$|\s+(.*))/u)

          const isLastLine = idx === block.lines.length - 1
          const showCursor = streaming && isLastBlock && isLastLine

          if (!match) {
            return (
              <div key={idx} className="pl-1">
                {parseInline(line, onFileClick, showCursor)}
              </div>
            )
          }

          const indent = match[1].length
          const num = isOrdered ? match[2] : ''
          const itemContent = match[3] || ''

          const pl = `${Math.max(indent * 8, 4)}px`

          return (
            <div key={idx} style={{ paddingLeft: pl }} className="msg-list-item">
              <span className="msg-list-bullet">
                {isOrdered ? `${num}.` : '•'}
              </span>
              <span className="msg-list-content">
                {parseInline(itemContent, onFileClick, showCursor)}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  // 渲染引用块
  const renderBlockquote = (block: MarkdownBlock, isLastBlock: boolean) => {
    return (
      <div className="blockquote-block">
        {block.lines.map((line, idx) => {
          const isLastLine = idx === block.lines.length - 1
          const showCursor = streaming && isLastBlock && isLastLine
          return (
            <React.Fragment key={idx}>
              {parseInline(line, onFileClick, showCursor)}
              {!isLastLine && <br />}
            </React.Fragment>
          )
        })}
      </div>
    )
  }

  // 渲染表格块
  const renderTableBlock = (block: MarkdownBlock, isLastBlock: boolean) => {
    const rows = block.lines.map((line) => {
      const parts = line.trim().replace(/^\||\|$/g, '').split('|')
      return parts.map((p) => p.trim())
    })

    const cleanRows = rows.filter((row) => !row.every((cell) => cell.match(/^[-:\s]+$/u)))

    if (cleanRows.length === 0) return null

    const headers = cleanRows[0]
    const dataRows = cleanRows.slice(1)

    return (
      <div className="msg-table-wrapper">
        <table className="msg-table">
          <thead className="msg-table-thead">
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="msg-table-th">
                  {parseInline(h, onFileClick)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="msg-table-tbody">
            {dataRows.map((row, rowIdx) => {
              const isLastRow = rowIdx === dataRows.length - 1
              
              const cells = [...row]
              while (cells.length < headers.length) {
                cells.push('')
              }

              return (
                <tr key={rowIdx}>
                  {cells.map((cell, cellIdx) => {
                    const isLastRealCell = cellIdx === Math.max(row.length - 1, 0)
                    const showCursor = streaming && isLastBlock && isLastRow && isLastRealCell
                    return (
                      <td key={cellIdx} className="msg-table-td">
                        {parseInline(cell, onFileClick, showCursor)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="markdown-body text-left">
      {blocks.map((block, idx) => {
        const isLastBlock = idx === blocks.length - 1

        if (block.type === 'code') {
          const codeString = block.lines.join('\n')
          return (
            <CodeBlock
              key={idx}
              lang={block.lang || 'text'}
              code={codeString}
              showCursor={streaming && isLastBlock}
            />
          )
        }

        if (block.type === 'blockquote') {
          return <React.Fragment key={idx}>{renderBlockquote(block, isLastBlock)}</React.Fragment>
        }

        if (block.type === 'ul' || block.type === 'ol') {
          return <React.Fragment key={idx}>{renderListBlock(block, isLastBlock)}</React.Fragment>
        }

        if (block.type === 'table') {
          return <React.Fragment key={idx}>{renderTableBlock(block, isLastBlock)}</React.Fragment>
        }

        if (block.type === 'hr') {
          return <hr key={idx} className="msg-hr" />
        }

        if (block.type === 'h1') {
          return (
            <h1 key={idx} className="msg-h1">
              {parseInline(block.lines[0], onFileClick, streaming && isLastBlock)}
            </h1>
          )
        }

        if (block.type === 'h2') {
          return (
            <h2 key={idx} className="msg-h2">
              {parseInline(block.lines[0], onFileClick, streaming && isLastBlock)}
            </h2>
          )
        }

        if (block.type === 'h3') {
          return (
            <h3 key={idx} className="msg-h3">
              {parseInline(block.lines[0], onFileClick, streaming && isLastBlock)}
            </h3>
          )
        }

        return (
          <p key={idx} className="msg-p">
            {block.lines.map((line, lineIdx) => {
              const isLastLine = lineIdx === block.lines.length - 1
              const showCursor = streaming && isLastBlock && isLastLine
              return (
                <React.Fragment key={lineIdx}>
                  {parseInline(line, onFileClick, showCursor)}
                  {!isLastLine && <br />}
                </React.Fragment>
              )
            })}
          </p>
        )
      })}

      {streaming && !content && !reasoning && (
        <div className="msg-empty-streaming">
          <span className="streaming-cursor">▊</span>
        </div>
      )}
    </div>
  )
}