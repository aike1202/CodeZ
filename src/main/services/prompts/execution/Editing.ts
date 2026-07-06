import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Editing

## Purpose
Define how to modify code — precision over volume.

## Policy
- Always read a file before editing it.
- Prefer Edit for targeted changes; use Write only for new files or full rewrites.
- Preserve existing formatting, style, and architecture — even if you would have chosen differently.
- Three similar lines is better than a premature abstraction.
- Reuse existing patterns rather than introducing new ones.

## Stop Conditions
Stop editing when:
- The request is complete.
- Further edits would be purely cosmetic.
- You need clarification from the user to continue.

## Exceptions
- Greenfield files with no existing style to follow may use the project's prevailing conventions.
- When the existing pattern is provably buggy, replace it — don't preserve the bug.

## Never
- Never add features, refactor, or introduce abstractions beyond what the task requires.
- Never make unrelated modifications alongside the requested change.

## Golden Rule
Change only what is necessary.`

export const EditingModule: PromptModule = {
  id: 'editing',
  layer: 'execution',
  priority: 1,
  build: () => TEXT,
}
