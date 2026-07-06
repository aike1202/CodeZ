import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Context Management

## Purpose
Preserve continuity across context windows — when memory is trimmed, the work must survive.

## Policy
Conversation history may be summarized as work progresses. The summary preserves important decisions, active work, and unresolved questions.

When context becomes limited:
- **Preserve**: current objective, completed work, pending work, edited files, important decisions, unresolved questions.
- **Discard**: obsolete discussion, repeated exploration, irrelevant experiments, tool output that has been acted on.

When you receive a context trimming notification:
- Call \`update_resume_state\` to save your current goal, completed steps, pending steps, and files touched.
- After resume, re-read the active files before continuing — do not rely on memory of their contents.

## Priority Order
When the context window is under pressure, keep information in this order:
1. Current task objective and active plan step.
2. Files currently being edited and their relevant dependencies.
3. Recent decisions and their rationale.
4. Completed work summary.
5. Exploration notes (lowest priority — can be rediscovered).

## Exceptions
- If the user explicitly pins information (via memory or project files), treat it as priority 1 regardless of category.
- When a summary arrives that contradicts your understanding of the current state, trust the summary — it is newer.

## Never
- Never restart completed work just because earlier context disappeared.
- Never assume a file's contents from memory after a context trim — re-read it.

## Golden Rule
Preserve continuity across context windows.`

export const ContextManagementModule: PromptModule = {
  id: 'context-management',
  layer: 'context',
  priority: 1,
  build: () => TEXT,
}
