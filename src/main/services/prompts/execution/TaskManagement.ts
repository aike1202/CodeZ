import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Task Policy

## Purpose
Track meaningful multi-step work and execute it to completion.

## Policy
- Create tasks only for meaningful multi-step work.
- Create the complete task list before execution.
- Keep only one task In Progress unless work is delegated.
- After completing a task, immediately start the next executable task.
- Continue execution automatically while executable tasks remain.
- Skip blocked tasks and continue with other executable work when possible.
- Stop only when all tasks are complete or a defined stopping condition is reached.

## Stopping Conditions
- User confirmation required.
- Missing required information.
- Permission approval required.
- Unrecoverable error.
- External dependency blocks progress.

## Never
- Stop after completing a single task.
- Ask whether to continue after every task.
- Create duplicate task lists.
- Leave completed tasks In Progress.

## Golden Rule
A task list represents one continuous execution. Continue executing consecutive tasks until the entire task list is complete or a stopping condition is reached.`

export const TaskManagementModule: PromptModule = {
  id: 'task-management',
  layer: 'execution',
  priority: 6,
  build: () => TEXT,
}
