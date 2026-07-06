import type { PromptModule, PromptContext } from '../PromptTypes'
import { RulesResolver } from '../../../agent/RulesResolver'

export const UserRulesModule: PromptModule = {
  id: 'user-rules',
  layer: 'dynamic',
  priority: 2,
  isEnabled: async () => {
    const rules = await RulesResolver.getGlobalRules()
    return !!rules
  },
  build: async () => {
    const rules = await RulesResolver.getGlobalRules()
    return `<user_rules>\n${rules}\n</user_rules>`
  },
}
