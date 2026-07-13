import type { PromptModule } from '../PromptTypes'

const TEXT = `# Failure recovery

When an action fails, read the error, identify whether the cause is bad input, a wrong assumption, or an unavailable dependency, and make a focused correction. Preserve completed work. Report a genuine blocker instead of cycling through equivalent retries.`

export const FailureRecoveryModule: PromptModule = {
  id: 'failure-recovery',
  layer: 'execution',
  priority: 3,
  build: () => TEXT,
}
