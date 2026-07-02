import React, { useState, useEffect } from 'react'
import MessageBody from '../../chat/MessageBody'
import Button from '../../ui/Button'
import IconCopy from '../../icons/IconCopy'
import IconCheck from '../../icons/IconCheck'
import CodeMirror from '@uiw/react-codemirror'
import { vscodeDark } from '@uiw/codemirror-theme-vscode'
import { languages } from '@codemirror/language-data'
import { Extension } from '@codemirror/state'

interface FileContentRendererProps {
  code: string
  filePath: string
  onFileClick: (path: string) => void
}

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

export function FileContentRenderer({
  code,
  filePath,
  onFileClick
}: FileContentRendererProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const language = getLanguageFromPath(filePath)
  const [langExtension, setLangExtension] = useState<Extension[]>([])

  useEffect(() => {
    let active = true
    const langDesc = languages.find(
      (l) =>
        l.name.toLowerCase() === language.toLowerCase() ||
        l.alias.includes(language) ||
        l.extensions.includes(filePath.split('.').pop()?.toLowerCase() || '')
    )

    if (langDesc) {
      langDesc
        .load()
        .then((ext) => {
          if (active) setLangExtension([ext])
        })
        .catch(() => {
          if (active) setLangExtension([])
        })
    } else {
      setLangExtension([])
    }

    return () => {
      active = false
    }
  }, [language, filePath])

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

  const isDark = document.documentElement.classList.contains('dark')

  return (
    <div className="preview-code-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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

      <div className="preview-pre-wrapper" style={{ flex: 1, overflow: 'auto' }}>
        <CodeMirror
          value={code}
          height="100%"
          theme={isDark ? vscodeDark : 'light'}
          extensions={langExtension}
          readOnly={true}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            highlightActiveLine: true,
            foldGutter: true
          }}
          style={{ height: '100%' }}
        />
      </div>
    </div>
  )
}
