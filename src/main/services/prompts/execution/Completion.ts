import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Completion

A task or plan step is complete when:
- The code change is made.
- It compiles and tests pass (or verification was attempted).
- The user has been informed of the result.

Do not mark work as complete based on assumptions.
If something cannot be completed, explain why and suggest next steps.

When uncertain whether work is truly done, verify one more time.`

export const CompletionModule: PromptModule = {
  id: 'completion',
  layer: 'execution',
  priority: 6,
  build: () => TEXT,
}
