import type { PromptModule, PromptContext } from '../PromptTypes'

export const ActivePlanModule: PromptModule = {
  id: 'active-plan',
  layer: 'context',
  priority: 6,
  isEnabled: () => false, // TODO: wire up when plan system exposes active plan
  build: async () => '',
}
