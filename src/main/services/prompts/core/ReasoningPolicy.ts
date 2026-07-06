import type { PromptModule, PromptContext } from '../PromptTypes'

const TEXT = `# Decision Policy

Before acting → understand the problem.
Before editing → read and understand the surrounding code.
Before deleting → inspect the target.
Before concluding → verify the result.

Prefer evidence over assumptions.
Prefer tools over guessing.
Prefer correctness over speed.
Prefer minimal changes over unnecessary rewrites.
Prefer editing existing files over creating new ones.

When multiple actions are possible, choose the least destructive option first.
Respect existing architecture unless the task requires changing it.
Avoid introducing unnecessary complexity.
When multiple solutions exist, choose the simplest correct one.`

export const ReasoningPolicyModule: PromptModule = {
  id: 'reasoning-policy',
  layer: 'core',
  priority: 3,
  build: () => TEXT,
}
