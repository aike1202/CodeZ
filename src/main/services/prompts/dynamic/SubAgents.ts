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
    const hasExplore = defs.some((def) => def.type === 'Explore')

    const lines: string[] = []
    lines.push('<subagent_guidance>')
    lines.push('## When to delegate to SubAgents')
    lines.push('')
    lines.push('| Situation | Action |')
    lines.push('|-----------|--------|')
    lines.push('| Single file/symbol lookup | Use Glob/Grep/Read directly |')
    if (hasExplore) {
      lines.push('| Broad codebase exploration or deep research | Use Explore when direct search is insufficient |')
    }
    lines.push('| Multi-step implementation | Create a TaskGroup, then use DelegateTasks for independent tasks |')
    lines.push('| Answer already in context | Do NOT delegate |')
    lines.push('')
    if (hasExplore) {
      lines.push('Explore is a fast, read-only codebase search specialist:')
      lines.push('- Prefer direct Glob, Grep, and Read calls for simple or directed lookups.')
      lines.push('- Use Explore only after a simple directed search is insufficient, or when the task clearly needs more than a few dependent queries.')
      lines.push('- Give Explore one self-contained question and include relevant known context so it does not repeat work.')
      lines.push('- Choose quick, normal, or exhaustive depth to match the requested search breadth.')
      lines.push('- Explore returns a concise plain-text report. The parent Agent remains responsible for interpreting it and completing the user request.')
      lines.push('')
    }
    lines.push('## Interrupted SubAgent handoff')
    lines.push('')
    lines.push('- On an interrupted or failed SubAgentRunner result, read `data.handoff` before taking another action.')
    lines.push('- The handoff is the bridge to the child run: it contains the reason, last progress, files examined or modified, recent tools, and whether the original child context can resume.')
    lines.push('- Choose based on remaining work: resume with the exact `resume_subagent_id` when child continuity is valuable, or take over in the parent when the handoff is sufficient.')
    lines.push('- Never repeat completed work. Treat `filesModified` as confirmed changes. Inspect `filesPossiblyModified` and the workspace diff/status before editing whenever side effects may have been interrupted or `workspaceMayHaveUntrackedChanges` is true.')
    lines.push('- Do not ask the user to reconstruct SubAgent context that is already present in the handoff.')
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
