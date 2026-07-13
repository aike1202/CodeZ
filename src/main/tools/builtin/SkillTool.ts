// src/main/tools/builtin/SkillTool.ts
import { Tool, ToolContext } from '../Tool'
import { SkillManager } from '../../services/SkillManager'
import {
  findSessionSkillState,
  hashSkillContent
} from '../../services/context/SessionSkillState'

interface SkillArgs {
  skill?: string
  args?: string
  force?: boolean
}

function stateMarker(value: Record<string, unknown>): string {
  return JSON.stringify({ type: 'skill_state', ...value })
}

async function activateSkill(rawArgs: string, context: ToolContext): Promise<string> {
  const parsed = JSON.parse(rawArgs) as SkillArgs
  if (!parsed.skill) return 'Error: skill is required.'

  const sm = SkillManager.getInstance()
  const skills = await sm.getSkills(context.workspaceRoot)
  const matched = skills.find((skill) =>
    skill.name === parsed.skill || skill.id === parsed.skill
  )
  const content = matched
    ? await sm.getSkillContent(context.workspaceRoot, matched.name)
    : null
  if (!content || !matched) {
    const list = skills.slice(0, 30).map((s) => `- ${s.name} (${s.id})`).join('\n')
    return `Error: skill "${parsed.skill}" not found. Available:\n${list || '(none)'}`
  }

  const args = parsed.args || ''
  const contentHash = hashSkillContent(content)
  const scope = context.runtimeCoordinator && context.sessionId && context.contextScopeId
    ? await context.runtimeCoordinator.getScopeView(context.sessionId, context.contextScopeId)
    : undefined
  const current = findSessionSkillState(scope?.skillStates, matched.name)
  if (current?.status === 'disabled' && !parsed.force) {
    return `Error: skill "${matched.name}" is disabled for this conversation. Only reactivate it with force=true after the user explicitly asks to re-enable it.`
  }
  const sameContent = current?.contentHash === contentHash || Boolean(
    current?.content && (content.includes(current.content) || current.content.includes(content))
  )
  if (current?.status === 'active' && current.args === args && sameContent && !parsed.force) {
    return stateMarker({
      status: 'already_active',
      skill: matched.name,
      contentHash,
      message: 'Continue following the active skill content already present in this conversation. Do not activate it again merely to reload it.'
    })
  }

  if (context.runtimeCoordinator && context.runtimeTurn) {
    await context.runtimeCoordinator.updateSkillState(context.runtimeTurn, {
      name: matched.name,
      status: 'active',
      content,
      contentHash,
      args,
      source: 'model'
    })
  }

  const escapeTag = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return [
    `<command-name>${escapeTag(matched.name)}</command-name>`,
    `<command-args>${escapeTag(args)}</command-args>`,
    content
  ].join('\n')
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
      return await activateSkill(args, context)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}

export class ActivateSkillTool extends Tool {
  get name() {
    return 'ActivateSkill'
  }

  get summary() {
    return 'Activate or refresh a session skill.'
  }

  get description() {
    return 'Activate a skill for the current conversation and load its instructions. Active skills persist across turns, compaction, network failures, and restart. Do not activate an already-active skill merely to reload it. A skill disabled for this conversation may only be reactivated with force=true after the user explicitly asks to re-enable it. The legacy Skill tool remains available for compatibility.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Exact available skill name or id.' },
        args: { type: 'string', description: 'Optional arguments for this activation.' },
        force: {
          type: 'boolean',
          description: 'Refresh active content or re-enable a session-disabled skill. Use for disabled skills only after an explicit user request.'
        }
      },
      required: ['skill']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      return await activateSkill(args, context)
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
