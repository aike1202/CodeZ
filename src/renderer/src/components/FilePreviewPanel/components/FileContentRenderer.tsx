import React, { useState, useEffect } from 'react'
import MessageBody from '../../chat/MessageBody'
import Button from '../../ui/Button'
import IconCopy from '../../icons/IconCopy'
import IconCheck from '../../icons/IconCheck'
import CodeMirror from '@uiw/react-codemirror'
import { vscodeDark } from '@uiw/codemirror-theme-vscode'
import { languages } from '@codemirror/language-data'
import { Extension } from '@codemirror/state'
import { Code2, Eye } from 'lucide-react'

interface FileContentRendererProps {
  code: string
  filePath: string
  onFileClick: (path: string) => void
}

export function getLanguageFromPath(filePath: string): string {
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

const READ_ONLY_EDITOR_SETUP = {
  lineNumbers: true,
  highlightActiveLineGutter: true,
  highlightActiveLine: true,
  foldGutter: true
} as const

function ReadOnlyCodeView({
  code,
  extensions,
  className = ''
}: {
  code: string
  extensions: Extension[]
  className?: string
}): React.ReactElement {
  const isDark = document.documentElement.classList.contains('dark')

  return (
    <div className={`preview-pre-wrapper ${className}`}>
      <CodeMirror
        value={code}
        height="100%"
        theme={isDark ? vscodeDark : 'light'}
        extensions={extensions}
        readOnly
        basicSetup={READ_ONLY_EDITOR_SETUP}
        style={{ height: '100%' }}
      />
    </div>
  )
}

export function FileContentRenderer({
  code,
  filePath,
  onFileClick
}: FileContentRendererProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const [markdownView, setMarkdownView] = useState<'source' | 'preview'>('preview')
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
      <div className="preview-markdown-viewer">
        <div className="preview-markdown-toolbar">
          <div
            className="preview-markdown-mode-switch"
            role="group"
            aria-label="Markdown 查看方式"
          >
            <button
              type="button"
              className={`preview-markdown-mode-button ${markdownView === 'source' ? 'preview-markdown-mode-button--active' : ''}`}
              aria-pressed={markdownView === 'source'}
              title="查看 Markdown 原格式"
              onClick={() => setMarkdownView('source')}
            >
              <Code2 size={14} aria-hidden="true" />
              <span>原格式</span>
            </button>
            <button
              type="button"
              className={`preview-markdown-mode-button ${markdownView === 'preview' ? 'preview-markdown-mode-button--active' : ''}`}
              aria-pressed={markdownView === 'preview'}
              title="查看 Markdown 可视化内容"
              onClick={() => setMarkdownView('preview')}
            >
              <Eye size={14} aria-hidden="true" />
              <span>可视化</span>
            </button>
          </div>
        </div>

        {markdownView === 'preview' ? (
          <div className="preview-markdown-container">
            <MessageBody content={code} onFileClick={onFileClick} />
          </div>
        ) : (
          <ReadOnlyCodeView
            code={code}
            extensions={langExtension}
            className="preview-markdown-source"
          />
        )}
      </div>
    )
  }

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

      <ReadOnlyCodeView code={code} extensions={langExtension} />
    </div>
  )
}
