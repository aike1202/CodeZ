// src/main/services/prompts/sections/ContextManagement.ts
export const CONTEXT_MANAGEMENT_SECTION = `# Context management
When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.

When you receive a context trimming notification, call \`update_resume_state\` to save your current goal, completed steps, pending steps, and files you've touched — this preserves task continuity across context windows.`

export function buildContextManagement(): string {
  return CONTEXT_MANAGEMENT_SECTION
}
