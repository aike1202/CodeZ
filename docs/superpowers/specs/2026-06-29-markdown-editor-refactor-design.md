# Markdown Editor Refactor Design

## Goal Description
The current `MarkdownEditor` component is a custom implementation that superimposes a `textarea` over a `<pre>` block to achieve syntax highlighting. This approach lacks advanced code editing features (like line numbers and code folding), feels clunky, and is hard to maintain. This refactoring will replace the custom editor with a robust third-party solution, `@uiw/react-codemirror`, providing a much better "VS Code-like" editing experience while retaining existing UI structure.

## Architecture & Components

- **Library**: `npm install @uiw/react-codemirror @codemirror/lang-markdown`
- **Target File**: `src/renderer/src/components/ui/MarkdownEditor.tsx` and `src/renderer/src/components/ui/MarkdownEditor.css`.
- **Component Changes**:
  - Keep the dual-tab structure (`Source` vs `Preview`).
  - Keep the `Preview` mode using `MessageBody`.
  - In `Source` mode, replace the `<div className="md-editor-source-wrapper">` and its children (`pre`, `code`, `textarea`) with `<CodeMirror>`.
- **Style Cleanup**:
  - Remove all CSS hacks in `MarkdownEditor.css` related to transparent text areas, scroll syncing, and absolute positioning of the `pre` block.
  - Apply basic layout styles to ensure `<CodeMirror>` fills its container properly.

## Data Flow
- Interface `MarkdownEditorProps` remains unchanged (`value`, `onChange`, `placeholder`, `className`, `style`).
- `<CodeMirror>` directly binds to `value` and updates via `onChange(value)`.
- No changes required in parent components (e.g., `SettingsRulesTab`).

## Verification Plan
- **Build**: Ensure the application compiles without errors after swapping the dependency.
- **Manual Verification**: 
  1. Open the Rules Settings tab (which uses `MarkdownEditor`).
  2. Verify that line numbers and markdown syntax highlighting are working.
  3. Verify that typing and scrolling behave normally.
  4. Switch to Preview mode and ensure the markdown is correctly rendered.
