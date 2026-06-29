import React, { useState } from 'react'
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
          <textarea
            className="md-editor-textarea"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
          />
        ) : (
          <div className="md-editor-preview">
            <MessageBody 
              content={value} 
              onFileClick={() => {}} // No-op for preview
            />
          </div>
        )}
      </div>
    </div>
  )
}
