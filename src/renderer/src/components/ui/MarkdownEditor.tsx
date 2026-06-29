import React, { useState, useRef, useEffect, UIEvent } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-markdown'
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
  const preRef = useRef<HTMLPreElement>(null)

  const handleScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (preRef.current) {
      preRef.current.scrollTop = e.currentTarget.scrollTop
      preRef.current.scrollLeft = e.currentTarget.scrollLeft
    }
  }

  // Pre-calculate syntax highlighted HTML
  const highlightedCode = Prism.highlight(value || '', Prism.languages.markdown || Prism.languages.text, 'markdown')

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
            <pre ref={preRef} className="md-editor-pre" aria-hidden="true">
              <code dangerouslySetInnerHTML={{ __html: highlightedCode || (value + '\n') }} />
            </pre>
            <textarea
              className="md-editor-textarea"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onScroll={handleScroll}
              placeholder={placeholder}
              spellCheck={false}
            />
          </div>
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
