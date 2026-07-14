import React, { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { vscodeDark } from '@uiw/codemirror-theme-vscode'
import { Braces, ClipboardPaste, Copy, Save, WandSparkles, X } from 'lucide-react'
import Button from '../ui/Button'

interface Props {
  value: string
  error?: string
  dirty: boolean
  busy: boolean
  serverCount: number
  onChange: (value: string) => void
  onClose: () => void
  onFormat: () => void
  onPaste: () => void
  onCopy: () => void
  onSave: () => void
}

function jsonDiagnostic(source: string): Diagnostic[] {
  try {
    JSON.parse(source)
    return []
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const match = /position\s+(\d+)/i.exec(message)
    const position = Math.min(Number(match?.[1] || 0), Math.max(0, source.length - 1))
    return [{ from: position, to: Math.min(source.length, position + 1), severity: 'error', message }]
  }
}

export default function McpJsonEditor({
  value,
  error,
  dirty,
  busy,
  serverCount,
  onChange,
  onClose,
  onFormat,
  onPaste,
  onCopy,
  onSave
}: Props): React.ReactElement {
  const extensions = useMemo(() => [
    json(),
    lintGutter(),
    linter((view) => jsonDiagnostic(view.state.doc.toString()), { delay: 250 })
  ], [])

  return (
    <section className="mcp-json-panel" aria-labelledby="mcp-json-title">
      <header className="mcp-json-header">
        <div className="mcp-json-heading">
          <span className="mcp-json-icon" aria-hidden="true"><Braces size={18} /></span>
          <div>
            <h2 id="mcp-json-title">MCP JSON 配置</h2>
            <p>用户配置 · {serverCount} 个 Server{dirty ? ' · 有未保存修改' : ''}</p>
          </div>
        </div>
        <Button variant="icon" title="关闭 JSON 编辑器" aria-label="关闭 JSON 编辑器" icon={<X size={18} />} onClick={onClose} />
      </header>

      <div className="mcp-json-toolbar" aria-label="JSON 编辑操作">
        <Button icon={<ClipboardPaste size={15} />} onClick={onPaste} disabled={busy}>从剪贴板粘贴</Button>
        <Button icon={<WandSparkles size={15} />} onClick={onFormat} disabled={busy}>格式化</Button>
        <Button icon={<Copy size={15} />} onClick={onCopy} disabled={busy}>复制</Button>
        <span className="mcp-json-toolbar-spacer" />
        <Button type="primary" icon={<Save size={15} />} onClick={onSave} loading={busy} disabled={!dirty || Boolean(error)}>保存并应用</Button>
      </div>

      <div className="mcp-json-editor-wrap">
        <CodeMirror
          value={value}
          height="100%"
          extensions={extensions}
          onChange={onChange}
          className="mcp-json-codemirror"
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true
          }}
          theme={vscodeDark}
          aria-label="MCP JSON 配置编辑器"
        />
      </div>

      <footer className={`mcp-json-status ${error ? 'has-error' : ''}`} role={error ? 'alert' : 'status'}>
        {error || `JSON 有效 · 解析到 ${serverCount} 个 Server`}
      </footer>
    </section>
  )
}
