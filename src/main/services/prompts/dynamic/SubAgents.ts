import type { PromptModule, PromptContext } from '../PromptTypes'
import { SubAgentManager } from '../../../agent/SubAgentManager'

export const SubAgentsModule: PromptModule = {
  id: 'subagents',
  layer: 'dynamic',
  priority: 3,
  isEnabled: (ctx: PromptContext) => {
    const exposedTools = [
      ...(ctx.availableTools || []),
      ...(ctx.deferredTools || []),
    ]
    const hasTool = (
      ctx.availableTools === undefined && ctx.deferredTools === undefined
    ) || exposedTools.some(tool =>
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

    if (defs.some(def => def.type === 'Reviewer')) {
      lines.push('## Independent review gate')
      lines.push('After completing any user-requested implementation that changed project files, you MUST invoke Reviewer after your primary verification and before reporting completion. This applies whether the files were changed by you, Executor, or another workflow.')
      lines.push('Do not use Explore, your own inspection, or an implementation agent\'s self-check as a substitute for Reviewer.')
      lines.push('Give Reviewer a self-contained brief containing:')
      lines.push('1. Original user goal and acceptance criteria.')
      lines.push('2. Actual changes and implementation approach.')
      lines.push('3. Complete changed-file list for this request, clearly separated from unrelated pre-existing changes.')
      lines.push('4. Verification commands already run and their actual results.')
      lines.push('5. Known risks, unresolved items, and relevant plan or specification paths.')
      lines.push('On FAIL, fix the findings and launch Reviewer again with the original brief, previous findings, and the new corrections; repeat until PASS. On PARTIAL, try to remove the stated limitation, otherwise disclose the unverified items rather than claiming full completion.')
      lines.push('Skip this gate only when no project files changed, such as pure question answering or read-only investigation.')
    }
    lines.push('For interrupted or failed runs, use the returned handoff and resume_subagent_id when continuity is useful. Do not repeat confirmed completed work.')
    lines.push('</subagent_guidance>')
    return lines.join('\n')
  },
}
