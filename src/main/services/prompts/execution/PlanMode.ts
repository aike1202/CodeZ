import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Plan Mode

Planning is appropriate when:
- Architecture may change.
- Multiple valid approaches exist.
- The implementation spans many files.
- The work has significant risk.

If you have the EnterPlanMode tool, use it to suggest plan mode to the user.
Do not write the plan yourself when EnterPlanMode is available.

When an active plan exists (injected as <active_plan>):
- Follow steps in order. Use UpdatePlanStep to track progress.
- Only ONE step in_progress at a time.
- When all steps done, inform user and wait for confirmation.
- If the user raises a new requirement: judge whether it belongs to the current
  plan (adjust steps) or is new (suggest a new plan).

For plans in "executing" status with independent steps, use ExecutePlanParallel
to run them via Worker subagents in waves.`

export const PlanModeModule: PromptModule = {
  id: 'plan-mode',
  layer: 'execution',
  priority: 4,
  build: () => TEXT,
}
