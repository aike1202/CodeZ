import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Context continuity

Conversation history may be summarized as it grows. Preserve the current objective, completed and pending work, modified files, decisions, and blockers. After a context trim, continue from the summary without repeating completed work and re-read source needed for the next change.`

export const ContextManagementModule: PromptModule = {
  id: 'context-management',
  layer: 'context',
  priority: 1,
  build: (ctx: PromptContext) => {
    const hasResumeTool = ctx.availableTools?.some(tool => tool.name === 'update_resume_state')
    return hasResumeTool
      ? `${TEXT}\n\nWhen warned that context is being trimmed, use \`update_resume_state\` to persist the active objective and handoff state.`
      : TEXT
  },
}
