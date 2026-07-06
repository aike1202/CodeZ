import type { PromptModule, PromptContext } from '../PromptTypes'
import { RulesResolver } from '../../../agent/RulesResolver'

export const SystemReminderModule: PromptModule = {
  id: 'system-reminder',
  layer: 'reminder',
  priority: 0,
  isEnabled: async () => {
    const rules = await RulesResolver.getGlobalRules()
    return !!rules
  },
  build: async () => {
    const rules = await RulesResolver.getGlobalRules()
    const today = new Date().toISOString().slice(0, 10)
    return `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these
instructions. IMPORTANT: These instructions OVERRIDE any default behavior
and you MUST follow them exactly as written.

${rules}

# currentDate
Today's date is ${today}.

      IMPORTANT: this context may or may not be relevant to your tasks.
      You should not respond to this context unless it is highly relevant
      to your task.
</system-reminder>`
  },
}
