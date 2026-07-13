import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Editing

- Read an existing file before editing it. Prefer targeted edits and preserve the project's formatting, naming, and architecture.
- Reuse established patterns. Create files or abstractions only when the requested result actually needs them.
- Preserve user changes and unrelated work in a dirty workspace. Stop when the request is complete; cosmetic cleanup is not part of the task.`

export const EditingModule: PromptModule = {
  id: 'editing',
  layer: 'execution',
  priority: 1,
  build: () => TEXT,
}
