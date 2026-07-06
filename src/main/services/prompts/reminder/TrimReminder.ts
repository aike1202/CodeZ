import type { PromptModule, PromptContext } from '../PromptTypes'

export const TrimReminderModule: PromptModule = {
  id: 'trim-reminder',
  layer: 'reminder',
  priority: 1,
  isEnabled: (ctx: PromptContext) => ctx.contextWindowTokens < 64000,
  build: () => `<system-reminder>
Context window is nearly full. Prioritize what remains:
- Keep the current task and active files in focus.
- Summarize or drop completed work.
- Delegate new exploration to subagents rather than reading files directly.
</system-reminder>`,
}
