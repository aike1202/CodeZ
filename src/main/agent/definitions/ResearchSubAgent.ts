import { SubAgentDefinition } from '../SubAgentManager'
import { ToolManager } from '../../tools/ToolManager'
import { buildSharedToolUsePrompt } from '../../services/prompts/SubAgentPrompts'
import type { ToolDefinition } from '../../../shared/types/provider'

/**
 * Research 研究子智能体：
 * 只读探索代码库，返回 Markdown 研究报告 + 结构化元信息。
 * 与执行型 Worker 正交：Research 只返回发现，不创建计划、不写文件。
 */
export const ResearchSubAgent: SubAgentDefinition = {
  type: 'Research',
  description:
    'Read-only context-isolation agent for a scoped question whose answer is absent from the parent context and is expected to require broad reading across many files. It returns a concise evidence handoff so unnecessary raw exploration does not occupy the parent context.',
  maxLoops: 64,
  finalizationReserveLoops: 2,
  depthLoops: {
    quick: 16,
    normal: 48,
    exhaustive: 96,
  },

  whenToUse: [
    'Use Research only when ALL conditions are true:',
    'The answer is not already present in the conversation or parent Agent context.',
    'Answering reliably is expected to require broad exploration and reading many files or directories.',
    'The raw exploration would add unnecessary parent-context weight, while a concise evidence handoff is sufficient for the remaining task.',
  ].join('\n'),
  whenNotToUse: [
    'The answer is already available in conversation context, including content just read, written, or generated.',
    'A targeted search or a manageable number of direct reads can answer the question.',
    'You only want to verify your own recent work.',
    'The task requires writing or modifying files (use TaskGroup in the main agent instead).',
  ].join('\n'),
  costHint: 'Default: up to 64 loops with 2 reserved for the report. Depth budgets: quick 16, normal 48, exhaustive 96.',

  outputSpec: {
    description: 'Submit your research report as a Markdown document with a short metadata summary.',
    fields: [
      { name: 'report', type: 'string', description: 'Your full research report in Markdown format. Use headings, bullet lists, code blocks, and file_path:line links.', required: true },
      { name: 'conclusion', type: 'string', description: 'One-sentence conclusion answering the research task', required: true },
      { name: 'confidence', type: 'string', description: 'Overall confidence in your findings: high, medium, or low', required: true },
      { name: 'filesExamined', type: 'string[]', description: 'List of files actually read during research (relative paths)', required: false },
      { name: 'unresolvedCount', type: 'number', description: 'Number of acceptance criteria questions you could not answer', required: false },
    ]
  },

  validateStructuredOutput: (output) => {
    const requiredHeadings = ['# Research Handoff', '## Direct Answer', '## Key Findings']
    const missingHeading = requiredHeadings.find((heading) => !output.report.includes(heading))
    if (missingHeading) {
      return `Research report must include the heading "${missingHeading}".`
    }
    if (!/`[^`\n]+:\d+-\d+`/.test(output.report)) {
      return 'Research report must include at least one evidence anchor formatted as `file_path:start_line-end_line`.'
    }
    return undefined
  },

  getTools: (toolManager: ToolManager): ToolDefinition[] => {
    return toolManager.getReadOnlyTools()
  },

  systemPromptBuilder: async (ctx): Promise<string> => {
    const sharedPrompt = await buildSharedToolUsePrompt({
      workspaceRoot: ctx.workspaceRoot,
      modelId: ctx.modelOverride || ctx.apiConfig.model,
      modelDisplayName: ctx.modelOverride || ctx.apiConfig.model,
      contextWindowTokens: ctx.contextCapabilities?.contextWindowTokens ?? 1,
      sessionId: ctx.sessionId,
    })
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

    const researchPrompt = [
      'You are a Research SubAgent for the CodeZ coding assistant.',
      '',
      'Your goal:',
      '1. Explore the codebase using ONLY read-only tools to answer the research question.',
      '2. Follow the shared Investigation and Tool Policy for all discovery and reads.',
      '3. Do NOT modify, create, or delete any files. You have no write tools.',
      '4. When finished, call submit_result with your report AND metadata.',
      '',
      scopeSection,
      contextSection,
      '',
      '## Output Format',
      'Your submit_result call has two required parts:',
      '',
      '**report** (string, required): A concise Markdown handoff for the parent agent. Structure it like this:',
      '```',
      '# Research Handoff',
      '',
      '## Direct Answer',
      'Answer the research task directly.',
      '',
      '## Key Findings',
      '- Finding with evidence: `file_path:start_line-end_line` — what it shows and why it matters.',
      '',
      '## Relevant Components',
      'Only describe modules, configuration, scripts, interfaces, tests, data structures, or dependencies directly relevant to the task.',
      '',
      '## Priority References',
      '| Priority | File and lines | When the parent should re-read it |',
      '| --- | --- | --- |',
      '| required | `file_path:start_line-end_line` | Before implementing or verifying the related logic |',
      '',
      '## Constraints / Risks',
      'Include only known assumptions, boundaries, compatibility risks, or other facts that affect the conclusion.',
      '',
      '## Open Questions',
      'List only facts that could not be confirmed from the available evidence.',
      '```',
      '',
      '**conclusion** (string, required): ONE sentence answering the research question.',
      '',
      '**confidence** (string, required): "high" if all evidence is from source code, "medium" if some inference needed, "low" if mostly speculative.',
      '',
      '**filesExamined** (string[], optional): Paths of files you actually read.',
      '',
      '**unresolvedCount** (number, optional): How many acceptance criteria questions you could NOT answer.',
      '',
      'Constraints:',
      '- Keep the final report concise; tool reads must follow the shared policy.',
      '- Do NOT include source code excerpts. Return evidence anchors only.',
      '- Every material finding must reference `file_path:start_line-end_line` as evidence.',
      '- Keep Priority References to the 1-5 files or ranges the parent is most likely to need next.',
      '- Omit any optional heading that has no relevant content; do not invent frontend, backend, database, or other technology-specific sections.',
      '- If the question is ambiguous, make a reasonable interpretation and proceed.',
      '',
      `Project Workspace: ${ctx.workspaceRoot}`,
      `Research Task: ${ctx.task || ctx.parentPrompt}`
    ].filter(Boolean).join('\n')

    return [sharedPrompt, researchPrompt].join('\n\n')
  }
}
