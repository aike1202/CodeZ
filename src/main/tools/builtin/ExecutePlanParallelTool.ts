import { Tool } from '../Tool'

/**
 * 并行执行已批准 Plan 的步骤。
 *
 * 实际执行由 AgentRunner 拦截（handleExecutePlanParallel），不走此 execute。
 * 调用前提：Plan 已 executing；ExecutionPlanner 已产出分波方案；用户已在确认框
 * 确认最终隔离档。主 Agent 携带最终 grouping + isolation 调用此工具。
 */
export class ExecutePlanParallelTool extends Tool {
  get name() {
    return 'ExecutePlanParallel'
  }

  get summary() {
    return 'Execute approved plan steps in parallel waves.'
  }

  get description() {
    return [
      'Execute the steps of an approved plan in parallel: steps in the same wave run concurrently,',
      'waves run in order, and execution halts on the first wave that has a failure.',
      '',
      'Prerequisites:',
      '- The plan must be in "executing" status.',
      '- An ExecutionPlanner subagent should have produced the wave grouping first.',
      '- The user has confirmed the isolation mode.',
      '',
      'Pass the final `grouping` (waves + isolation + rationale) and `isolation`. On completion you receive',
      'a ParallelExecutionReport. If status is "halted", fix the failed step(s) and call this tool again —',
      'already-completed steps are skipped automatically.',
    ].join('\n')
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        planSlug: {
          type: 'string',
          description: 'The slug of the approved plan to execute.',
        },
        grouping: {
          type: 'object',
          description: 'The execution grouping from ExecutionPlanner (after user confirmation).',
          properties: {
            waves: {
              type: 'array',
              description: 'Ordered waves. Each wave has an index and stepIds.',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'number' },
                  stepIds: { type: 'array', items: { type: 'string' } },
                },
                required: ['index', 'stepIds'],
              },
            },
            isolation: {
              type: 'string',
              enum: ['shared', 'worktree'],
              description: 'Isolation mode (may differ from the planner suggestion if the user changed it).',
            },
            rationale: { type: 'string', description: 'One-sentence grouping rationale.' },
          },
          required: ['waves', 'isolation', 'rationale'],
        },
        isolation: {
          type: 'string',
          enum: ['shared', 'worktree'],
          description: 'Final isolation mode chosen by the user. Overrides grouping.isolation if provided.',
        },
      },
      required: ['planSlug', 'grouping'],
    }
  }

  async execute(): Promise<string> {
    // 实际执行逻辑在 AgentRunner 拦截中处理，不会执行到这里
    return JSON.stringify({
      ok: true,
      data: {
        status: 'intercepted',
        message: 'ExecutePlanParallel should be intercepted by AgentRunner.',
      },
    })
  }
}
