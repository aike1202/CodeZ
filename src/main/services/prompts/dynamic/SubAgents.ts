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
      lines.push('After completing user-requested code, configuration, migration, or runtime behavior changes, you MUST invoke one fresh Reviewer in initial mode after primary verification and before reporting completion. Documentation-only and plan-only changes use at most one advisory initial review and never enter an automatic fix/review loop.')
      lines.push('Do not use Explore, your own inspection, or an implementation agent\'s self-check as a substitute for Reviewer.')
      lines.push('Give Reviewer a self-contained brief containing:')
      lines.push('1. Original user goal and a frozen, numbered acceptance-criteria list in expectations.questions. The Reviewer may not add completion criteria.')
      lines.push('2. Actual changes and implementation approach.')
      lines.push('3. Complete changed-file list for this request, clearly separated from unrelated pre-existing changes.')
      lines.push('4. Verification commands already run and their actual results.')
      lines.push('5. Known risks, unresolved items, and relevant plan or specification paths.')
      lines.push('Create a stable review_cycle_id for that bounded task or milestone and call review_mode="initial". PASS and PASS_WITH_RISKS are terminal; disclose risks from PASS_WITH_RISKS without launching another Reviewer.')
      lines.push('Treat BLOCKED findings as candidates, not automatic truth. Fix only findings that cite a frozen AC-N criterion and include a concrete location, expected/actual behavior, reproduction, repository evidence, P0/P1 severity, and high confidence. Batch all confirmed fixes before any follow-up.')
      lines.push('After confirmed blockers are fixed, resume the same completed Reviewer exactly once with review_mode="closure", the same review_cycle_id, its resume_subagent_id, and all previous_finding_ids. Closure review may only resolve or reopen those IDs and regressions directly caused by their fixes; it must not perform another full audit or add criteria.')
      lines.push('Closure is terminal even when it remains BLOCKED. Report unresolved blockers or request user/arbiter direction; never launch a third Reviewer or create a fresh review cycle for the same content.')
      lines.push('If a Reviewer is interrupted or fails for infrastructure reasons, resume that same subagent ID in the same mode. Infrastructure retries do not consume the closure review and must not create a fresh Reviewer.')
      lines.push('Skip this gate when no behavioral project files changed, such as pure question answering or read-only investigation.')
    }
    lines.push('For interrupted or failed runs, use the returned handoff and resume_subagent_id when continuity is useful. Do not repeat confirmed completed work.')
    lines.push('</subagent_guidance>')
    return lines.join('\n')
  },
}
