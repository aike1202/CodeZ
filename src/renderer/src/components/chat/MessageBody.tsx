import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseInline } from './MessageParser'
import CodeBlock from './CodeBlock'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import './MessageBody.css'

export default function MessageBody({
  content,
  streaming,
  reasoning,
  onFileClick
}: {
  content: string
  streaming?: boolean
  reasoning?: string
  onFileClick: (filePath: string) => void
}): React.ReactElement {
  const validFiles = useWorkspaceStore((s) => s.validFiles)

  // 极度罕见的字符串作为标记，防止触发 react-markdown 的 markdown 词法解析（如加粗、斜体等）
  const STREAMING_TOKEN = '▌▌STREAMING_TOKEN▐▐'

  // 辅助函数：深度遍历 React Node，移除 token 并决定是否渲染 cursor，同时将纯文本丢给 parseInline
  const renderInline = (children: React.ReactNode, forceShowCursor = false): React.ReactNode => {
    if (typeof children === 'string') {
      const hasToken = children.includes(STREAMING_TOKEN)
      const cleanStr = children.replace(STREAMING_TOKEN, '')
      return parseInline(cleanStr, onFileClick, forceShowCursor || hasToken, validFiles)
    }
    if (Array.isArray(children)) {
      return children.map((c, i) => (
        <React.Fragment key={i}>{renderInline(c, forceShowCursor)}</React.Fragment>
      ))
    }

    return children
  }

  const renderContent = streaming && !content 
    ? '▊' 
    : content + (streaming ? STREAMING_TOKEN : '')

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 块级代码
          pre(props: any) {
            const childProps = props.children?.props || {}
            const className = childProps.className || ''
            const match = /language-(\w+)/.exec(className || '')
            const lang = match ? match[1] : 'text'
            
            // 提取代码内容
            const rawText = Array.isArray(childProps.children) ? childProps.children.join('') : String(childProps.children || '')
            // 去除 react-markdown 自动追加的换行
            let textContent = rawText.replace(/\n$/, '')
            
            const isLast = streaming && textContent.includes(STREAMING_TOKEN)
            const cleanText = textContent.replace(STREAMING_TOKEN, '')

            return <CodeBlock lang={lang} code={cleanText} showCursor={isLast} />
          },
          // 行内代码
          code(props: any) {
            const { children, className, node, ...rest } = props
            const textContent = Array.isArray(children) ? children.join('') : String(children || '')
            const isLast = streaming && textContent.includes(STREAMING_TOKEN)
            const cleanText = textContent.replace(STREAMING_TOKEN, '')
            return (
              <code className="inline-code" {...rest}>
                {cleanText}
                {isLast && <span className="streaming-cursor">▊</span>}
              </code>
            )
          },
          // 行内格式劫持 (保证 token 在这些内部也能被安全移除)
          a: ({ children, ...props }) => <a {...props} className="msg-inline-link">{renderInline(children)}</a>,
          strong: ({ children, ...props }) => <strong {...props} className="msg-bold">{renderInline(children)}</strong>,
          em: ({ children, ...props }) => <em {...props} className="msg-italic">{renderInline(children)}</em>,
          del: ({ children, ...props }) => <del {...props} className="msg-strikethrough">{renderInline(children)}</del>,
          
          // 标题劫持
          h1: ({ children }) => <h1 className="msg-h1">{renderInline(children)}</h1>,
          h2: ({ children }) => <h2 className="msg-h2">{renderInline(children)}</h2>,
          h3: ({ children }) => <h3 className="msg-h3">{renderInline(children)}</h3>,
          h4: ({ children }) => <h4 className="msg-h3" style={{ fontSize: '15px' }}>{renderInline(children)}</h4>,
          h5: ({ children }) => <h5 className="msg-h3" style={{ fontSize: '14px' }}>{renderInline(children)}</h5>,
          h6: ({ children }) => <h6 className="msg-h3" style={{ fontSize: '13px' }}>{renderInline(children)}</h6>,
          
          // 表格劫持
          table: ({ children }) => (
            <div className="msg-table-wrapper">
              <table className="msg-table">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="msg-table-thead">{children}</thead>,
          tbody: ({ children }) => <tbody className="msg-table-tbody">{children}</tbody>,
          th: ({ children }) => <th className="msg-table-th">{renderInline(children)}</th>,
          td: ({ children }) => <td className="msg-table-td">{renderInline(children)}</td>,
          
          // 文本劫持
          p: ({ children }) => <p className="msg-p">{renderInline(children)}</p>,
          li: ({ children }) => <li className="msg-list-item"><span className="msg-list-bullet">•</span><span className="msg-list-content">{renderInline(children)}</span></li>,
          blockquote: ({ children }) => (
            <blockquote className="blockquote-block">{children}</blockquote>
          )
        }}
      >
        {renderContent}
      </ReactMarkdown>

      {streaming && !content && !reasoning && (
        <div className="msg-empty-streaming">
          <span className="streaming-cursor">▊</span>
        </div>
      )}
    </div>
  )
}