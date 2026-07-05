// src/main/services/prompts/sections/SubAgents.ts
import { SubAgentManager } from '../../../agent/SubAgentManager'

export function buildSubAgentGuidance(): string {
  const defs = SubAgentManager.listDefinitions()
  if (defs.length === 0) return ''

  const lines: string[] = []
  lines.push('<delegation_guidance>')
  lines.push('## When to Delegate to SubAgents via the Task Tool')
  lines.push('')
  lines.push('Delegating complex work to specialized SubAgents is MORE EFFICIENT than doing everything yourself because each SubAgent has:')
  lines.push('- An isolated context window (does not consume your token budget)')
  lines.push('- A focused tool set optimized for its task')
  lines.push('- A structured output format with evidence anchors and quality metadata')
  lines.push('')

  // Decision table
  lines.push('### Quick Decision Table')
  lines.push('| Situation | Action |')
  lines.push('|-----------|--------|')
  lines.push('| Single file/symbol lookup | Use Glob/Grep/Read directly — faster and cheaper |')
  lines.push('| Cross-cutting exploration (3+ files/dirs) | Delegate to Research subagent |')
  lines.push('| Multi-step implementation plan needed | Use EnterPlanMode (→ Plan subagent) |')
  lines.push('| Two fully independent explorations | Run two subagents in parallel via Task tool |')
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

  // How to write a good prompt
  lines.push('### How to Write a Good Task Prompt')
  lines.push('1. **State the core question** — one sentence describing what you need to know (use the `prompt` or `task` field).')
  lines.push('2. **Include acceptance criteria** — use `expectations.questions` to list specific sub-questions that must be answered.')
  lines.push('3. **Provide known context** — use the `context` field to share what you already know (natural language, not file lists).')
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
  lines.push('**Important:** Delegating is cheaper than doing it yourself. If unsure, delegate — the subagent returns structured evidence you can act on immediately.')
  lines.push('</delegation_guidance>')
  return lines.join('\n')
}
