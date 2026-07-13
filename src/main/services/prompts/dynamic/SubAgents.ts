import type { PromptModule, PromptContext } from '../PromptTypes'
import { SubAgentManager } from '../../../agent/SubAgentManager'

export const SubAgentsModule: PromptModule = {
  id: 'subagents',
  layer: 'dynamic',
  priority: 3,
  isEnabled: (ctx: PromptContext) => {
    const hasTool = !ctx.availableTools || ctx.availableTools.some(tool =>
      tool.name === 'SubAgentRunner' || tool.name === 'DelegateTasks')
    return hasTool && SubAgentManager.listEnabledDefinitions().length > 0
  },
  build: () => {
    const defs = SubAgentManager.listEnabledDefinitions()
    if (defs.length === 0) return ''

    const lines: string[] = []
    lines.push('<subagent_guidance>')
    lines.push('Available specialists:')

    for (const d of defs) {
      lines.push(`### ${d.type}: ${d.description}`)
      if (d.whenToUse) lines.push(`Use when: ${d.whenToUse.split('\n').map(l => l.trim()).filter(Boolean).join(' ')}`)
      if (d.whenNotToUse) lines.push(`Avoid when: ${d.whenNotToUse.split('\n').map(l => l.trim()).filter(Boolean).join(' ')}`)
    }
    lines.push('For interrupted or failed runs, use the returned handoff and resume_subagent_id when continuity is useful. Do not repeat confirmed completed work.')
    lines.push('</subagent_guidance>')
    return lines.join('\n')
  },
}
