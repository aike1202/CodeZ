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
    const hasResearch = defs.some((def) => def.type === 'Research')

    const lines: string[] = []
    lines.push('<subagent_guidance>')
    lines.push('## When to delegate to SubAgents')
    lines.push('')
    lines.push('| Situation | Action |')
    lines.push('|-----------|--------|')
    lines.push('| Single file/symbol lookup | Use Glob/Grep/Read directly |')
    if (hasResearch) {
      lines.push('| Manageable cross-file exploration | Explore directly with Glob/Grep/Read |')
      lines.push('| Unknown answer requiring broad reading whose raw findings need not remain in parent context | Consider Research after checking all eligibility conditions below |')
    }
    lines.push('| Multi-step implementation | Create a TaskGroup, then use DelegateTasks for independent tasks |')
    if (hasResearch) {
      lines.push('| User asks "analyze the project" | Identify specific unknown questions, then apply the same Research eligibility conditions |')
    }
    lines.push('| Answer already in context | Do NOT delegate |')
    lines.push('')
    if (hasResearch) {
      lines.push('Research is a context-isolation mechanism. Use it only when ALL three conditions are true:')
      lines.push('1. The needed answer does not exist in the conversation or parent Agent context.')
      lines.push('2. Determining the answer reliably is expected to require broad exploration and reading many files.')
      lines.push('3. Keeping those raw file contents in the parent context would be unnecessary; a concise evidence handoff is enough for the remaining work.')
      lines.push('File count alone is never a trigger. If any condition is false or uncertain, investigate directly in the parent Agent.')
      lines.push('- Never delegate content you just read, wrote, or generated.')
      lines.push('- Never delegate merely to validate your own recent work; use targeted verification tools directly.')
      lines.push('- When delegating, ask one bounded, self-contained question and include known context to prevent duplicate reading.')
      lines.push('- The parent Agent remains responsible for integrating the findings and completing the user request.')
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
