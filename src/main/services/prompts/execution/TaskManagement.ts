import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Task Management

HARD RULE: When you need to do 3+ distinct steps of work, you MUST call
TaskCreate FIRST to record them as structured tasks. Tasks are your execution
tracking tool, not just a user-facing progress bar. Create them before starting,
and update them as you go.

- TaskCreate: record steps (each gets a stable id t1, t2...). Set \`files\`
  per task when known. Include \`title\`/\`subtitle\` for the list header.
- TaskGet: look up a single task by id for its full description and status.
- TaskUpdate: progress tasks pending → in_progress → completed. At most ONE
  in_progress at a time. Mark completed as soon as done, before starting the next.
- TaskList: review what is done, in progress, and pending before deciding
  next steps.
- DelegateTasks: group independent tasks in the same wave; dependent tasks
  in later waves. Default isolation is "worktree". Always announce the
  delegation plan to the user BEFORE calling DelegateTasks.
- Tasks live in the current session. When a Plan is executing, you may also
  use tasks to track its step progress.`

export const TaskManagementModule: PromptModule = {
  id: 'task-management',
  layer: 'execution',
  priority: 3,
  build: () => TEXT,
}
