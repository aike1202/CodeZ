import type { PromptModule, PromptContext } from '../PromptTypes'
import { RulesResolver } from '../../../agent/RulesResolver'

export const WorkspaceRulesModule: PromptModule = {
  id: 'workspace-rules',
  layer: 'dynamic',
  priority: 1,
  isEnabled: async (ctx: PromptContext) => {
    const rules = await RulesResolver.getWorkspaceRules(ctx.workspaceRoot)
    return !!rules
  },
  build: async (ctx: PromptContext) => {
    const rules = await RulesResolver.getWorkspaceRules(ctx.workspaceRoot)
    return `<workspace_rules>\n${rules}\n</workspace_rules>`
  },
}
