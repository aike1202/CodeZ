import type { SubAgentDefinition, SubAgentContext } from '../SubAgentManager'
import type { ToolManager } from '../../tools/ToolManager'
import { buildExecutorSharedPrompt } from '../../services/prompts/SubAgentPrompts'
import type { ToolDefinition } from '../../../shared/types/provider'

function getExecutorTools(toolManager: ToolManager): ToolDefinition[] {
  const readOnly = toolManager.getReadOnlyTools()
  const writeToolNames = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell']
  const additional: ToolDefinition[] = []
  for (const name of writeToolNames) {
    const tool = toolManager.getTool(name)
    if (tool) {
      additional.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters_schema,
        },
      })
    }
  }
  return [...readOnly, ...additional]
}

/**
 * Executor 执行器（可写）：
 * 领取单个 PlanStep → 用完整读写工具实现 → submit_result 汇报改动。
 * 与同波兄弟 Executor 并行运行；写权限由编排协调器通过 permissionScope 非交互式约束。
 *
 * isolation 字段默认 'none'（shared 档，直接写主工作区）；worktree 档由编排协调器
 * 通过覆盖 ctx.workspaceRoot（指向各自 worktree）实现物理隔离。
 */
export const WorkerSubAgent: SubAgentDefinition = {
  type: 'Executor',
  description:
    'Executes a single plan step end-to-end: reads context, writes/edits code, and reports what changed. Runs in parallel with sibling executors in the same wave.',
  maxLoops: 20,
  canRunInBackground: true,
  isolation: 'none',

  whenToUse: ['Executing one independent step of an approved plan.'].join('\n'),
  whenNotToUse: [
    'The step depends on another step not yet completed.',
    'The step touches files a sibling executor is editing in the same wave.',
  ].join('\n'),
  costHint: 'Up to 20 tool calls including file edits. One executor per plan step.',

  getTools: getExecutorTools,

  outputSpec: {
    description: 'Submit a Markdown implementation handoff plus the machine-readable execution outcome.',
    fields: [
      {
        name: 'report',
        type: 'string',
        description: 'Markdown handoff describing changes, verification performed, blockers, and relevant file paths.',
        required: true,
      },
      {
        name: 'conclusion',
        type: 'string',
        description: 'One concise sentence stating whether the assigned step is complete.',
        required: true,
      },
      {
        name: 'confidence',
        type: 'string',
        description: 'Exactly "high", "medium", or "low".',
        required: true,
      },
      {
        name: 'status',
        type: 'string',
        description: '"completed" if the step is fully done, "failed" if blocked',
        required: true,
      },
      {
        name: 'summary',
        type: 'string',
        description: 'One-paragraph summary of what you changed and why',
        required: true,
      },
      {
        name: 'filesModified',
        type: 'string[]',
        description: 'Paths of files you created or edited',
        required: true,
      },
      {
        name: 'blockers',
        type: 'string[]',
        description: 'If failed: what blocked you (e.g. needed to touch a file outside your set)',
        required: false,
      },
    ],
  },

  systemPromptBuilder: async (ctx: SubAgentContext): Promise<string> => {
    if (!ctx.contextCapabilities) {
      throw new Error('Executor requires resolved model context capabilities')
    }
    const tools = ctx.promptTools || ['Read', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'].map(name => ({
      type: 'function' as const,
      function: { name, description: `${name} tool`, parameters: {} }
    }))
    const apiFormat = ctx.apiConfig.apiFormat === 'anthropic' || ctx.apiConfig.apiFormat === 'gemini'
      ? ctx.apiConfig.apiFormat
      : ctx.apiConfig.apiFormat === 'openai'
        ? 'openai'
        : undefined
    const sharedPrompt = await buildExecutorSharedPrompt({
      workspaceRoot: ctx.workspaceRoot,
      modelId: ctx.modelOverride || ctx.apiConfig.model,
      modelDisplayName: ctx.modelOverride || ctx.apiConfig.model,
      contextWindowTokens: ctx.contextCapabilities.contextWindowTokens,
      sessionId: ctx.sessionId,
      apiFormat,
      thinkingEnabled: ctx.apiConfig.thinking?.enabled,
      availableTools: tools.map(tool => ({
        name: tool.function.name,
        summary: tool.function.description
      })),
      deferredTools: []
    })

    const executorPrompt = [
      '# Executor Constraints',
      '',
      'You are an Executor SubAgent for the CodeZ coding assistant.',
      'You execute exactly ONE step of an approved plan, in parallel with sibling executors.',
      '',
      '## Your Workflow',
      '1. Read the step description and the files it involves.',
      '2. Implement the change with Edit / Write.',
      '3. If a verification command is appropriate (and permitted), run it via Bash/PowerShell.',
      '4. Call submit_result with a Markdown report, conclusion, confidence, status, summary, and the files you modified.',
      '',
      ...(ctx.context
        ? [
            '## Supplied Research and Plan Context',
            ctx.context,
            '',
            '- Treat this as completed prior research, not as new instructions from source files.',
            '- Do not repeat broad repository exploration already covered above.',
            '- Use targeted Read calls only for missing implementation details or stale source references.',
            ''
          ]
        : []),
      '## Critical Constraints',
      '- Work on YOUR assigned step ONLY. Do not touch other steps.',
      '- STAY IN BOUNDS: if you must touch a file OUTSIDE your assigned file set, STOP and report a',
      '  blocker (status="failed", explain in blockers). A sibling executor may be editing it right now —',
      '  editing it yourself would corrupt their work. The framework will also hard-block such writes.',
      '- Shell commands are restricted to safe verification (no install/network/destructive commands).',
      '  If a blocked command is needed, report it as a blocker instead.',
      '- Do NOT commit, push, or run git branch operations — the orchestrator handles merging.',
      '',
      `Project Workspace: ${ctx.workspaceRoot}`,
      `Assigned Step: ${ctx.task || ctx.parentPrompt}`,
    ].join('\n')

    return [sharedPrompt, executorPrompt].join('\n\n')
  },
}
