# Markdown Editor Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom textarea/pre-based markdown editor with `@uiw/react-codemirror` to provide a robust, VS Code-like editing experience with syntax highlighting and line numbers.

**Architecture:** We will replace the internal structure of `MarkdownEditor.tsx` in `source` mode with the `<CodeMirror>` component, binding its `value` and `onChange` props to the existing interface. The `preview` mode remains unchanged. We will clean up `MarkdownEditor.css`.

**Tech Stack:** React, `@uiw/react-codemirror`, `@codemirror/lang-markdown`

## Global Constraints

- Keep the dual-tab (Source / Preview) UI structure intact.
- Do not modify the external interface `MarkdownEditorProps`.
- Ensure styling works well with the existing app theme.

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: N/A
- Produces: `@uiw/react-codemirror` and `@codemirror/lang-markdown` are available in the project.

- [ ] **Step 1: Install the libraries**

```bash
npm install @uiw/react-codemirror @codemirror/lang-markdown
```

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add codemirror dependencies for markdown editor"
```

---

### Task 2: Refactor MarkdownEditor Component

**Files:**
- Modify: `src/renderer/src/components/ui/MarkdownEditor.tsx`

**Interfaces:**
- Consumes: `MarkdownEditorProps`
- Produces: A refactored `MarkdownEditor` component that uses `<CodeMirror>`.

- [ ] **Step 1: Replace implementation in `MarkdownEditor.tsx`**

```tsx
import React, { useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
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
              theme="dark" // You can adjust this based on the app's global theme context if available
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
```

- [ ] **Step 2: Check for syntax errors**

```bash
npm run typecheck
```
Expected: PASS or no errors related to `MarkdownEditor.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/ui/MarkdownEditor.tsx
git commit -m "refactor: replace custom markdown editor with CodeMirror"
```

---

### Task 3: Clean up and Update Styles

**Files:**
- Modify: `src/renderer/src/components/ui/MarkdownEditor.css`

**Interfaces:**
- Consumes: `MarkdownEditor` class names.
- Produces: Cleaned up styling supporting CodeMirror layout.

- [ ] **Step 1: Update `MarkdownEditor.css`**

Replace the contents of `MarkdownEditor.css` to remove the old textarea hacks and ensure CodeMirror expands correctly:

```css
.md-editor-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  border: 1px solid var(--border-color, #333);
  border-radius: 6px;
  overflow: hidden;
  background-color: var(--bg-color, #1e1e1e);
}

.md-editor-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-color, #333);
  background-color: var(--tab-bg, #252526);
}

.md-tab-btn {
  padding: 8px 16px;
  background: none;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  font-size: 13px;
  border-right: 1px solid var(--border-color, #333);
  transition: all 0.2s;
}

.md-tab-btn:hover {
  background-color: var(--tab-hover, #2d2d2d);
  color: var(--text-color, #ccc);
}

.md-tab-btn.active {
  background-color: var(--bg-color, #1e1e1e);
  color: var(--text-color, #fff);
  border-bottom: 1px solid transparent;
  margin-bottom: -1px;
}

.md-editor-content {
  flex: 1;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}

.md-editor-source-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: auto;
}

.md-codemirror-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.md-codemirror-wrapper .cm-editor {
  height: 100%;
}

.md-editor-preview {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  color: var(--text-color, #fff);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/ui/MarkdownEditor.css
git commit -m "style: cleanup MarkdownEditor styles and adapt for CodeMirror"
```

---

### Task 4: Verify Application

- [ ] **Step 1: Check build**

```bash
npm run build
```
Expected: successful build

- [ ] **Step 2: Verify visually (Manual)**
Run `npm run dev` and open the app.
Navigate to the "规则设置" (Rules Settings) tab.
Verify that the Markdown editor shows line numbers and highlights markdown syntax properly.
Verify that switching between "Source" and "Preview" works without visual glitches.
