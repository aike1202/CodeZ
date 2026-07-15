import { Tool } from '../Tool'
import { SubAgentManager } from '../../agent/SubAgentManager'

abstract class InterceptedAgentTool extends Tool {
  async execute(): Promise<string> {
    return JSON.stringify({
      ok: false,
      error: `${this.name} must be intercepted by the active Agent runtime.`
    })
  }
}

export class SpawnAgentTool extends InterceptedAgentTool {
  get name() { return 'spawn_agent' }
  get summary() { return 'Start an addressable SubAgent in the background.' }
  get description() {
    const types = SubAgentManager.listEnabledDefinitions().map((definition) => definition.type).join(', ')
    return [
      'Start a SubAgent asynchronously and return its agent ID and path immediately.',
      'If its result is required, use wait_agent only while agent_runtime_state still lists it as queued/running.',
      'FINAL_ANSWER or a terminal runtime status means it is finished; never wait for it again.',
      `Available types: ${types || '(none)'}.`
    ].join(' ')
  }
  get parameters_schema() {
    const types = SubAgentManager.listEnabledDefinitions().map((definition) => definition.type)
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        subagent_type: { type: 'string', enum: types.length ? types : ['Explore'] },
        task_name: {
          type: 'string',
          pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$',
          description: 'Stable address segment, for example api_review.'
        },
        description: { type: 'string', description: 'Short UI label for this delegated task.' },
        message: { type: 'string', description: 'Self-contained task instructions.' },
        context: { type: 'string', description: 'Known context that prevents duplicated exploration.' },
        expectations: {
          type: 'object',
          additionalProperties: false,
          properties: {
            questions: { type: 'array', items: { type: 'string' } },
            outOfScope: { type: 'array', items: { type: 'string' } }
          }
        },
        scope: {
          type: 'object',
          additionalProperties: false,
          properties: {
            directories: { type: 'array', items: { type: 'string' } },
            excludeGlobs: { type: 'array', items: { type: 'string' } }
          }
        },
        depth: { type: 'string', enum: ['quick', 'normal', 'exhaustive'] },
        allowed_write_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Executor only: exact workspace files this background Agent may modify.'
        }
      },
      required: ['subagent_type', 'task_name', 'description', 'message']
    }
  }
}

export class FollowupTaskTool extends InterceptedAgentTool {
  get name() { return 'followup_task' }
  get summary() { return 'Run a new task in an existing SubAgent context.' }
  get description() {
    return 'Start a new turn in an idle, completed, failed, or interrupted SubAgent while preserving its durable history.'
  }
  get parameters_schema() {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Agent ID or canonical path.' },
        message: { type: 'string', description: 'The new self-contained follow-up task.' }
      },
      required: ['target', 'message']
    }
  }
}

