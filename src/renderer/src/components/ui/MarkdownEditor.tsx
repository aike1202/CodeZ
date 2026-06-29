import React, { useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { vscodeDark } from '@uiw/codemirror-theme-vscode'
import MessageBody from '../chat/MessageBody'
import './MarkdownEditor.css'

interface MarkdownEditorProps {
  value: string
  onChange: (val: string) => void
  placeholder?: string
  className?: string
  style?: React.CSSProperties
}

export default function MarkdownEditor({ value, onChange, placeholder, className, style }: MarkdownEditorProps): React.ReactElement {
  const [mode, setMode] = useState<'source' | 'preview'>('source')

  return (
    <div className={`md-editor-container ${className || ''}`} style={style}>
      <div className="md-editor-tabs">
        <button 
          className={`md-tab-btn ${mode === 'source' ? 'active' : ''}`}
          onClick={() => setMode('source')}
        >
          原格式 (Source)
        </button>
        <button 
          className={`md-tab-btn ${mode === 'preview' ? 'active' : ''}`}
          onClick={() => setMode('preview')}
        >
          预览 (Preview)
        </button>
      </div>
      
      <div className="md-editor-content">
        {mode === 'source' ? (
          <div className="md-editor-source-wrapper">
            <CodeMirror
              value={value}
              height="100%"
              extensions={[markdown({ base: markdownLanguage, codeLanguages: languages })]}
              onChange={(val) => onChange(val)}
              className="md-codemirror-wrapper"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
              }}
              theme={vscodeDark}
            />
          </div>
        ) : (
          <div className="md-editor-preview">
            <MessageBody 
              content={value} 
              onFileClick={() => {}} 
            />
          </div>
        )}
      </div>
    </div>
  )
}
