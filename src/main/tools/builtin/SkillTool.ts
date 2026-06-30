// src/main/tools/builtin/SkillTool.ts
import { Tool, ToolContext } from '../Tool'
import { SkillManager } from '../../services/SkillManager'

interface SkillArgs {
  skill?: string
  args?: string
}

export class SkillTool extends Tool {
  get name() {
    return 'Skill'
  }

  get description() {
    return 'Execute a skill within the main conversation. When users reference /<something> they mean a skill — set skill to the exact name (no leading slash); args for optional arguments. Available skills are listed in system-reminder messages. Only invoke a skill in that list, or one the user explicitly typed as /<name>. Never guess names. When a skill matches the request, this is a BLOCKING REQUIREMENT: invoke the Skill tool BEFORE any other response about the task. Never mention a skill without calling this tool. Do not invoke a skill that is already running. Returns the SKILL.md body for the model to follow.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Exact skill name or id (no leading slash).' },
        args: { type: 'string', description: 'Optional arguments for the skill.' }
      },
      required: ['skill']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as SkillArgs
      if (!parsed.skill) return 'Error: skill is required.'

      const sm = SkillManager.getInstance()
      const content = await sm.getSkillContent(context.workspaceRoot, parsed.skill)
      if (content) return content

      const skills = await sm.getSkills(context.workspaceRoot)
      const list = skills.slice(0, 30).map((s) => `- ${s.name} (${s.id})`).join('\n')
      return `Error: skill "${parsed.skill}" not found. Available:\n${list || '(none)'}`
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
