import { Tool, ToolContext } from '../Tool'

export class EnterPlanModeTool extends Tool {
  get name() {
    return 'EnterPlanMode'
  }

  get summary() {
    return 'Enter plan mode for complex task planning.'
  }

  get description() {
    return [
      'Propose entering Plan Mode to design an implementation plan.',
      'Call this tool when ANY of the following apply:',
      '- Implementing a new feature with architectural decisions',
      '- Multiple valid technical approaches exist',
      '- Changes will affect more than 2-3 files',
      '- Requirements are unclear and need exploration',
      '',
      'Do NOT call this tool for: simple fixes, single-line changes, or pure research tasks.',
      '',
      'When called, the user will be asked to confirm. If approved, a Plan SubAgent will explore the codebase and create a plan.',
      'Wait for the plan to be injected into your context as <active_plan> before proceeding with execution.'
    ].join('\n')
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {},
      required: []
    }
  }

  async execute(args: string, context: ToolContext): Promise<string> {
    // 实际执行逻辑在 AgentRunner 拦截中处理，不会执行到这里
    // AgentRunner 拦截调用 -> 弹出确认 -> 启动 SubAgent -> 返回 SubAgent 结果
    return JSON.stringify({
      ok: true,
      data: {
        status: 'intercepted',
        message: 'EnterPlanMode should be intercepted by AgentRunner.'
      }
    })
  }
}
