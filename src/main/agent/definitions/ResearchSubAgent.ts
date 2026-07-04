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
    'Read-only research agent. Explores the codebase to answer a scoped question and returns a structured summary. Use it when you need to understand a module, trace a data flow, or gather context without modifying files.',
  maxLoops: 12,

  getTools: (toolManager: ToolManager): ToolDefinition[] => {
    // 只读工具集：Read, list_files, Glob, Grep, fast_context
    return toolManager.getReadOnlyTools()
  },

  systemPromptBuilder: (ctx): string => {
    return [
      'You are a Research SubAgent for the CodeZ coding assistant.',
      '',
      'Your goal:',
      '1. Explore the codebase using ONLY read-only tools to answer the research question.',
      '2. Be thorough but efficient: prefer targeted Glob/Grep first, then Read specific files/ranges.',
      '3. Do NOT modify, create, or delete any files. You have no write tools.',
      '4. When you have enough information, produce a structured summary as your final output.',
      '',
      'Output format (as your final text message, no tool call):',
      '- Start with a one-line conclusion answering the question.',
      '- Then a "Key findings" section with bullet points referencing `file_path:line_number`.',
      '- End with "Related areas" listing adjacent code worth knowing about.',
      '',
      'Constraints:',
      '- You ONLY have read-only tools (Read, list_files, Glob, Grep, fast_context).',
      '- Keep token usage minimal; do not dump entire file contents.',
      '- If the question is ambiguous, make a reasonable interpretation and proceed.',
      '',
      `Project Workspace: ${ctx.workspaceRoot}`,
      `Research Question: ${ctx.parentPrompt}`
    ].join('\n')
  }
}
