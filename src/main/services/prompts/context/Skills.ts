import type { PromptModule, PromptContext } from '../PromptTypes'
export const SkillsModule: PromptModule = {
  id: 'skills',
  layer: 'context',
  priority: 5,
  build: (ctx: PromptContext) => {
    const active = ctx.activeSkills || []
    if (active.length === 0) return ''
    const hasActivateSkillTool = ctx.availableTools?.some(tool =>
      tool.name === 'ActivateSkill' || tool.name === 'Skill'
    ) ?? true
    const hasDeactivateSkillTool = ctx.availableTools?.some(tool => tool.name === 'DeactivateSkill') ?? true
    const lines: string[] = []
    lines.push('<skills_instructions>')
    lines.push(hasActivateSkillTool
      ? 'When an available skill matches the request, activate it with ActivateSkill before doing the task. The legacy Skill tool is only a compatibility fallback.'
      : 'Follow a skill only when its instructions are already present in the conversation.')
    lines.push('The latest <session_skill_state> block is authoritative for this conversation.')
    lines.push('Continue following active skills without activating them again merely to reload their instructions.')
    lines.push('Do not use inactive skills unless the current request needs them. Never activate a disabled skill unless the user explicitly asks to re-enable it; then use ActivateSkill with force=true.')
    if (hasDeactivateSkillTool) {
      lines.push('When the user asks you to stop using a skill in this conversation, call DeactivateSkill with mode="disabled" before continuing. Use mode="inactive" only when a completed workflow may be needed again later.')
    }
    lines.push('If /<skill-name> has expanded into the current request, follow it directly; it is an explicit user activation and must not trigger another ActivateSkill call.')
    lines.push('')
    for (const skill of active) {
      lines.push(`- ${skill.name}: ${skill.description}`)
    }
    lines.push('</skills_instructions>')
    return lines.join('\n')
  },
}
