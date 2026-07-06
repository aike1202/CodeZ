import type { PromptModule, PromptContext } from '../PromptTypes'
import { RulesResolver } from '../../../agent/RulesResolver'

export const RepositoryRulesModule: PromptModule = {
  id: 'repository-rules',
  layer: 'context',
  priority: 2,
  isEnabled: async (ctx: PromptContext) => {
    const rules = await RulesResolver.getWorkspaceRules(ctx.workspaceRoot)
    return !!rules
  },
  build: async (ctx: PromptContext) => {
    const rules = await RulesResolver.getWorkspaceRules(ctx.workspaceRoot)
    return `<repository_instructions>\n${rules}\n</repository_instructions>`
  },
}
