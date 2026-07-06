import { Tool } from '../Tool'

/**
 * 将当前会话的若干 Task 委派给多个 Worker 并行执行。
 *
 * 实际执行由 AgentRunner 拦截（handleDelegateTasks），不走此 execute。
 * 模型手动传入分波方案（哪些 Task 可并行）；默认 worktree 隔离。
 */
export class DelegateTasksTool extends Tool {
  get name() {
    return 'DelegateTasks'
  }

  get description() {
    return [
      'Delegate session tasks to parallel Worker subagents. Tasks in the same wave run concurrently;',
      'waves run in order; execution halts on the first wave with a failure.',
      '',
      'You decide the grouping: put tasks that can run independently in the same wave, and put a task',
      'in a later wave if it depends on an earlier one. Tasks that touch the same files must NOT share a',
      'wave (they will be rejected in "shared" isolation, or may cause merge conflicts in "worktree").',
      '',
      'Isolation:',
      '- "worktree" (default): each Worker gets its own git worktree, merged back after each wave. Safest.',
      '- "shared": Workers write directly to the workspace; only use when each wave writes disjoint files.',
      '',
      'Prerequisites: create the tasks first with TaskCreate. Reference them here by id (t1, t2 ...).',
      '',
      'When you call this tool, the user will see a confirmation dialog showing which tasks go to',
      'which Worker wave. If the user approves, Workers run in parallel. If the user chooses',
      '"Run sequentially", you will receive a `user_chose_sequential` status — then proceed task',
      'by task with TaskUpdate yourself.',
      '',
      'On completion you receive a report. If status is "halted", fix the failed task(s) and call again —',
      'already-completed tasks are skipped automatically.'
    ].join('\n')
  }

  get parameters_schema() {
    return {
      type: 'object',
      properties: {
        waves: {
          type: 'array',
          description: 'Ordered waves. Each wave runs its taskIds in parallel.',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number', description: 'Wave order, starting at 0.' },
              taskIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Task ids to run in parallel in this wave (e.g. ["t1", "t2"]).'
              }
            },
            required: ['index', 'taskIds']
          }
        },
        isolation: {
          type: 'string',
          enum: ['shared', 'worktree'],
          description: 'Isolation mode. Defaults to "worktree" if omitted.'
        },
        rationale: {
          type: 'string',
          description: 'One-sentence explanation of the grouping.'
        }
      },
      required: ['waves']
    }
  }

  async execute(): Promise<string> {
    // 实际执行逻辑在 AgentRunner 拦截中处理，不会执行到这里
    return JSON.stringify({
      ok: true,
      data: {
        status: 'intercepted',
        message: 'DelegateTasks should be intercepted by AgentRunner.'
      }
    })
  }
}
