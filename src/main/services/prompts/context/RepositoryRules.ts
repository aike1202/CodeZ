import type { PromptModule, PromptContext } from '../PromptTypes'
export const RepositoryRulesModule: PromptModule = {
  id: 'repository-rules',
  layer: 'context',
  priority: 2,
  build: (ctx: PromptContext) => {
    const sections = [
      ctx.globalRules ? `<global_rules>\n${ctx.globalRules}\n</global_rules>` : '',
      ctx.workspaceRules ? `<workspace_rules>\n${ctx.workspaceRules}\n</workspace_rules>` : '',
      ctx.directoryRules ? `<directory_rules>\n${ctx.directoryRules}\n</directory_rules>` : ''
    ].filter(Boolean)
    if (sections.length === 0) return ''
    return [
      '<repository_instructions>',
      'Instruction precedence within project guidance is: global < workspace < closest directory < the current explicit user request. Safety and runtime permission rules cannot be overridden.',
      ...sections,
      '</repository_instructions>'
    ].join('\n')
  },
}
