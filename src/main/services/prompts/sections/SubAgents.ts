// src/main/services/prompts/sections/SubAgents.ts
import { SubAgentManager } from '../../../agent/SubAgentManager'

export function buildSubAgentGuidance(): string {
  const defs = SubAgentManager.listEnabledDefinitions()
  if (defs.length === 0) return ''

  const lines: string[] = []
  lines.push('<delegation_guidance>')
  lines.push('## When to Delegate to SubAgents via the SubAgentRunner Tool')
  lines.push('')
  lines.push('**CRITICAL:** You have access to specialized subagents via the SubAgentRunner tool. For any exploration that spans 3+ files or directories, you MUST delegate to a subagent rather than searching directly. Direct Glob/Grep/Read calls pollute your context window; subagents are isolated and return structured evidence you can act on immediately.')
  lines.push('')

  // Anti-patterns — direct instructions
  lines.push('### ANTI-PATTERNS: What NOT to do')
  lines.push('- Do NOT chain 3+ Glob + Grep + Read calls to trace a data flow yourself — delegate to Research.')
  lines.push('- Do NOT chain 3+ Glob + Grep + Read calls to trace a data flow yourself — delegate to Research.')
  lines.push('- Do NOT dump directory trees or file contents into your context for broad questions — Research returns a focused summary.')
  lines.push('')

  // Decision table
  lines.push('### Quick Decision Table')
  lines.push('| Situation | Action |')
  lines.push('|-----------|--------|')
  lines.push('| Single file/symbol lookup | Use Glob/Grep/Read directly |')
  lines.push('| Cross-cutting exploration (3+ files/dirs) | **MUST** delegate to Research subagent |')
  lines.push('| Multi-step implementation plan needed | Use EnterPlanMode (→ Plan subagent) |')
  lines.push('| Two fully independent explorations | Run two subagents in parallel via SubAgentRunner tool |')
  lines.push('| User asks "analyze the project" or similar | Delegate to Research — do NOT directly explore with Glob/Grep/Read |')
  lines.push('| Answer already in conversation context | Do NOT delegate — use what you already know |')
  lines.push('')

  // Parallel plan execution guidance
  lines.push('### Parallel Plan Execution (ExecutePlanParallel tool)')
  lines.push('When an approved plan is in "executing" status and its steps are largely independent, you can execute them in parallel:')
  lines.push('1. Delegate to the **ExecutionPlanner** subagent to analyze step dependencies and produce a wave grouping (which steps can run concurrently) plus an isolation recommendation ("shared" or "worktree").')
  lines.push('2. Call the **ExecutePlanParallel** tool with `planSlug`, the planner\'s `grouping` (waves + isolation + rationale), and the final `isolation`. Each wave runs its steps in parallel via Worker subagents; waves run in order; execution halts on the first wave with a failure.')
  lines.push('3. If the returned report has status "halted", report the failed step(s) to the user. After the user confirms a fix, call ExecutePlanParallel again — already-completed steps are skipped automatically (the planner reads step status).')
  lines.push('- Prefer "worktree" isolation when steps might touch shared files; "shared" only when each wave writes fully disjoint files.')
  lines.push('- Do NOT use parallel execution for plans with 1-2 steps or strictly sequential steps.')
  lines.push('')

  // Parallel task delegation guidance
  lines.push('### Parallel Task Delegation (DelegateTasks tool)')
  lines.push('When you have created lightweight Tasks (TaskCreate) and several are independent, delegate them to parallel Worker subagents:')
  lines.push('1. Decide the wave grouping yourself: tasks that can run independently go in the same wave; a task that depends on another goes in a later wave.')
  lines.push('2. NEVER put two tasks that touch the same files in the same wave — "shared" isolation will reject them; "worktree" may cause merge conflicts.')
  lines.push('3. Call **DelegateTasks** with `waves: [{ index, taskIds }]`, optional `isolation` (default "worktree"), and a one-line `rationale`.')
  lines.push('4. If the returned report has status "halted", fix the failed task(s) and call DelegateTasks again — already-completed tasks are skipped automatically.')
  lines.push('- This runs WITHOUT a Plan — Tasks are session-only and lightweight. Use it for medium multi-step work that does not need a reviewed plan.')
  lines.push('')

  // Per-type guidance
  for (const d of defs) {
    lines.push(`### ${d.type} SubAgent`)
    lines.push(`**Purpose:** ${d.description}`)
    lines.push('')

    if (d.whenToUse) {
      lines.push('**Use when:**')
      for (const line of d.whenToUse.split('\n').map(l => l.trim()).filter(Boolean)) {
        lines.push(`- ${line}`)
      }
    }

    if (d.whenNotToUse) {
      lines.push('')
      lines.push('**Do NOT use when:**')
      for (const line of d.whenNotToUse.split('\n').map(l => l.trim()).filter(Boolean)) {
        lines.push(`- ${line}`)
      }
    }

    if (d.costHint) {
      lines.push('')
      lines.push(`**Cost:** ${d.costHint}`)
    }
    lines.push('')
  }

  // Example
  lines.push('### Concrete Example')
  lines.push('')
  lines.push('User asks: "分析整个项目"')
  lines.push('')
  lines.push('WRONG approach:')
  lines.push('  → Glob + Grep + Read across multiple directories  ← pollutes context')
  lines.push('  → Read multiple files directly  ← more context pollution')
  lines.push('')
  lines.push('RIGHT approach:')
  lines.push('  → SubAgentRunner({ subagent_type: "Research", description: "Analyze project structure",')
  lines.push('          prompt: "Analyze the codebase architecture: directory layout, key modules,')
  lines.push('            their responsibilities, and how they connect.",')
  lines.push('          depth: "normal" })')
  lines.push('  → Summarize the subagent result for the user')
  lines.push('')

  // How to write a good prompt
  lines.push('### How to Write a Good SubAgentRunner Prompt')
  lines.push('1. **State the core question** — one sentence describing what you need to know.')
  lines.push('2. **Include acceptance criteria** — use `expectations.questions` to list specific sub-questions.')
  lines.push('3. **Provide known context** — use the `context` field to share what you already know.')
  lines.push('4. **Set explicit scope** — use `expectations.outOfScope` to declare what NOT to investigate.')
  lines.push('5. **Choose the right depth** — `quick` for simple lookups, `normal` for tracing, `exhaustive` for full audits.')
  lines.push('')

  // How to read results
  lines.push('### How to Read SubAgent Results')
  lines.push('- Check `qualitySummary.coverage` — below 0.5 means re-delegate or investigate yourself.')
  lines.push('- Check `qualitySummary.confidence` — "low" means most findings need verification. "high" means well-evidenced.')
  lines.push('- Check `qualitySummary.unresolvedCount` — above 0 means some questions were not answered.')
  lines.push('- Trust `confirmed` answers; spot-check `likely` answers; verify `speculative` ones yourself.')
  lines.push('- Use `filesExamined` to see what was actually read — spot-check key files if unsure.')
  lines.push('')
  lines.push('**Remember:** Delegating preserves YOUR context for reasoning about results. Direct exploration burns YOUR tokens. Always delegate broad exploration.')
  lines.push('</delegation_guidance>')
  return lines.join('\n')
}
