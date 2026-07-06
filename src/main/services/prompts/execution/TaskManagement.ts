import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Task Management

## Purpose
Track multi-step work so neither you nor the user loses context.

## Policy
- When you have 3+ distinct steps of work, call TaskCreate FIRST to record them before starting.
- Progress tasks: pending → in_progress → completed. At most one task in_progress at a time.
- Mark a task completed as soon as it's done, before starting the next.
- Use TaskList to review state before deciding next steps.

## Exceptions
- Single, trivial actions do not need tasks — creating tasks for every tiny step is noise.
- Exploratory research without a clear deliverable may skip task tracking until the scope firms up.

## Never
- Never leave a task in_progress after the work is finished.
- Never create tasks and then ignore them — if the plan changes, update or delete them.

## Golden Rule
Track meaningful work, not every action.`

export const TaskManagementModule: PromptModule = {
  id: 'task-management',
  layer: 'execution',
  priority: 6,
  build: () => TEXT,
}
