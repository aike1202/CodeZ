import { RulesResolver } from '../../agent/RulesResolver'
import { GitContextService } from '../GitContextService'
import { SkillManager } from '../SkillManager'
import type { PromptContext } from './PromptTypes'

export async function resolvePromptContext(
  ctx: PromptContext,
  options: { includeGit?: boolean } = {}
): Promise<PromptContext> {
  const [globalRules, workspaceRules, activeSkills, gitStatus] = await Promise.all([
    ctx.globalRules !== undefined ? ctx.globalRules : RulesResolver.getGlobalRules(),
    ctx.workspaceRules !== undefined ? ctx.workspaceRules : RulesResolver.getWorkspaceRules(ctx.workspaceRoot),
    ctx.activeSkills !== undefined
      ? ctx.activeSkills
      : SkillManager.getInstance().getActiveSkills(ctx.workspaceRoot),
    ctx.gitStatus !== undefined
      ? ctx.gitStatus
      : options.includeGit
        ? GitContextService.getSnapshot(ctx.workspaceRoot)
        : ''
  ])

  return {
    ...ctx,
    availableTools: ctx.availableTools || [],
    deferredTools: ctx.deferredTools || [],
    globalRules,
    workspaceRules,
    directoryRules: ctx.directoryRules ?? RulesResolver.getLoadedDirectoryRules(ctx.sessionId),
    activeSkills: activeSkills.map(skill => ({ name: skill.name, description: skill.description })),
    gitStatus
  }
}
