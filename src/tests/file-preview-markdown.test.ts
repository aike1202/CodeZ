import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  FileContentRenderer,
  getLanguageFromPath
} from '../renderer/src/components/FilePreviewPanel/components/FileContentRenderer'

describe('Markdown file preview modes', () => {
  it('recognizes both Markdown file extensions case-insensitively', () => {
    expect(getLanguageFromPath('docs/README.MD')).toBe('markdown')
    expect(getLanguageFromPath('docs/guide.markdown')).toBe('markdown')
    expect(getLanguageFromPath('src/guide.ts')).toBe('typescript')
  })

  it('renders the visual preview by default with both view controls', () => {
    const html = renderToStaticMarkup(
      React.createElement(FileContentRenderer, {
        code: '# Preview heading',
        filePath: 'README.md',
        onFileClick: () => {}
      })
    )

    expect(html).toContain('aria-label="Markdown 查看方式"')
    expect(html).toContain('>原格式</span>')
    expect(html).toContain('>可视化</span>')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Preview heading')
  })
})
