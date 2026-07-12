import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Delegation

## Purpose
Define when to hand off work to subagents — preserve your context for decisions.

## When to Delegate
Delegate to subagents when:
- Several tasks or plan-steps are independent and can run in parallel.
- Exploration spans 3+ files or directories.
- A task is self-contained with clear inputs and outputs.

## When NOT to Delegate
Do NOT delegate:
- Single, trivial tasks that take less work to delegate than to do.
- Tasks with strict sequential dependencies — do them yourself with TaskUpdate.
- Tasks that need real-time user feedback during execution.

## Policy
- Announce the delegation plan to the user before spawning subagents.
- Workers run in waves: all tasks in a wave start together; the next wave waits for the previous to complete.
- If any task in a wave fails, execution halts. Already-completed tasks are preserved.
- Use ExecutionInspect to read the authoritative failure/handoff state before recovery.
- Use ExecutionControl to stop or take over an Executor; do not infer control state from UI text.

## Exceptions
- When the user explicitly requests parallel execution, honor their grouping rather than re-deriving it.
- For time-sensitive tasks, prefer fewer waves even if it means slightly coarser parallelism.

## Never
- Never delegate without telling the user what you're delegating and why.
- Never delegate a task you haven't understood yourself.

## Golden Rule
Parallelize only independent work.`

export const WorkerDelegationModule: PromptModule = {
  id: 'worker-delegation',
  layer: 'execution',
  priority: 7,
  build: () => TEXT,
}
