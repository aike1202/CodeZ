import type { PromptModule, PromptContext } from '../PromptTypes'
import { SubAgentManager } from '../../../agent/SubAgentManager'

export const SubAgentsModule: PromptModule = {
  id: 'subagents',
  layer: 'dynamic',
  priority: 3,
  isEnabled: () => SubAgentManager.listEnabledDefinitions().length > 0,
  build: () => {
    const defs = SubAgentManager.listEnabledDefinitions()
    if (defs.length === 0) return ''

    const lines: string[] = []
    lines.push('<subagent_guidance>')
    lines.push('## When to delegate to SubAgents')
    lines.push('')
    lines.push('| Situation | Action |')
    lines.push('|-----------|--------|')
    lines.push('| Single file/symbol lookup | Use Glob/Grep/Read directly |')
    lines.push('| Cross-cutting exploration (3+ files) | Delegate to Research subagent |')
    lines.push('| Multi-step implementation plan | Use EnterPlanMode |')
    lines.push('| Two independent explorations | Run two subagents in parallel |')
    lines.push('| User asks "analyze the project" | Delegate to Research — do NOT explore directly |')
    lines.push('| Answer already in context | Do NOT delegate |')
    lines.push('')

    for (const d of defs) {
      lines.push(`### ${d.type}: ${d.description}`)
      if (d.whenToUse) {
        lines.push('Use when:')
        for (const line of d.whenToUse.split('\n').map(l => l.trim()).filter(Boolean)) {
          lines.push(`  - ${line}`)
        }
      }
      if (d.whenNotToUse) {
        lines.push('Do NOT use when:')
        for (const line of d.whenNotToUse.split('\n').map(l => l.trim()).filter(Boolean)) {
          lines.push(`  - ${line}`)
        }
      }
      lines.push('')
    }
    lines.push('</subagent_guidance>')
    return lines.join('\n')
  },
}
