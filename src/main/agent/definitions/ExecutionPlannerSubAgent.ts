import { SubAgentDefinition, SubAgentContext } from '../SubAgentManager'
import type { ToolManager } from '../../tools/ToolManager'
import { buildSharedToolUsePrompt } from '../../services/prompts/SubAgentPrompts'
import type { ToolDefinition } from '../../../shared/types/provider'

/**
 * ExecutionPlanner 分组规划器（只读）：
 * 读批准的 Plan 全部步骤 → 分析文件依赖 + 逻辑依赖 → 输出并行执行波次
 * （waves）+ 隔离建议（isolation）+ 一句话理由（rationale）。
 *
 * 与 Plan / Explore 正交：Plan 探索为出计划，Explore 探索为返回发现，
 * ExecutionPlanner 分析已批准计划为出并行编排方案。
 */
export const ExecutionPlannerSubAgent: SubAgentDefinition = {
  type: 'ExecutionPlanner',
  description:
    'Analyzes an approved plan and groups its steps into parallel execution waves based on file and logical dependencies. Read-only.',
  maxLoops: 8,

  whenToUse: [
    'A plan is approved and the user wants to execute its steps in parallel.',
    'You need to determine which plan steps can safely run concurrently.',
  ].join('\n'),
  whenNotToUse: [
    'The plan has only 1-2 steps (parallel overhead not worth it).',
    'Steps are strictly sequential (each depends on the previous).',
  ].join('\n'),
  costHint:
    'Up to 8 read-only tool calls. Reads the plan and spot-checks files to confirm independence.',

  getTools: (toolManager: ToolManager): ToolDefinition[] => {
    return toolManager.getReadOnlyTools()
  },

  outputSpec: {
    description:
      'Submit the execution grouping: waves of parallelizable step IDs plus an isolation recommendation.',
    fields: [
      {
        name: 'waves',
        type: 'string[]',
        description:
          'Ordered waves. Each entry is a JSON string like {"index":0,"stepIds":["p1","p2"]}. Steps in the same wave run in parallel; waves run in order.',
        required: true,
      },
      {
        name: 'isolation',
        type: 'string',
        description:
          '"shared" if steps in every wave touch disjoint files, "worktree" if any risk of write collision',
        required: true,
      },
      {
        name: 'rationale',
        type: 'string',
        description: 'One sentence explaining the grouping decision',
        required: true,
      },
    ],
  },

  systemPromptBuilder: async (ctx: SubAgentContext): Promise<string> => {
    const tools = ctx.promptTools || ['Read', 'list_files', 'Glob', 'Grep'].map(name => ({
      type: 'function' as const,
      function: { name, description: `${name} tool`, parameters: {} }
    }))
    const sharedPrompt = await buildSharedToolUsePrompt({
      workspaceRoot: ctx.workspaceRoot,
      modelId: ctx.modelOverride || ctx.apiConfig.model,
      modelDisplayName: ctx.modelOverride || ctx.apiConfig.model,
      contextWindowTokens: ctx.contextCapabilities?.contextWindowTokens ?? 1,
      sessionId: ctx.sessionId,
      availableTools: tools.map(tool => ({
        name: tool.function.name,
        summary: tool.function.description
      })),
      deferredTools: []
    })
    const plannerPrompt = [
      'You are an ExecutionPlanner SubAgent for the CodeZ coding assistant.',
      '',
      'Your goal: read the approved plan and group its steps into parallel execution WAVES.',
      'Steps in the same wave run concurrently; waves run in order (a barrier between waves).',
      '',
      '## Grouping Rules',
      '1. Two steps may share a wave ONLY IF they are independent: their `files` do NOT overlap',
      '   AND there is no logical dependency (e.g. B uses an interface A creates → B must be in a LATER wave).',
      '2. If B needs A\'s output, put A in an earlier wave than B.',
      '3. Prefer fewer waves / more parallelism, but NEVER at the cost of correctness.',
      '4. Read the actual step descriptions and follow the shared tool policy to confirm independence —',
      '   do NOT blindly trust the declared `files` field.',
      '5. Isolation recommendation:',
      '   - Recommend "worktree" if you are unsure files are truly disjoint, or steps touch shared',
      '     config/index files.',
      '   - Recommend "shared" only if you are confident each wave writes fully independent files.',
      '6. RESUME: steps already marked `completed` MUST NOT appear in any wave.',
      '',
      '## Output Format',
      'Call submit_result with:',
      '- **waves** (string[]): each entry a JSON string, e.g. \'{"index":0,"stepIds":["p0"]}\'.',
      '  Waves must be ordered by index starting at 0. Every non-completed step must appear in exactly one wave.',
      '- **isolation** (string): "shared" or "worktree".',
      '- **rationale** (string): one sentence explaining the grouping.',
      '',
      'Constraints:',
      '- You have ONLY read-only tools. Do NOT modify anything.',
      '- Keep the final rationale concise; tool reads must follow the shared policy.',
      '',
      `Project Workspace: ${ctx.workspaceRoot}`,
      `Task: ${ctx.task || ctx.parentPrompt}`,
    ].join('\n')

    return [sharedPrompt, plannerPrompt].join('\n\n')
  },
}
