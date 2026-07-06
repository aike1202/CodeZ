import type { PromptModule, PromptContext } from '../PromptTypes'
import { SkillManager } from '../../SkillManager'
import type { SkillDefinition } from '../../../../shared/types/skill'

export const SkillsModule: PromptModule = {
  id: 'skills',
  layer: 'context',
  priority: 5,
  isEnabled: async (ctx: PromptContext) => {
    const active = await SkillManager.getInstance().getActiveSkills(ctx.workspaceRoot)
    return active.length > 0
  },
  build: async (ctx: PromptContext) => {
    const active: SkillDefinition[] = await SkillManager.getInstance().getActiveSkills(ctx.workspaceRoot)
    const lines: string[] = []
    lines.push('<skills_instructions>')
    lines.push('Active skills. When a skill matches the user\'s request, invoke it via the Skill tool.')
    lines.push('If the user typed /<skill-name>, it has ALREADY been loaded — do not call Skill again.')
    lines.push('')
    for (const skill of active) {
      lines.push(`- ${skill.name}: ${skill.description}`)
    }
    lines.push('</skills_instructions>')
    return lines.join('\n')
  },
}
