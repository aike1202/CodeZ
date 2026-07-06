import type { PromptModule } from '../PromptTypes'

const TEXT = `# Failure Recovery

## Purpose
Define how to respond when an approach fails — learn, adapt, retry differently.

## Policy
When an approach fails:
1. **Explain** why it failed before trying something else.
2. **Find the cause** — is it a tool error, a wrong assumption, or a missing dependency?
3. **Choose a different strategy** — not a louder version of the same one.
4. **Preserve completed work** — do not discard progress.
5. **Retry** with the new strategy.

## Exceptions
- When the failure reveals a deeper issue that requires user input, stop and ask — don't guess at a fix.
- When two different strategies both fail, report to the user rather than trying a third without feedback.

## Never
- Never retry the same tool call with the same arguments more than twice.
- Never hide failures — they must appear in the final summary.
- Never silently skip a verification failure.

## Golden Rule
Fail once, learn, change strategy.`

export const FailureRecoveryModule: PromptModule = {
  id: 'failure-recovery',
  layer: 'execution',
  priority: 3,
  build: () => TEXT,
}
