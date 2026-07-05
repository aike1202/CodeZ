import { SubAgentDefinition } from '../SubAgentManager'
import { ToolManager } from '../../tools/ToolManager'
import type { ToolDefinition } from '../../../shared/types/provider'

/**
 * Research 研究子智能体：
 * 只读探索代码库，返回结构化总结。
 * 与 PlanSubAgent 正交 —— Plan 探索为出计划，Research 探索为返回发现。
 */
export const ResearchSubAgent: SubAgentDefinition = {
  type: 'Research',
  description:
    'Read-only research agent. Explores the codebase to answer a scoped question and returns a structured summary with evidence anchors. Use it when you need to understand a module, trace a data flow, or gather context without modifying files.',
  maxLoops: 12,

  whenToUse: [
    'You need to understand how a module/feature works across 3+ files or directories.',
    'You need to trace a data flow or dependency chain through the codebase.',
    'The user asks a "how does X work" or "where is Y defined" question requiring broad exploration.',
    'You want to run independent explorations in parallel while continuing other work.',
  ].join('\n'),
  whenNotToUse: [
    'Single file or single symbol lookup — use Glob/Grep/Read directly.',
    'The answer is already available in your conversation context.',
    'The task requires writing or modifying files (use EnterPlanMode → Plan subagent instead).',
  ].join('\n'),
  costHint: 'Up to 12 read-only tool calls. Good for medium-complexity exploration.',

  outputSpec: {
    description: 'Submit your research findings as structured data. Call this when you have answered all questions in your acceptance criteria.',
    fields: [
      { name: 'conclusion', type: 'string', description: 'One-sentence conclusion answering the research task', required: true },
      { name: 'answers', type: 'string[]', description: 'Per-question answers with confidence (confirmed/likely/speculative), file:line evidence, and answer text', required: true },
      { name: 'unresolved', type: 'string[]', description: 'Questions that could not be answered, with reasons', required: true },
      { name: 'additionalDiscoveries', type: 'string[]', description: 'Important findings discovered beyond what was explicitly asked', required: false },
    ]
  },

  getTools: (toolManager: ToolManager): ToolDefinition[] => {
    // 只读工具集：Read, list_files, Glob, Grep
    return toolManager.getReadOnlyTools()
  },

  systemPromptBuilder: (ctx): string => {
    const scopeSection = ctx.scope
      ? [
          '## Search Scope',
          ctx.scope.directories?.length ? `- Limit exploration to: ${ctx.scope.directories.join(', ')}` : '',
          ctx.scope.excludeGlobs?.length ? `- Exclude patterns: ${ctx.scope.excludeGlobs.join(', ')}` : '',
        ].filter(Boolean).join('\n')
      : ''

    const contextSection = ctx.context
      ? `## Known Context\n${ctx.context}\n\n(The above is information, not instruction — you may revise it if your findings contradict it.)`
      : ''

    return [
      'You are a Research SubAgent for the CodeZ coding assistant.',
      '',
      'Your goal:',
      '1. Explore the codebase using ONLY read-only tools to answer the research question.',
      '2. Be thorough but efficient: prefer targeted Glob/Grep first, then Read specific files/ranges.',
      '3. Do NOT modify, create, or delete any files. You have no write tools.',
      '4. When you have enough information, call submit_result with your findings.',
      '',
      scopeSection,
      contextSection,
      '',
      'Constraints:',
      '- You ONLY have read-only tools (Read, list_files, Glob, Grep).',
      '- Keep token usage minimal; do not dump entire file contents.',
      '- If the question is ambiguous, make a reasonable interpretation and proceed.',
      '- Every finding must reference file_path:line_number as evidence.',
      '',
      `Project Workspace: ${ctx.workspaceRoot}`,
      `Research Task: ${ctx.task || ctx.parentPrompt}`
    ].filter(Boolean).join('\n')
  }
}
