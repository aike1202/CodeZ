// src/main/services/prompts/sections/SubAgents.ts
import { SubAgentManager } from '../../../agent/SubAgentManager'

export function buildSubAgentGuidance(): string {
  const defs = SubAgentManager.listDefinitions()
  if (defs.length === 0) return ''

  const lines: string[] = []
  lines.push('<delegation_guidance>')
  lines.push('## When to Delegate to SubAgents via the Task Tool')
  lines.push('')
  lines.push('**CRITICAL:** You have access to specialized subagents via the Task tool. For any exploration that spans 3+ files or directories, you MUST delegate to a subagent rather than searching directly. Direct Glob/Grep/Read calls pollute your context window; subagents are isolated and return structured evidence you can act on immediately.')
  lines.push('')

  // Anti-patterns — direct instructions
  lines.push('### ANTI-PATTERNS: What NOT to do')
  lines.push('- Do NOT use fast_context or Read on multiple directories to "explore" a project — delegate to Research instead.')
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
  lines.push('| Two fully independent explorations | Run two subagents in parallel via Task tool |')
  lines.push('| User asks "analyze the project" or similar | Delegate to Research — NEVER use fast_context for this |')
  lines.push('| Answer already in conversation context | Do NOT delegate — use what you already know |')
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
  lines.push('  → fast_context(["package.json", "src", "README.md", ...])  ← pollutes context')
  lines.push('  → Read multiple files directly  ← more context pollution')
  lines.push('')
  lines.push('RIGHT approach:')
  lines.push('  → Task({ subagent_type: "Research", description: "Analyze project structure",')
  lines.push('          prompt: "Analyze the codebase architecture: directory layout, key modules,')
  lines.push('            their responsibilities, and how they connect.",')
  lines.push('          depth: "normal" })')
  lines.push('  → Summarize the subagent result for the user')
  lines.push('')

  // How to write a good prompt
  lines.push('### How to Write a Good Task Prompt')
  lines.push('1. **State the core question** — one sentence describing what you need to know.')
  lines.push('2. **Include acceptance criteria** — use `expectations.questions` to list specific sub-questions.')
  lines.push('3. **Provide known context** — use the `context` field to share what you already know.')
  lines.push('4. **Set explicit scope** — use `expectations.outOfScope` to declare what NOT to investigate.')
  lines.push('5. **Choose the right depth** — `quick` for simple lookups, `normal` for tracing, `exhaustive` for full audits.')
  lines.push('')

  // How to read results
  lines.push('### How to Read SubAgent Results')
  lines.push('- Check `qualitySummary.coverage` — below 0.5 means re-delegate or investigate yourself.')
  lines.push('- Check `qualitySummary.confirmedRatio` — below 0.3 means most findings need verification.')
  lines.push('- Read `unresolved` items first — these are the known unknowns.')
  lines.push('- Trust `confirmed` answers; spot-check `likely` answers; verify `speculative` ones yourself.')
  lines.push('- Use `filesExamined` to see what was actually read — spot-check key files if unsure.')
  lines.push('')
  lines.push('**Remember:** Delegating preserves YOUR context for reasoning about results. Direct exploration burns YOUR tokens. Always delegate broad exploration.')
  lines.push('</delegation_guidance>')
  return lines.join('\n')
}
