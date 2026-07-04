import { useEffect, useState, useMemo } from 'react'

/**
 * detail 区的 markdown 渲染器。
 *
 * 性能考量：react-markdown + remark-gfm 是重型同步解析库，
 * 首次 import 与解析开销显著。AskUserQuestionWidget 卡片出现速度对此敏感，
 * 因此：
 *  1. 仅在确有 detail 内容时才动态 import 这两个库（代码分割）；
 *  2. 加载完成前先渲染纯文本（保留换行），避免空白/卡顿；
 *  3. 加载后替换为 markdown 渲染结果。
 */
type MarkdownModule = typeof import('react-markdown') & { default?: any }

// 模块级缓存：同会话内多次提问只加载一次
let markdownPromise: Promise<any> | null = null
let MarkdownComp: any = null
let GfmPlugin: any = null

function loadMarkdown(): Promise<any> {
  if (MarkdownComp) return Promise.resolve(MarkdownComp)
  if (!markdownPromise) {
    markdownPromise = Promise.all([
      import('react-markdown'),
      import('remark-gfm')
    ]).then(([md, gfm]) => {
      const mdModule = md as MarkdownModule
      const gfmModule = gfm as any
      MarkdownComp = mdModule.default || mdModule
      GfmPlugin = gfmModule.default || gfmModule
      return MarkdownComp
    })
  }
  return markdownPromise
}

export default function MarkdownDetail({ content }: { content: string }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    loadMarkdown().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  // 加载中：纯文本预览（保留换行，避免布局跳动）
  const fallback = useMemo(() => <pre className="ask-user-detail-fallback">{content}</pre>, [content])

  if (!ready || !MarkdownComp) return fallback
  return (
    <MarkdownComp remarkPlugins={GfmPlugin ? [GfmPlugin] : []}>{content}</MarkdownComp>
  )
}
