import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Task tracking

Task tools are optional bookkeeping. Use them when substantial work benefits from durable progress tracking or has meaningful dependencies. Do not create a task list for a simple request merely because it contains several actions or files. If you use tasks, keep statuses current and continue through executable work without repeatedly asking whether to proceed.`

export const TaskManagementModule: PromptModule = {
  id: 'task-management',
  layer: 'dynamic',
  priority: 6,
  isEnabled: (ctx: PromptContext) => !ctx.availableTools ||
    ctx.availableTools.some(tool => tool.name === 'TaskCreate' || tool.name === 'TaskUpdate'),
  build: () => TEXT,
}
