import React, { useState } from 'react'
import IconCheck from '../icons/IconCheck'
import IconCopy from '../icons/IconCopy'

interface CodeBlockProps {
  lang: string
  code: string
  showCursor?: boolean
}

export default function CodeBlock({
  lang,
  code,
  showCursor = false
}: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="code-block-wrapper text-left">
      <div className="code-block-header">
        <span>{lang}</span>
        <button type="button" onClick={handleCopy} className="copy-btn">
          {copied ? (
            <>
              <IconCheck style={{ width: 12, height: 12 }} />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <IconCopy style={{ width: 12, height: 12 }} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="code-block-pre">
        <code>
          {code}
          {showCursor && <span className="streaming-cursor">▊</span>}
        </code>
      </pre>
    </div>
  )
}
