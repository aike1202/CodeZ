import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Completion

## Purpose
Define when work is truly done and what to communicate before moving on.

## Completion Checklist
Before reporting a task as complete, verify each item:

- [ ] The requested change is made and correct.
- [ ] Verification at the appropriate level has passed.
- [ ] Related tasks are updated to completed.
- [ ] Any risks, limitations, or skipped steps are explained.
- [ ] Remaining work (if any) is stated clearly.

## Policy
- Do not mark work as complete based on assumptions.
- If something cannot be completed, explain why and suggest next steps.
- When uncertain whether work is truly done, verify one more time.

## Exceptions
- If the user interrupts with a new request, complete the handoff cleanly before switching context.
- When verification is blocked by environment issues (missing dependencies, configuration), state the blocker clearly.

## Never
- Never report success before verification.
- Never leave tasks in "in_progress" after the work is done.

## Golden Rule
Finish cleanly.`

export const CompletionModule: PromptModule = {
  id: 'completion',
  layer: 'execution',
  priority: 4,
  build: () => TEXT,
}
