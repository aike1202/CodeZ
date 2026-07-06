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

  get summary() {
    return 'Invoke a skill by name.'
  }

  get description() {
    return 'Execute a skill within the main conversation. When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge. When users reference a "slash command" or "/<something>", they are referring to a skill. Use this tool to invoke it. How to invoke: set skill to the exact name of an available skill (no leading slash); set args to pass optional arguments. Important: available skills are listed in system-reminder messages in the conversation. Only invoke a skill that appears in that list, or one the user explicitly typed as /<name> in their message. Never guess or invent a skill name from training data; otherwise do not call this tool. When a skill matches the user\'s request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task. NEVER mention a skill without actually calling this tool. Do not invoke a skill that is already running. If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded — follow the instructions directly instead of calling this tool again. Returns the SKILL.md body for the model to follow.'
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
