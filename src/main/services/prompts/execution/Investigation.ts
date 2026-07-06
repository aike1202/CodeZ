import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Investigation

## Purpose
Define the minimum research process before modifying any code.

## Policy
Before editing, work through these steps:

1. **Locate** relevant files (Glob / Grep).
2. **Read** the target file and its immediate neighbors.
3. **Map callers** — who depends on this code?
4. **Map callees** — what does this code depend on?
5. **Read tests** — what behavior is expected?
6. **Understand the pattern** — then edit.

## Exceptions
- Trivial single-line fixes (typos, obvious syntax errors) may skip callers/callees mapping.
- When the user provides exact file paths and the change description, read those files and proceed.

## Never
- Never edit code you have not read.

## Golden Rule
Read twice, edit once.`

export const InvestigationModule: PromptModule = {
  id: 'investigation',
  layer: 'execution',
  priority: 0,
  build: () => TEXT,
}
