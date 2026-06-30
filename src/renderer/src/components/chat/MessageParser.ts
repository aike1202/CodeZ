import React from 'react'
import IconPackage from '../icons/IconPackage'
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils'

const getFileIconElement = (name: string) => {
  const lowerName = name.toLowerCase()
  // 简单猜测没有扩展名大概率是目录
  const isDir = !lowerName.includes('.')
  if (isDir) return React.createElement(FolderIcon, { folderName: name, className: 'shrink-0', width: 14, height: 14 })
  return React.createElement(FileIcon, { fileName: name, className: 'shrink-0', width: 14, height: 14 })
}

/* ---------- file path regex ---------- */
const EXTENSIONS = ['tsx', 'jsx', 'scss', 'less', 'json', 'html', 'yaml', 'toml', 'svelte', 'java', 'cpp', 'css', 'xml', 'svg', 'yml', 'vue', 'ini', 'cfg', 'bat', 'ps1', 'ts', 'js', 'rs', 'go', 'py', 'sh', 'md', 'c', 'h']
EXTENSIONS.sort((a, b) => b.length - a.length)
const FILE_PATH_RE = new RegExp(`([\\w./\\\\-]+\\.(${EXTENSIONS.join('|')})(:\\d+)?)`, 'gi')

export function parseInline(
  text: string,
  onFileClick: (path: string) => void,
  showCursor = false,
  validFiles?: Set<string>
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const files = validFiles ?? new Set<string>()

  if (!text) {
    if (showCursor) {
      nodes.push(React.createElement('span', { key: 'cursor', className: 'streaming-cursor' }, '▊'))
    }
    return nodes
  }

  let remaining = text
  let keyIdx = 0

  while (remaining) {
    // --- 搜索所有内联格式的起始位置 ---

    // Markdown 链接: [text](url)
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/)
    const linkIdx = linkMatch ? remaining.indexOf(linkMatch[0]) : -1

    // 加粗: **text**
    const boldIdx = remaining.indexOf('**')

    // 斜体: *text* (前后不紧接 *)
    let italicIdx = -1
    const italicRe = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/
    const italicMatch = italicRe.exec(remaining)
    if (italicMatch) {
      italicIdx = remaining.indexOf(italicMatch[0])
    }

    // 删除线: ~~text~~
    const strikeIdx = remaining.indexOf('~~')

    // 行内代码: `code`
    const codeIdx = remaining.indexOf('`')

    // 文件路径
    FILE_PATH_RE.lastIndex = 0
    let fileMatch = FILE_PATH_RE.exec(remaining)
    let fileIdx = -1

    while (fileMatch) {
      const fullPath = fileMatch[1].split(':')[0]
      const basename = fullPath.split(/[/\\]/).pop() || fullPath
      if (files.size === 0 || files.has(basename) || files.has(fullPath)) {
        fileIdx = fileMatch.index
        break
      }
      fileMatch = FILE_PATH_RE.exec(remaining)
    }

    // 斜杠命令: /command (只匹配行首或空格后)
    const COMMAND_RE = /(?:^|\s)(\/[a-zA-Z0-9_-]+)/g
    COMMAND_RE.lastIndex = 0
    const cmdMatch = COMMAND_RE.exec(remaining)
    let cmdIdx = -1
    let cmdActualStart = -1
    if (cmdMatch) {
      // 调整索引到 / 的实际位置（跳过前面可能的空格）
      const slashPos = cmdMatch[0].indexOf('/')
      cmdActualStart = cmdMatch.index + slashPos
      cmdIdx = cmdActualStart
    }

    const indices = [
      { type: 'link', index: linkIdx, match: linkMatch },
      { type: 'bold', index: boldIdx },
      { type: 'italic', index: italicIdx, match: italicMatch },
      { type: 'strike', index: strikeIdx },
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

    if (first.type === 'link' && first.match) {
      const fullMatch = first.match[0]
      const linkText = first.match[1]
      const linkUrl = first.match[2]

      if (linkText.startsWith('$')) {
        // Skill pill
        nodes.push(
          React.createElement(
            'span',
            {
              key: `skill-pill-${keyIdx++}`,
              className: 'cm-pill-widget msg-pill',
              onClick: () => {
                window.dispatchEvent(new CustomEvent('insert-command', { detail: `/${linkText.substring(1)} ` }))
              },
              title: `点击在输入框中调用 /${linkText.substring(1)}`
            },
            React.createElement('span', { className: 'cm-pill-icon flex items-center justify-center', style: { marginRight: '4px' } }, React.createElement(IconPackage)),
            React.createElement('span', { className: 'cm-pill-text' }, linkText.substring(1))
          )
        )
      } else if (!linkUrl.startsWith('http://') && !linkUrl.startsWith('https://')) {
        // File/Folder pill
        nodes.push(
          React.createElement(
            'span',
            {
              key: `file-pill-${keyIdx++}`,
              className: 'cm-pill-widget msg-pill',
              onClick: () => onFileClick(linkUrl),
              title: `点击预览 ${linkText}`
            },
            React.createElement('span', { className: 'cm-pill-icon flex items-center justify-center', style: { marginRight: '4px' } }, getFileIconElement(linkText)),
            React.createElement('span', { className: 'cm-pill-text' }, linkText)
          )
        )
      } else {
        // Normal web link
        nodes.push(
          React.createElement(
            'a',
            {
              key: `link-${keyIdx++}`,
              href: linkUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: 'msg-inline-link'
            },
            linkText
          )
        )
      }
      remaining = remaining.slice(fullMatch.length)
    } else if (first.type === 'bold') {
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
    } else if (first.type === 'italic' && first.match) {
      const fullMatch = first.match[0]
      const italicText = first.match[1]
      nodes.push(
        React.createElement('em', { key: `italic-${keyIdx++}`, className: 'msg-italic' }, italicText)
      )
      remaining = remaining.slice(fullMatch.length)
    } else if (first.type === 'strike') {
      const nextStrike = remaining.indexOf('~~', 2)
      if (nextStrike !== -1) {
        const strikeText = remaining.slice(2, nextStrike)
        nodes.push(
          React.createElement('del', { key: `strike-${keyIdx++}`, className: 'msg-strikethrough' }, strikeText)
        )
        remaining = remaining.slice(nextStrike + 2)
      } else {
        nodes.push(React.createElement('span', { key: `txt-${keyIdx++}` }, remaining.slice(0, 2)))
        remaining = remaining.slice(2)
      }
    } else if (first.type === 'code') {
      const nextCode = remaining.indexOf('`', 1)
      if (nextCode !== -1) {
        const rawCodeText = remaining.slice(1, nextCode)
        const codeText = rawCodeText.trim()
        
        let isFile = false
        FILE_PATH_RE.lastIndex = 0
        const codeFileMatch = FILE_PATH_RE.exec(codeText)
        if (codeFileMatch && codeFileMatch[0] === codeText) {
          const fullPath = codeFileMatch[1].split(':')[0]
          const basename = fullPath.split(/[/\\]/).pop() || fullPath
          if (files.size === 0 || files.has(basename) || files.has(fullPath)) {
            isFile = true
          }
        }

        if (isFile) {
          nodes.push(
            React.createElement(
              'code',
              { 
                key: `code-${keyIdx++}`, 
                className: 'inline-code file-link',
                onClick: () => onFileClick(codeText),
                title: `点击预览 ${codeText}`
              },
              rawCodeText
            )
          )
        } else {
          nodes.push(
            React.createElement('code', { key: `code-${keyIdx++}`, className: 'inline-code' }, rawCodeText)
          )
        }
        remaining = remaining.slice(nextCode + 1)
      } else {
        const rawCodeText = remaining.slice(1)
        nodes.push(
          React.createElement('code', { key: `code-${keyIdx++}`, className: 'inline-code' }, rawCodeText)
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
      const slashPos = first.match[0].indexOf('/')
      const cmdText = first.match[0].slice(slashPos)
      nodes.push(
        React.createElement(
          'span',
          {
            key: `cmd-link-${keyIdx++}`,
            className: 'cmd-inline-link',
            onClick: () => {
              window.dispatchEvent(new CustomEvent('insert-command', { detail: `${cmdText} ` }))
            },
            title: `点击在输入框中调用 ${cmdText}`
          },
          React.createElement(IconPackage, { className: 'cmd-inline-link-icon' }),
          cmdText.substring(1)
        )
      )
      remaining = remaining.slice(cmdText.length)
    }
  }

  if (showCursor) {
    nodes.push(React.createElement('span', { key: 'cursor', className: 'streaming-cursor' }, '▊'))
  }

  return nodes
}

