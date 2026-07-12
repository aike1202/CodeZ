import { Tool } from '../Tool'
import { SubAgentManager } from '../../agent/SubAgentManager'

/**
 * 通用子智能体调度工具。
 * 主 Agent 调用此工具来 spawn 一个子智能体处理委派任务。
 * 实际执行由 AgentRunner 拦截（handleSubAgentRunnerSpawn），不走此 execute。
 *
 * 新增子智能体只需 SubAgentManager.register(...)，无需改此工具或 AgentRunner。
 */
export class SubAgentRunnerTool extends Tool {
  get name() {
    return 'SubAgentRunner'
  }

  get summary() {
    return 'Launch a subagent for complex multi-step tasks.'
  }

  get description() {
    const defs = SubAgentManager.listEnabledDefinitions()
    const typeLines =
      defs.length > 0
        ? defs.map((d) => `  - ${d.type}: ${d.description}`).join('\n')
        : '  (none registered)'
    return [
      'Launch a subagent to handle a delegated task. The subagent runs in its own message loop and returns a result to you.',
      'Use this to parallelize work, isolate context, or delegate specialized analysis.',
      '',
      'Available subagent types:',
      typeLines,
      '',
      'Guidelines:',
      '- Provide a self-contained `prompt` (or `task` field); the subagent does NOT see your conversation history.',
      '- `description` is a short label (max 60 chars) shown in the execution log.',
      '- Use `expectations.questions` to specify what the subagent MUST answer — it will self-check against this list.',
      '- Use `context` to share what you already know (natural language) so the subagent does not duplicate work.',
      '- Use `depth` to control exploration depth. Budgets are subagent-specific; Research uses quick (16 loops), normal (48 loops), exhaustive (96 loops), and defaults to 64 loops when omitted.',
      '- If an interrupted or failed call returns `resume_subagent_id`, preserve its type, prompt, context, scope, expectations, and depth and pass that ID back to this tool. This resumes the same subagent history; do not inspect or redo its work first.',
      '- Interrupted and failed results include a structured `handoff` for the parent Agent: reason, last progress, files examined/modified, recent tools, and whether resume is available. Use it before deciding to resume or take over the remaining work yourself.',
      '- The subagent result is returned as the tool output; it includes structuredOutput, qualitySummary, and filesExamined.'
    ].join('\n')
  }

  get parameters_schema() {
    const defs = SubAgentManager.listEnabledDefinitions()
    const types = defs.map((d) => d.type)
    return {
      type: 'object',
      properties: {
        subagent_type: {
          type: 'string',
          enum: types.length > 0 ? types : ['Research'],
          description: 'The type of subagent to launch.'
        },
        description: {
          type: 'string',
          description: 'A short (max 60 chars) description of the task, shown in the execution log.'
        },
        prompt: {
          type: 'string',
          description: 'The full task instructions for the subagent. Must be self-contained. Use this OR the `task` field.'
        },
        task: {
          type: 'string',
          description: 'The core question for the subagent to answer. Alias for `prompt` — you can use either one.'
        },
        context: {
          type: 'string',
          description: 'What you already know about the problem (natural language). Helps the subagent avoid redundant work. Example: "We are debugging auth. Token storage looks fine (read AuthService.ts:120-180). Need to trace how middleware validates tokens."'
        },
        expectations: {
          type: 'object',
          description: 'Acceptance criteria: specific questions the subagent must answer before returning.',
          properties: {
            questions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific sub-questions that must be answered. The subagent self-checks against this list before calling submit_result.'
            },
            outOfScope: {
              type: 'array',
              items: { type: 'string' },
              description: 'Explicitly out of scope — do not investigate these.'
            }
          }
        },
        scope: {
          type: 'object',
          description: 'Limit the subagent to specific directories or exclude glob patterns.',
          properties: {
            directories: {
              type: 'array',
              items: { type: 'string' },
              description: 'Limit exploration to these directories (relative to workspace root).'
            },
            excludeGlobs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Glob patterns to exclude (e.g. "**/*.test.ts", "**/node_modules/**").'
            }
          }
        },
        depth: {
          type: 'string',
          enum: ['quick', 'normal', 'exhaustive'],
          description: 'Exploration depth. Research uses quick=16 loops, normal=48 loops, exhaustive=96 loops; omitted depth uses the subagent default. Use quick for simple lookups and exhaustive for full audits.'
        },
        resume_subagent_id: {
          type: 'string',
          description: 'The resume_subagent_id returned by a resumable interrupted or failed SubAgentRunner call. Reuses that subagent\'s durable context instead of starting over.'
        }
      },
      required: ['subagent_type', 'description', 'prompt']
    }
  }

  async execute(): Promise<string> {
    // 实际执行逻辑在 AgentRunner 拦截中处理，不会执行到这里
    return JSON.stringify({
      ok: true,
      data: {
        status: 'intercepted',
        message: 'SubAgentRunner should be intercepted by AgentRunner.'
      }
    })
  }
}
