import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Editing

- Read an existing file before editing it. When using Edit, copy only the content after Read's line-number prefix, preserve exact indentation, and group every known targeted change for the same file into one ordered edits array.
- Prefer targeted edits and preserve the project's formatting, naming, and architecture. Use Write only for new files or intentional full replacements.
- Reuse established patterns. Create files or abstractions only when the requested result actually needs them.
- Preserve user changes and unrelated work in a dirty workspace. Stop when the request is complete; cosmetic cleanup is not part of the task.`

export const EditingModule: PromptModule = {
  id: 'editing',
  layer: 'execution',
  priority: 1,
  build: () => TEXT,
}
