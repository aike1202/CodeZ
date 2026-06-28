import React from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import IconPackage from '../icons/IconPackage'

/* ---------- file path regex ---------- */
const EXTENSIONS = ['tsx', 'jsx', 'scss', 'less', 'json', 'html', 'yaml', 'toml', 'svelte', 'java', 'cpp', 'css', 'xml', 'svg', 'yml', 'vue', 'ini', 'cfg', 'bat', 'ps1', 'ts', 'js', 'rs', 'go', 'py', 'sh', 'md', 'c', 'h']
EXTENSIONS.sort((a, b) => b.length - a.length)
const FILE_PATH_RE = new RegExp(`([\\w./\\\\-]+\\.(${EXTENSIONS.join('|')})(:\\d+)?)`, 'gi')

export interface MarkdownBlock {
  type: 'p' | 'code' | 'blockquote' | 'ul' | 'ol' | 'h1' | 'h2' | 'h3' | 'hr' | 'table'
  lang?: string
  lines: string[]
}

export function parseInline(
  text: string,
  onFileClick: (path: string) => void,
  showCursor = false
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  if (!text) {
    if (showCursor) {
      nodes.push(React.createElement('span', { key: 'cursor', className: 'streaming-cursor' }, '▊'))
    }
    return nodes
  }

  let remaining = text
  let keyIdx = 0

  while (remaining) {
    const boldIdx = remaining.indexOf('**')
    const codeIdx = remaining.indexOf('`')

    FILE_PATH_RE.lastIndex = 0
    let fileMatch = FILE_PATH_RE.exec(remaining)
    let fileIdx = -1

    while (fileMatch) {
      const fullPath = fileMatch[1].split(':')[0]
      const basename = fullPath.split(/[/\\]/).pop() || fullPath
      const validFiles = useWorkspaceStore.getState().validFiles
      if (validFiles.size === 0 || validFiles.has(basename) || validFiles.has(fullPath)) {
        fileIdx = fileMatch.index
        break
      }
      fileMatch = FILE_PATH_RE.exec(remaining)
    }

    const COMMAND_RE = /(\/[a-zA-Z0-9_-]+)/g
    COMMAND_RE.lastIndex = 0
    const cmdMatch = COMMAND_RE.exec(remaining)
    const cmdIdx = cmdMatch ? cmdMatch.index : -1

    const indices = [
      { type: 'bold', index: boldIdx },
      { type: 'code', index: codeIdx },
      { type: 'file', index: fileIdx, match: fileMatch },
      { type: 'cmd', index: cmdIdx, match: cmdMatch }
    ].filter((item) => item.index !== -1)

    if (indices.length === 0) {
      nodes.push(React.createElement('span', { key: `txt-${keyIdx++}` }, remaining))
      break
    }

    indices.sort((a, b) => a.index - b.index)
    const first = indices[0]

    if (first.index > 0) {
      nodes.push(React.createElement('span', { key: `txt-${keyIdx++}` }, remaining.slice(0, first.index)))
    }

    remaining = remaining.slice(first.index)

    if (first.type === 'bold') {
      const nextBold = remaining.indexOf('**', 2)
      if (nextBold !== -1) {
        const boldText = remaining.slice(2, nextBold)
        nodes.push(
          React.createElement('strong', { key: `bold-${keyIdx++}`, className: 'msg-bold' }, boldText)
        )
        remaining = remaining.slice(nextBold + 2)
      } else {
        nodes.push(React.createElement('span', { key: `txt-${keyIdx++}` }, remaining.slice(0, 2)))
        remaining = remaining.slice(2)
      }
    } else if (first.type === 'code') {
      const nextCode = remaining.indexOf('`', 1)
      if (nextCode !== -1) {
        const codeText = remaining.slice(1, nextCode)
        nodes.push(
          React.createElement('code', { key: `code-${keyIdx++}`, className: 'inline-code' }, codeText)
        )
        remaining = remaining.slice(nextCode + 1)
      } else {
        const codeText = remaining.slice(1)
        nodes.push(
          React.createElement('code', { key: `code-${keyIdx++}`, className: 'inline-code' }, codeText)
        )
        remaining = ''
      }
    } else if (first.type === 'file' && first.match) {
      const matchText = first.match[0]
      nodes.push(
        React.createElement(
          'span',
          {
            key: `file-${keyIdx++}`,
            className: 'file-link',
            onClick: () => onFileClick(matchText),
            title: `点击预览 ${matchText}`
          },
          matchText
        )
      )
      remaining = remaining.slice(matchText.length)
    } else if (first.type === 'cmd' && first.match) {
      const matchText = first.match[0]
      nodes.push(
        React.createElement(
          'span',
          {
            key: `cmd-link-${keyIdx++}`,
            className: 'cmd-inline-link',
            onClick: () => {
              window.dispatchEvent(new CustomEvent('insert-command', { detail: `${matchText} ` }))
            },
            title: `点击在输入框中调用 ${matchText}`
          },
          React.createElement(IconPackage, { className: 'cmd-inline-link-icon' }),
          matchText.substring(1)
        )
      )
      remaining = remaining.slice(matchText.length)
    }
  }

  if (showCursor) {
    nodes.push(React.createElement('span', { key: 'cursor', className: 'streaming-cursor' }, '▊'))
  }

  return nodes
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split('\n')
  const blocks: MarkdownBlock[] = []
  let currentBlock: MarkdownBlock | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trim().startsWith('```')) {
      if (currentBlock && currentBlock.type === 'code') {
        blocks.push(currentBlock)
        currentBlock = null
      } else {
        if (currentBlock) blocks.push(currentBlock)
        const lang = line.trim().slice(3).trim()
        currentBlock = {
          type: 'code',
          lang: lang || 'text',
          lines: []
        }
      }
      continue
    }

    if (currentBlock && currentBlock.type === 'code') {
      currentBlock.lines.push(line)
      continue
    }

    const headerMatch = line.match(/^(#{1,3})\s+(.*)/u)
    if (headerMatch) {
      if (currentBlock) blocks.push(currentBlock)
      const level = headerMatch[1].length
      currentBlock = {
        type: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3',
        lines: [headerMatch[2]]
      }
      blocks.push(currentBlock)
      currentBlock = null
      continue
    }

    if (line.trim() === '---' || line.trim() === '***') {
      if (currentBlock) blocks.push(currentBlock)
      currentBlock = {
        type: 'hr',
        lines: []
      }
      blocks.push(currentBlock)
      currentBlock = null
      continue
    }

    if (line.trim().startsWith('|')) {
      if (currentBlock && currentBlock.type === 'table') {
        currentBlock.lines.push(line)
      } else {
        if (currentBlock) blocks.push(currentBlock)
        currentBlock = {
          type: 'table',
          lines: [line]
        }
      }
      continue
    }

    if (line.startsWith('>')) {
      const quoteContent = line.slice(1).replace(/^\s/u, '')
      if (currentBlock && currentBlock.type === 'blockquote') {
        currentBlock.lines.push(quoteContent)
      } else {
        if (currentBlock) blocks.push(currentBlock)
        currentBlock = {
          type: 'blockquote',
          lines: [quoteContent]
        }
      }
      continue
    }

    const ulMatch = line.match(/^(\s*)([-*+])(?:$|\s+(.*))/u)
    if (ulMatch) {
      if (currentBlock && currentBlock.type === 'ul') {
        currentBlock.lines.push(line)
      } else {
        if (currentBlock) blocks.push(currentBlock)
        currentBlock = {
          type: 'ul',
          lines: [line]
        }
      }
      continue
    }

    const olMatch = line.match(/^(\s*)(\d+)\.(?:$|\s+(.*))/u)
    if (olMatch) {
      if (currentBlock && currentBlock.type === 'ol') {
        currentBlock.lines.push(line)
      } else {
        if (currentBlock) blocks.push(currentBlock)
        currentBlock = {
          type: 'ol',
          lines: [line]
        }
      }
      continue
    }

    if (line.trim() === '') {
      if (currentBlock) {
        blocks.push(currentBlock)
        currentBlock = null
      }
      continue
    }

    if (currentBlock && currentBlock.type === 'p') {
      currentBlock.lines.push(line)
    } else {
      if (currentBlock) blocks.push(currentBlock)
      currentBlock = {
        type: 'p',
        lines: [line]
      }
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock)
  }

  return blocks
}
