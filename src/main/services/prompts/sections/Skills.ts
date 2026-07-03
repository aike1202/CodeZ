// src/main/services/prompts/sections/Skills.ts
import { SkillManager } from '../../SkillManager'
import type { SkillDefinition } from '../../../../shared/types/skill'

export async function buildSkills(workspaceRoot: string): Promise<string> {
  const sm = SkillManager.getInstance()
  const activeSkills: SkillDefinition[] = await sm.getActiveSkills(workspaceRoot)
  if (activeSkills.length === 0) return ''

  const lines: string[] = []
  lines.push('<skills_instructions>')
  lines.push('Below is the list of active skills. Each entry includes a name, description, and file path.')
  lines.push('When a skill matches the user\'s request, invoke it via the Skill tool — it returns the SKILL.md body to follow. If the user manually triggers a skill with /<skill-name>, it has ALREADY been loaded as <command-message>; do not call Skill again — look for <command-message> in recent messages instead.')
  lines.push('')
  for (const skill of activeSkills) {
    lines.push(`- ${skill.name} (id: ${skill.id}): ${skill.description}`)
    lines.push(`  Path: ${skill.path || 'Unknown'}`)
  }
  lines.push('</skills_instructions>')
  return lines.join('\n')
}
