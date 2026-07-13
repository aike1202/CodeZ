import { Tool, ToolContext } from '../Tool'
import { findSessionSkillState } from '../../services/context/SessionSkillState'

interface DeactivateSkillArgs {
  skill?: string
  mode?: 'inactive' | 'disabled'
  reason?: string
}

export class DeactivateSkillTool extends Tool {
  get name() {
    return 'DeactivateSkill'
  }

  get summary() {
    return 'Deactivate or session-disable a skill.'
  }

  get description() {
    return 'Stop applying a skill in the current conversation. Use mode="inactive" when the workflow is merely finished and may be needed again. Use mode="disabled" when the user says not to use that skill again in this conversation. Disabled skills must remain disabled until the user explicitly asks to re-enable them.'
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Exact active skill name.' },
        mode: {
          type: 'string',
          enum: ['inactive', 'disabled'],
          description: 'inactive allows later automatic activation; disabled blocks it for this conversation.'
        },
        reason: { type: 'string', description: 'Short reason for the state change.' }
      },
      required: ['skill']
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    try {
      const parsed = JSON.parse(args) as DeactivateSkillArgs
      if (!parsed.skill?.trim()) return 'Error: skill is required.'
      if (!context.runtimeCoordinator || !context.runtimeTurn) {
        return 'Error: DeactivateSkill requires an active conversation runtime.'
      }
      const scope = context.sessionId && context.contextScopeId
        ? await context.runtimeCoordinator.getScopeView(context.sessionId, context.contextScopeId)
        : undefined
      const current = findSessionSkillState(scope?.skillStates, parsed.skill)
      const name = current?.name || parsed.skill.trim()
      const status = parsed.mode === 'disabled' ? 'disabled' : 'inactive'
      if (current?.status === status) {
        return JSON.stringify({
          type: 'skill_state',
          status,
          skill: name,
          reason: current.reason,
          message: `Skill is already ${status} in this conversation.`
        })
      }
      await context.runtimeCoordinator.updateSkillState(context.runtimeTurn, {
        name,
        status,
        source: 'model',
        reason: parsed.reason
      })
      return JSON.stringify({
        type: 'skill_state',
        status,
        skill: name,
        reason: parsed.reason,
        message: status === 'disabled'
          ? 'Do not use this skill again in the current conversation unless the user explicitly asks to re-enable it.'
          : 'The skill is no longer active and may be activated later if a new request needs it.'
      })
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  }
}
