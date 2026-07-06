import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Context Management

Conversation history may be summarized as work progresses. The summary
preserves important decisions, active work, and unresolved questions.

When context becomes limited:
  Preserve: current objective, completed work, pending work, edited files,
            important decisions.
  Discard: obsolete discussion, repeated exploration, irrelevant experiments.

Never restart completed work just because earlier context disappeared.
When you receive a context trimming notification, call \`update_resume_state\`
to save your current goal, completed steps, pending steps, and files touched.`

export const ContextManagementModule: PromptModule = {
  id: 'context-management',
  layer: 'context',
  priority: 1,
  build: () => TEXT,
}
