import React, { useState, useMemo } from 'react'
import IconCheck from '../icons/IconCheck'
import IconCopy from '../icons/IconCopy'
import hljs from 'highlight.js'

interface CodeBlockProps {
  lang: string
  code: string
}

export default function CodeBlock({
  lang,
  code
}: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const highlightedCode = useMemo(() => {
    if (!code) return ''
    try {
      // highlight.js 会将不支持的语言作为纯文本处理，但为了安全我们先做个判断
      const validLang = hljs.getLanguage(lang) ? lang : 'plaintext'
      return hljs.highlight(code, { language: validLang, ignoreIllegals: true }).value
    } catch (e) {
      // 降级：转义 HTML 实体防止 XSS
      return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [code, lang])

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
      <pre className="code-block-pre hljs">
        <code
          dangerouslySetInnerHTML={{
            __html: highlightedCode
          }}
        />
      </pre>
    </div>
  )
}
