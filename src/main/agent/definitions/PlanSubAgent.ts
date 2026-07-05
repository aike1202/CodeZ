import { SubAgentDefinition, SubAgentContext } from '../SubAgentManager'
import { ToolManager } from '../../tools/ToolManager'
import type { ToolDefinition } from '../../../shared/types/provider'

export const PlanSubAgent: SubAgentDefinition = {
  type: 'Plan',
  description: 'Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task.',
  maxLoops: 15,

  whenToUse: [
    'You need to design an implementation plan before writing code for a multi-file change.',
    'Multiple valid technical approaches exist and you want user approval on the strategy.',
    'The task requires architectural decisions affecting 3+ files.',
  ].join('\n'),
  whenNotToUse: [
    'Single-line fixes, typo corrections, or trivial changes.',
    'Pure research or exploration tasks (use Research subagent instead).',
    'The user explicitly said to skip planning.',
  ].join('\n'),
  costHint: 'Up to 15 tool calls including plan file writing. Plan subagent also triggers user approval UI.',

  getTools: (toolManager: ToolManager): ToolDefinition[] => {
    // Plan SubAgent 可用工具：所有只读工具 + WriteTool + ExitPlanModeTool
    const readOnly = toolManager.getReadOnlyTools()
    const writeTool = toolManager.getTool('Write')
    const exitTool = toolManager.getTool('ExitPlanMode')
    
    const additionalTools: ToolDefinition[] = []
    
    if (writeTool) {
      additionalTools.push({
        type: 'function',
        function: {
          name: writeTool.name,
          description: writeTool.description,
          parameters: writeTool.parameters_schema
        }
      })
    }
    
    if (exitTool) {
      additionalTools.push({
        type: 'function',
        function: {
          name: exitTool.name,
          description: exitTool.description,
          parameters: exitTool.parameters_schema
        }
      })
    }
    
    return [...readOnly, ...additionalTools]
  },
  
  systemPromptBuilder: (ctx: SubAgentContext): string => {
    return [
      'You are a Software Architect SubAgent operating in Plan Mode.',
      '',
      'Your goal:',
      '1. Thoroughly explore the codebase using read-only tools to understand the context of the user request.',
      '2. Design a structured implementation plan.',
      '3. Write the plan to a markdown file in the project workspace (e.g., .codez/plans/plan-name.md) using the Write tool.',
      '4. The plan file must include YAML frontmatter with title, description, and steps (following the CodeZ PlanStore format).',
      '5. Once the plan file is written, call ExitPlanMode to submit it for user approval.',
      '',
      'Plan format guidelines:',
      '- Each step should be clearly numbered (e.g., ## p0 Setup, ## p1 Component).',
      '- Each step should describe the goal, files to be modified, and acceptance criteria.',
      '- Keep step descriptions concise (50-150 chars).',
      '',
      'Constraints:',
      '- DO NOT use the Edit tool or run modifying bash commands.',
      '- You ONLY have access to read-only tools, Write (strictly for the plan file), and ExitPlanMode.',
      '',
      `Project Workspace: ${ctx.workspaceRoot}`,
      `Original Task Request: ${ctx.task || ctx.parentPrompt}`
    ].join('\n')
  }
}
