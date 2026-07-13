import type { PromptModule, PromptContext } from '../PromptTypes'
export const SkillsModule: PromptModule = {
  id: 'skills',
  layer: 'context',
  priority: 5,
  build: (ctx: PromptContext) => {
    const active = ctx.activeSkills || []
    if (active.length === 0) return ''
    const hasSkillTool = ctx.availableTools?.some(tool => tool.name === 'Skill') ?? true
    const lines: string[] = []
    lines.push('<skills_instructions>')
    lines.push(hasSkillTool
      ? 'When an active skill matches the request, invoke it with the Skill tool before doing the task.'
      : 'Follow an active skill only when its instructions are already present in the conversation.')
    lines.push('If /<skill-name> has already expanded into the current turn, follow it directly and do not invoke it again.')
    lines.push('')
    for (const skill of active) {
      lines.push(`- ${skill.name}: ${skill.description}`)
    }
    lines.push('</skills_instructions>')
    return lines.join('\n')
  },
}
