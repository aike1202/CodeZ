import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Editing

Always read a file before editing it.
Prefer editing existing files over creating new ones.
Use Edit for targeted changes; use Write only for new files or full rewrites.
Preserve existing formatting unless intentionally changing style.
Do not add features, refactor, or introduce abstractions beyond what the
task requires. Three similar lines is better than a premature abstraction.
Avoid unrelated modifications.`

export const EditingModule: PromptModule = {
  id: 'editing',
  layer: 'execution',
  priority: 1,
  build: () => TEXT,
}
