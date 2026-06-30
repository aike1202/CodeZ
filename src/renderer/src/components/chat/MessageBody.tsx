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

  // 辅助函数，将子节点中的纯字符串丢给 parseInline，其余保留
  const renderInline = (children: React.ReactNode, showCursor = false) => {
    if (typeof children === 'string') {
      return parseInline(children, onFileClick, showCursor, validFiles)
    }
    if (Array.isArray(children)) {
      return children.map((c, i) => (
        <React.Fragment key={i}>
          {typeof c === 'string'
            ? parseInline(c, onFileClick, showCursor && i === children.length - 1, validFiles)
            : c}
        </React.Fragment>
      ))
    }
    return children
  }

  // 打字机光标标记：在末尾追加不可见的标识字符
  const STREAMING_TOKEN = ' __STREAMING__ '
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
            // react-markdown passes an array of strings or single string
            const rawText = Array.isArray(childProps.children) ? childProps.children.join('') : String(childProps.children || '')
            // trim trailing newline that react-markdown might add
            let textContent = rawText.replace(/\n$/, '')
            
            const isLast = streaming && textContent.includes(STREAMING_TOKEN)
            const cleanText = textContent.replace(STREAMING_TOKEN, '')

            return <CodeBlock lang={lang} code={cleanText} showCursor={isLast} />
          },
          // 行内代码
          code(props: any) {
            const { children, className, node, ...rest } = props
            const textContent = Array.isArray(children) ? children.join('') : String(children || '')
            const cleanText = textContent.replace(STREAMING_TOKEN, '')
            return <code className="inline-code" {...rest}>{cleanText}</code>
          },
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
          p: ({ children }) => {
            const isLast = streaming && String(children).includes(STREAMING_TOKEN)
            const cleanChildren = React.Children.map(children, (child) =>
              typeof child === 'string' ? child.replace(STREAMING_TOKEN, '') : child
            )
            return <p className="msg-p">{renderInline(cleanChildren, isLast)}</p>
          },
          li: ({ children }) => {
            const isLast = streaming && String(children).includes(STREAMING_TOKEN)
            const cleanChildren = React.Children.map(children, (child) =>
              typeof child === 'string' ? child.replace(STREAMING_TOKEN, '') : child
            )
            return <li className="msg-list-item">{renderInline(cleanChildren, isLast)}</li>
          },
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