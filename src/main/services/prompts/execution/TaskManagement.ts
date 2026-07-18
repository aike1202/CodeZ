import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Todo tracking

Todo tools are optional durable collaboration state. Use them when substantial work benefits from visible progress, resumability, approval, or meaningful dependencies. Do not create a Todo list for a simple request merely because it contains several actions or files.

Todo items describe work, not Agent or Executor instances. The authoritative todo_state is injected into every model round; there are no TodoGet or TodoList tools. Create related items in one TodoCreate call. Use one atomic TodoUpdate batch for related transitions such as completing the current item and starting the next, with expectedRevision at the request root. Keep at most one item in_progress and obey dependency and approval gates. A revision conflict includes the latest bounded state; rebase once instead of blindly retrying stale arguments.

Todo bookkeeping never replaces concise user-facing progress updates.`

export const TodoManagementModule: PromptModule = {
  id: 'todo-management',
  layer: 'dynamic',
  priority: 6,
  isEnabled: (ctx: PromptContext) => !ctx.availableTools ||
    ctx.availableTools.some(tool => tool.name === 'TodoCreate' || tool.name === 'TodoUpdate'),
  build: () => TEXT,
}
