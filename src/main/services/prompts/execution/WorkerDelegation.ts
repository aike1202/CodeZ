import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Worker Delegation

Delegate tasks to Worker subagents when:
- Several tasks/plan-steps are independent and can run in parallel.
- Tasks touch disjoint files (shared isolation) or you use worktree isolation.

Do NOT delegate:
- Single, trivial tasks that take less work to do than to delegate.
- Tasks with strict sequential dependencies (do them yourself with TaskUpdate).
- Tasks that need real-time user feedback during execution.

When delegating, explain the wave grouping and isolation choice to the user
BEFORE calling DelegateTasks or ExecutePlanParallel.

Workers run in waves: all tasks in a wave start together; the next wave waits
for the previous to complete. If any task in a wave fails, execution halts.
Already-completed tasks are skipped on retry.`

export const WorkerDelegationModule: PromptModule = {
  id: 'worker-delegation',
  layer: 'execution',
  priority: 5,
  build: () => TEXT,
}
