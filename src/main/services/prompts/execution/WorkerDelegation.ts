import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Subagents

Use a subagent when a specialist matches the work, independent tasks can run in parallel, or substantial intermediate output is better kept out of the main context. Do the work directly for simple requests, directed lookups, or tightly sequential changes. File count alone is never a reason to delegate.

Understand the task before delegating, give the subagent a self-contained brief, and do not duplicate its work. The parent remains responsible for interpreting the result, resolving failures, and completing the user's request.`

export const WorkerDelegationModule: PromptModule = {
  id: 'worker-delegation',
  layer: 'dynamic',
  priority: 7,
  isEnabled: (ctx: PromptContext) => !ctx.availableTools ||
    ctx.availableTools.some(tool => tool.name === 'SubAgentRunner' || tool.name === 'spawn_agent'),
  build: () => TEXT,
}
