import { Tool } from '../Tool'
import { SubAgentManager } from '../../agent/SubAgentManager'

/**
 * 通用子智能体调度工具。
 * 主 Agent 调用此工具来 spawn 一个子智能体处理委派任务。
 * 实际执行由 AgentRunner 拦截（handleTaskSpawn），不走此 execute。
 *
 * 新增子智能体只需 SubAgentManager.register(...)，无需改此工具或 AgentRunner。
 */
export class TaskTool extends Tool {
  get name() {
    return 'Task'
  }

  get description() {
    const defs = SubAgentManager.listDefinitions()
    const typeLines =
      defs.length > 0
        ? defs.map((d) => `  - ${d.type}: ${d.description}`).join('\n')
        : '  (none registered)'
    return [
      'Launch a subagent to handle a delegated task. The subagent runs in its own message loop and returns a result to you.',
      'Use this to parallelize work, isolate context, or delegate specialized analysis.',
      '',
      'Available subagent types:',
      typeLines,
      '',
      'Guidelines:',
      '- Provide a self-contained `prompt`; the subagent does NOT see your conversation history.',
      '- `description` is a short label (max 60 chars) shown in the execution log.',
      '- The subagent result is returned as the tool output; summarize it for the user.'
    ].join('\n')
  }

  get parameters_schema() {
    const defs = SubAgentManager.listDefinitions()
    const types = defs.map((d) => d.type)
    return {
      type: 'object',
      properties: {
        subagent_type: {
          type: 'string',
          enum: types.length > 0 ? types : ['Research'],
          description: 'The type of subagent to launch.'
        },
        description: {
          type: 'string',
          description: 'A short (max 60 chars) description of the task, shown in the execution log.'
        },
        prompt: {
          type: 'string',
          description: 'The full task instructions for the subagent. Must be self-contained.'
        }
      },
      required: ['subagent_type', 'description', 'prompt']
    }
  }

  async execute(): Promise<string> {
    // 实际执行逻辑在 AgentRunner 拦截中处理，不会执行到这里
    return JSON.stringify({
      ok: true,
      data: {
        status: 'intercepted',
        message: 'Task should be intercepted by AgentRunner.'
      }
    })
  }
}
